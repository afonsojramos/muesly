//! Filesystem confinement and cross-process serialization for model mutations.
//!
//! The UI and the evaluator can run separate muesly processes against the same
//! app-data model directory. Every download, repair, cancellation cleanup, and
//! deletion must therefore take the same provider/model lock before touching
//! artifact paths. Lock files are retained and use an OS advisory lock, so a
//! crashed process releases ownership without an unsafe stale-lock takeover.

use std::ffi::OsStr;
use std::fs::{File, Metadata, OpenOptions, TryLockError};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};

const LOCKS_DIRECTORY: &str = ".muesly-model-mutation-locks";

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};

#[cfg(unix)]
const NO_FOLLOW_FLAGS: i32 = libc::O_NOFOLLOW | libc::O_CLOEXEC;
#[cfg(unix)]
const DIRECTORY_NO_FOLLOW_FLAGS: i32 = libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_DIRECTORY;
#[cfg(windows)]
const NO_FOLLOW_FLAGS: u32 = 0x0020_0000; // FILE_FLAG_OPEN_REPARSE_POINT
#[cfg(windows)]
const DIRECTORY_NO_FOLLOW_FLAGS: u32 = 0x0020_0000 | 0x0200_0000; // + FILE_FLAG_BACKUP_SEMANTICS
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    first: u64,
    second: u64,
    links: u64,
}

impl FileIdentity {
    fn same_object(self, other: Self) -> bool {
        self.first == other.first && self.second == other.second
    }
}

#[cfg(unix)]
fn metadata_identity(metadata: &Metadata) -> Result<FileIdentity> {
    Ok(FileIdentity {
        first: metadata.dev(),
        second: metadata.ino(),
        links: metadata.nlink(),
    })
}

#[cfg(windows)]
fn opened_file_identity(file: &File) -> Result<FileIdentity> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: the handle comes from a live std::fs::File and the output points
    // to initialized writable storage for the duration of the call.
    let success =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, information.as_mut_ptr()) };
    if success == 0 {
        return Err(std::io::Error::last_os_error()).context("inspect opened model file");
    }
    // SAFETY: a successful call initializes the complete structure.
    let information = unsafe { information.assume_init() };
    Ok(FileIdentity {
        first: information.dwVolumeSerialNumber as u64,
        second: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
        links: information.nNumberOfLinks as u64,
    })
}

#[cfg(unix)]
fn opened_file_identity(file: &File) -> Result<FileIdentity> {
    metadata_identity(&file.metadata().context("inspect opened model file")?)
}

fn validate_component(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || value.ends_with('.')
    {
        bail!("{label} must be a bounded portable model-storage component");
    }
    let mut components = Path::new(value).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        bail!("{label} must be one path component");
    }
    Ok(())
}

fn symlink_metadata(path: &Path, label: &str) -> Result<Metadata> {
    std::fs::symlink_metadata(path)
        .with_context(|| format!("inspect {label} at {}", path.display()))
}

fn metadata_is_alias(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return true;
    }
    false
}

pub(crate) fn attest_real_directory(path: &Path, label: &str) -> Result<PathBuf> {
    let metadata = symlink_metadata(path, label)?;
    if !metadata.is_dir() || metadata_is_alias(&metadata) {
        bail!("{label} must be a real directory: {}", path.display());
    }
    let canonical = std::fs::canonicalize(path)
        .with_context(|| format!("canonicalize {label} at {}", path.display()))?;
    let canonical_metadata = symlink_metadata(&canonical, label)?;
    if !canonical_metadata.is_dir() || metadata_is_alias(&canonical_metadata) {
        bail!(
            "{label} must canonicalize to a real directory: {}",
            path.display()
        );
    }
    Ok(canonical)
}

/// Create a models root one direct real component at a time below an attested
/// nearest existing parent, refusing a symlink, junction, or other
/// reparse-point at every path this function creates or directly trusts.
pub fn prepare_models_root(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("resolve relative models root")?
            .join(path)
    };
    let mut missing = Vec::new();
    let mut cursor = absolute.as_path();
    loop {
        match std::fs::symlink_metadata(cursor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor
                    .file_name()
                    .ok_or_else(|| anyhow!("models root has no existing ancestor"))?
                    .to_owned();
                missing.push(name);
                cursor = cursor
                    .parent()
                    .ok_or_else(|| anyhow!("models root has no existing ancestor"))?;
            }
            Err(error) => return Err(error).context("inspect models root ancestor"),
        }
    }

    let mut current = attest_real_directory(cursor, "models root ancestor")?;
    for component in missing.iter().rev() {
        current = ensure_direct_os_directory(&current, component, "models root directory")?;
    }
    attest_real_directory(&current, "models root")
}

fn ensure_direct_directory(parent: &Path, name: &str, label: &str) -> Result<PathBuf> {
    validate_component(name, label)?;
    let canonical_parent = attest_real_directory(parent, "model directory parent")?;
    let child = canonical_parent.join(name);
    match std::fs::create_dir(&child) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(error).with_context(|| format!("create {label} at {}", child.display()));
        }
    }
    let canonical_child = attest_real_directory(&child, label)?;
    if canonical_child.parent() != Some(canonical_parent.as_path()) {
        bail!("{label} escaped its expected parent: {}", child.display());
    }
    Ok(canonical_child)
}

fn ensure_direct_os_directory(parent: &Path, name: &OsStr, label: &str) -> Result<PathBuf> {
    let canonical_parent = attest_real_directory(parent, "model directory parent")?;
    let child = canonical_parent.join(name);
    match std::fs::create_dir(&child) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(error).with_context(|| format!("create {label} at {}", child.display()));
        }
    }
    let canonical_child = attest_real_directory(&child, label)?;
    if canonical_child.parent() != Some(canonical_parent.as_path()) {
        bail!("{label} escaped its expected parent: {}", child.display());
    }
    Ok(canonical_child)
}

fn no_follow_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    options.custom_flags(NO_FOLLOW_FLAGS).mode(0o600);
    #[cfg(windows)]
    options.custom_flags(NO_FOLLOW_FLAGS);
    options
}

fn open_directory_no_follow(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(DIRECTORY_NO_FOLLOW_FLAGS);
    #[cfg(windows)]
    options.custom_flags(DIRECTORY_NO_FOLLOW_FLAGS);
    options.open(path).with_context(|| {
        format!(
            "open model directory without following links: {}",
            path.display()
        )
    })
}

#[derive(Debug)]
struct HeldDirectory {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
}

impl HeldDirectory {
    fn open(path: &Path, label: &str) -> Result<Self> {
        let path = attest_real_directory(path, label)?;
        let file = open_directory_no_follow(&path)?;
        let identity = opened_file_identity(&file)?;
        let held = Self {
            path,
            file,
            identity,
        };
        held.reattest(label)?;
        Ok(held)
    }

    fn reattest(&self, label: &str) -> Result<()> {
        let current_path = attest_real_directory(&self.path, label)?;
        let current_file = open_directory_no_follow(&current_path)?;
        let current_identity = opened_file_identity(&current_file)?;
        let held_identity = opened_file_identity(&self.file)?;
        if !held_identity.same_object(self.identity) || !current_identity.same_object(self.identity)
        {
            bail!(
                "{label} changed while a model mutation was in progress: {}",
                self.path.display()
            );
        }
        Ok(())
    }
}

fn open_existing_no_follow(path: &Path, write: bool) -> Result<File> {
    let mut options = no_follow_options();
    options.read(true).write(write);
    options.open(path).with_context(|| {
        format!(
            "open confined model file without following links: {}",
            path.display()
        )
    })
}

pub(crate) fn attest_opened_file(path: &Path, file: &File, label: &str) -> Result<()> {
    let opened = opened_file_identity(file)?;
    if opened.links != 1 {
        bail!("{label} must be a single-link file: {}", path.display());
    }
    let path_metadata = symlink_metadata(path, label)?;
    if !path_metadata.is_file() || metadata_is_alias(&path_metadata) {
        bail!(
            "{label} must be a regular non-link file: {}",
            path.display()
        );
    }
    #[cfg(unix)]
    if metadata_identity(&path_metadata)? != opened {
        bail!("{label} changed while it was opened: {}", path.display());
    }
    #[cfg(windows)]
    {
        let path_file = open_existing_no_follow(path, false)?;
        if opened_file_identity(&path_file)? != opened {
            bail!("{label} changed while it was opened: {}", path.display());
        }
    }
    Ok(())
}

/// Open an existing artifact leaf without following it and attest that its
/// descriptor is still the single-link regular file named by `path`.
pub(crate) fn open_attested_file_for_read(path: &Path, label: &str) -> Result<File> {
    let file = open_existing_no_follow(path, false)?;
    attest_opened_file(path, &file, label)?;
    Ok(file)
}

/// Cargo emits `target/<profile>/examples/transcribe-fixture` and then
/// link-or-copies it to the unhashed path it reports, leaving a two-name
/// hard-link pair on most filesystems. The benchmark fixture hashes its own
/// executable, so accept exactly that recognized pair while keeping every
/// other artifact on the single-link rule. Returns the twin path when found.
fn cargo_example_twin(path: &Path, opened: &FileIdentity) -> Result<Option<PathBuf>> {
    let executable_name = if cfg!(windows) {
        "transcribe-fixture.exe"
    } else {
        "transcribe-fixture"
    };
    if path.file_name().and_then(|name| name.to_str()) != Some(executable_name) {
        return Ok(None);
    }
    let Some(examples_dir) = path.parent() else {
        return Ok(None);
    };
    if examples_dir.file_name().and_then(|name| name.to_str()) != Some("examples") {
        return Ok(None);
    }
    let source_suffix = if cfg!(windows) { ".exe" } else { "" };
    let mut matches = Vec::new();
    for entry in std::fs::read_dir(examples_dir).context("list Cargo example artifacts")? {
        let entry = entry.context("inspect Cargo example artifact")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(hash) = name
            .strip_prefix("transcribe_fixture-")
            .and_then(|rest| rest.strip_suffix(source_suffix))
        else {
            continue;
        };
        if hash.len() != 16 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let metadata = entry
            .metadata()
            .context("inspect Cargo example artifact metadata")?;
        if !metadata.is_file() || metadata_is_alias(&metadata) {
            continue;
        }
        if metadata_identity(&metadata)?.same_object(*opened) {
            matches.push(entry.path());
        }
    }
    if matches.len() == 1 {
        Ok(matches.pop())
    } else {
        Ok(None)
    }
}

/// Attest a benchmark executable, permitting only the recognized Cargo
/// example hard-link pair in addition to the regular single-link rule.
pub(crate) fn attest_benchmark_executable(path: &Path, file: &File) -> Result<()> {
    let opened = opened_file_identity(file)?;
    if opened.links == 1 {
        return attest_opened_file(path, file, "benchmark executable");
    }
    if opened.links != 2 {
        bail!(
            "benchmark executable must be a single-link file or a Cargo example pair: {}",
            path.display()
        );
    }
    let path_metadata = symlink_metadata(path, "benchmark executable")?;
    if !path_metadata.is_file() || metadata_is_alias(&path_metadata) {
        bail!(
            "benchmark executable must be a regular non-link file: {}",
            path.display()
        );
    }
    if !metadata_identity(&path_metadata)?.same_object(opened) {
        bail!(
            "benchmark executable changed while it was opened: {}",
            path.display()
        );
    }
    if cargo_example_twin(path, &opened)?.is_none() {
        bail!(
            "benchmark executable hard link is not a recognized Cargo example pair: {}",
            path.display()
        );
    }
    Ok(())
}

pub(crate) fn open_attested_benchmark_executable_for_read(path: &Path) -> Result<File> {
    let file = open_existing_no_follow(path, false)?;
    attest_benchmark_executable(path, &file)?;
    Ok(file)
}

fn confined_child(parent: &Path, filename: &str, label: &str) -> Result<(PathBuf, PathBuf)> {
    validate_component(filename, label)?;
    let canonical_parent = attest_real_directory(parent, "model artifact parent")?;
    Ok((canonical_parent.join(filename), canonical_parent))
}

/// Assert that a direct artifact child is absent or a regular single-link file.
pub fn attest_model_file(parent: &Path, filename: &str, label: &str) -> Result<Option<u64>> {
    let (path, _) = confined_child(parent, filename, label)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("inspect {label}")),
    };
    if !metadata.is_file() || metadata_is_alias(&metadata) {
        bail!(
            "{label} must be a regular non-link file: {}",
            path.display()
        );
    }
    let file = open_existing_no_follow(&path, false)?;
    attest_opened_file(&path, &file, label)?;
    Ok(Some(metadata.len()))
}

/// Open a direct artifact child for append or a fresh write without following links.
pub fn open_model_file_for_write(
    parent: &Path,
    filename: &str,
    append: bool,
    label: &str,
) -> Result<File> {
    let (path, _) = confined_child(parent, filename, label)?;
    if path.exists() {
        attest_model_file(parent, filename, label)?;
    }
    let mut options = no_follow_options();
    options.read(true).write(true).create(true);
    if append {
        options.append(true);
    }
    let file = options
        .open(&path)
        .with_context(|| format!("open {label} at {}", path.display()))?;
    attest_opened_file(&path, &file, label)?;
    if !append {
        file.set_len(0)
            .with_context(|| format!("truncate {label} at {}", path.display()))?;
    }
    Ok(file)
}

/// Remove a direct artifact child after refusing aliases and hard links.
pub fn remove_model_file(parent: &Path, filename: &str, label: &str) -> Result<bool> {
    let (path, canonical_parent) = confined_child(parent, filename, label)?;
    let file = match open_attested_file_for_read(&path, label) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let identity = opened_file_identity(&file)?;
    let tombstone_name = format!(".muesly-delete-{}", uuid::Uuid::new_v4());
    let tombstone = canonical_parent.join(&tombstone_name);
    std::fs::rename(&path, &tombstone)
        .with_context(|| format!("quarantine {label} before removal"))?;
    let moved = open_attested_file_for_read(&tombstone, label)?;
    if !opened_file_identity(&moved)?.same_object(identity) {
        bail!("{label} changed while it was quarantined for removal");
    }
    std::fs::remove_file(&tombstone)
        .with_context(|| format!("remove {label} at {}", tombstone.display()))?;
    Ok(true)
}

/// Rename one direct confined file over another and re-attest the result.
pub fn rename_model_file(parent: &Path, source: &str, destination: &str) -> Result<()> {
    attest_model_file(parent, source, "partial model artifact")?
        .ok_or_else(|| anyhow!("partial model artifact is missing"))?;
    attest_model_file(parent, destination, "final model artifact")?;
    let canonical_parent = attest_real_directory(parent, "model artifact parent")?;
    std::fs::rename(
        canonical_parent.join(source),
        canonical_parent.join(destination),
    )
    .context("finalize confined model artifact")?;
    attest_model_file(parent, destination, "final model artifact")?
        .ok_or_else(|| anyhow!("final model artifact disappeared after rename"))?;
    Ok(())
}

/// Rename a source artifact while proving that the published destination is
/// the exact descriptor the caller already verified.
pub(crate) fn rename_opened_model_file(
    parent: &Path,
    source: &str,
    destination: &str,
    opened_source: &File,
) -> Result<()> {
    let (source_path, canonical_parent) = confined_child(parent, source, "partial model artifact")?;
    let source_identity = opened_file_identity(opened_source)?;
    attest_opened_file(
        &source_path,
        opened_source,
        "verified partial model artifact",
    )?;
    attest_model_file(parent, destination, "final model artifact")?;
    std::fs::rename(&source_path, canonical_parent.join(destination))
        .context("publish verified confined model artifact")?;
    let destination_path = canonical_parent.join(destination);
    attest_opened_file(&destination_path, opened_source, "published model artifact")?;
    if !opened_file_identity(opened_source)?.same_object(source_identity) {
        bail!("verified model artifact identity changed during publication");
    }
    Ok(())
}

fn attest_tree(directory: &Path) -> Result<()> {
    let canonical = attest_real_directory(directory, "model artifact directory")?;
    for entry in std::fs::read_dir(&canonical).context("read model artifact directory")? {
        let entry = entry.context("read model artifact directory entry")?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .with_context(|| format!("inspect model artifact entry at {}", path.display()))?;
        if metadata_is_alias(&metadata) {
            bail!(
                "model artifact tree cannot contain links: {}",
                path.display()
            );
        }
        if metadata.is_dir() {
            attest_tree(&path)?;
        } else if metadata.is_file() {
            let filename = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("model artifact filename must be UTF-8"))?;
            attest_model_file(&canonical, &filename, "model artifact file")?;
        } else {
            bail!(
                "model artifact tree contains a non-regular entry: {}",
                path.display()
            );
        }
    }
    Ok(())
}

/// Remove one provider/model directory without traversing aliases.
pub fn remove_model_directory(provider_directory: &Path, model: &str) -> Result<bool> {
    validate_component(model, "model name")?;
    let provider = attest_real_directory(provider_directory, "provider model directory")?;
    let model_directory = provider.join(model);
    let metadata = match std::fs::symlink_metadata(&model_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("inspect model directory for removal"),
    };
    if !metadata.is_dir() || metadata_is_alias(&metadata) {
        bail!(
            "model directory must be a real directory: {}",
            model_directory.display()
        );
    }
    attest_tree(&model_directory)?;
    let held = HeldDirectory::open(&model_directory, "model directory for removal")?;
    let tombstone = provider.join(format!(".muesly-delete-{model}-{}", uuid::Uuid::new_v4()));
    std::fs::rename(&model_directory, &tombstone)
        .context("quarantine model directory before removal")?;
    let moved = HeldDirectory::open(&tombstone, "quarantined model directory")?;
    if !moved.identity.same_object(held.identity) {
        bail!("model directory changed while it was quarantined for removal");
    }
    attest_tree(&tombstone)?;
    std::fs::remove_dir_all(&tombstone)
        .with_context(|| format!("remove model directory at {}", tombstone.display()))?;
    Ok(true)
}

/// Return an existing canonical direct provider/model directory without
/// creating it. Aliased/reparse-point model directories fail closed.
pub fn existing_model_directory(provider_directory: &Path, model: &str) -> Result<Option<PathBuf>> {
    validate_component(model, "model name")?;
    let provider = attest_real_directory(provider_directory, "provider model directory")?;
    let model_directory = provider.join(model);
    match std::fs::symlink_metadata(&model_directory) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("inspect model directory"),
    }
    let canonical = attest_real_directory(&model_directory, "model directory")?;
    if canonical.parent() != Some(provider.as_path()) {
        bail!(
            "model directory escaped its provider: {}",
            model_directory.display()
        );
    }
    Ok(Some(canonical))
}

/// Return the canonical provider directory, creating only direct real ancestors.
pub fn provider_directory(models_root: &Path, provider: &str) -> Result<PathBuf> {
    let root = attest_real_directory(models_root, "models root")?;
    match provider {
        "whisper" => Ok(root),
        "parakeet" => ensure_direct_directory(&root, "parakeet", "Parakeet provider directory"),
        _ => bail!("unsupported model provider '{provider}'"),
    }
}

/// Return the canonical direct provider/model directory.
pub fn model_directory(models_root: &Path, provider: &str, model: &str) -> Result<PathBuf> {
    if provider != "parakeet" {
        bail!("only Parakeet uses a model artifact directory");
    }
    let provider = provider_directory(models_root, provider)?;
    ensure_direct_directory(&provider, model, "Parakeet model directory")
}

/// OS-backed exclusive mutation lock for one provider/model artifact.
#[derive(Debug)]
pub struct ModelMutationLock {
    file: File,
    lock_path: PathBuf,
    models_root: PathBuf,
    models_root_directory: HeldDirectory,
    provider_directory: HeldDirectory,
    locks_directory: HeldDirectory,
    model_directory: Option<HeldDirectory>,
}

impl ModelMutationLock {
    pub fn try_acquire(models_root: &Path, provider: &str, model: &str) -> Result<Self> {
        validate_component(provider, "model provider")?;
        validate_component(model, "model name")?;
        let models_root_directory = HeldDirectory::open(models_root, "models root")?;
        let models_root = models_root_directory.path.clone();
        // Attest/create the provider before taking the lock so every mutation
        // uses a stable direct ancestor rooted in the shared models directory.
        let provider_path = provider_directory(&models_root, provider)?;
        let provider_directory = HeldDirectory::open(&provider_path, "provider model directory")?;
        let locks = ensure_direct_directory(
            &models_root,
            LOCKS_DIRECTORY,
            "model mutation lock directory",
        )?;
        let filename = format!("{provider}-{model}.lock");
        let mut options = no_follow_options();
        options.read(true).write(true).create(true);
        let lock_path = locks.join(&filename);
        let file = options
            .open(&lock_path)
            .with_context(|| format!("open model mutation lock at {}", lock_path.display()))?;
        attest_opened_file(&lock_path, &file, "model mutation lock")?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
                    .with_context(|| format!("another process is mutating {provider}/{model}"));
            }
            Err(TryLockError::Error(error)) => {
                return Err(error)
                    .with_context(|| format!("lock model mutation for {provider}/{model}"));
            }
        }
        attest_opened_file(&lock_path, &file, "model mutation lock")?;
        let model_directory = if provider == "parakeet" {
            let path = ensure_direct_directory(&provider_path, model, "Parakeet model directory")?;
            Some(HeldDirectory::open(&path, "Parakeet model directory")?)
        } else {
            None
        };
        let lock = Self {
            file,
            lock_path,
            models_root,
            models_root_directory,
            provider_directory,
            locks_directory: HeldDirectory::open(&locks, "model mutation lock directory")?,
            model_directory,
        };
        lock.attest_storage()?;
        Ok(lock)
    }

    pub fn models_root(&self) -> &Path {
        &self.models_root
    }

    pub fn provider_directory(&self) -> Result<PathBuf> {
        self.attest_storage()?;
        Ok(self.provider_directory.path.clone())
    }

    pub fn model_directory(&self) -> Result<PathBuf> {
        self.attest_storage()?;
        self.model_directory
            .as_ref()
            .map(|directory| directory.path.clone())
            .ok_or_else(|| anyhow!("only Parakeet uses a model artifact directory"))
    }

    /// Reassert every held ancestor and the lock-file identity before or after
    /// a path-based mutation.
    pub fn attest_ancestors(&self) -> Result<()> {
        self.models_root_directory.reattest("models root")?;
        self.provider_directory
            .reattest("provider model directory")?;
        self.locks_directory
            .reattest("model mutation lock directory")?;
        attest_opened_file(&self.lock_path, &self.file, "model mutation lock")?;
        Ok(())
    }

    pub fn attest_storage(&self) -> Result<()> {
        self.attest_ancestors()?;
        if let Some(directory) = &self.model_directory {
            directory.reattest("Parakeet model directory")?;
        }
        Ok(())
    }
}

/// Whether a mutation-lock acquisition failed because another process owns it.
pub fn is_model_mutation_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
    })
}

/// Validate that a resumed HTTP response covers exactly the requested suffix.
/// A mismatched range must never be appended to an existing model artifact.
pub fn validate_resume_content_range(
    content_range: Option<&str>,
    expected_start: u64,
    content_length: Option<u64>,
) -> Result<u64> {
    let value = content_range.ok_or_else(|| anyhow!("partial response omitted Content-Range"))?;
    let value = value
        .strip_prefix("bytes ")
        .ok_or_else(|| anyhow!("partial response Content-Range must use bytes"))?;
    let (range, total) = value
        .split_once('/')
        .ok_or_else(|| anyhow!("partial response Content-Range is malformed"))?;
    if total == "*" {
        bail!("partial response Content-Range must declare the total size");
    }
    let total = total
        .parse::<u64>()
        .context("parse partial response total size")?;
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| anyhow!("partial response byte range is malformed"))?;
    let start = start
        .parse::<u64>()
        .context("parse partial response range start")?;
    let end = end
        .parse::<u64>()
        .context("parse partial response range end")?;
    if start != expected_start {
        bail!("partial response starts at {start}, expected existing size {expected_start}");
    }
    let span = end
        .checked_sub(start)
        .and_then(|span| span.checked_add(1))
        .ok_or_else(|| anyhow!("partial response Content-Range is empty or reversed"))?;
    if end.checked_add(1) != Some(total) {
        bail!("partial response must cover the complete remaining suffix");
    }
    if let Some(content_length) = content_length {
        if content_length != span {
            bail!(
                "partial response Content-Length {content_length} does not match range span {span}"
            );
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_one_model_across_file_handles_and_releases_on_drop() {
        let root = tempfile::tempdir().unwrap();
        let first = ModelMutationLock::try_acquire(root.path(), "whisper", "base").unwrap();
        let error = ModelMutationLock::try_acquire(root.path(), "whisper", "base").unwrap_err();
        assert!(error.to_string().contains("another process is mutating"));
        ModelMutationLock::try_acquire(root.path(), "whisper", "small").unwrap();
        drop(first);
        ModelMutationLock::try_acquire(root.path(), "whisper", "base").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn detects_models_root_replacement_while_lock_is_held() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("models");
        std::fs::create_dir(&root).unwrap();
        let lock = ModelMutationLock::try_acquire(&root, "whisper", "base").unwrap();

        std::fs::rename(&root, parent.path().join("displaced-models")).unwrap();
        std::fs::create_dir(&root).unwrap();

        let error = lock.attest_storage().unwrap_err();
        assert!(error.to_string().contains("changed"));
    }

    #[test]
    fn rejects_provider_and_artifact_aliases() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.path().join("parakeet")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), root.path().join("parakeet")).unwrap();
        assert!(provider_directory(root.path(), "parakeet").is_err());

        let file = root.path().join("ggml-base.bin");
        let alias = outside.path().join("alias.bin");
        std::fs::write(&file, b"model").unwrap();
        std::fs::hard_link(&file, &alias).unwrap();
        assert!(attest_model_file(root.path(), "ggml-base.bin", "model").is_err());
    }

    #[test]
    fn no_follow_writer_refuses_a_partial_file_symlink() {
        let root = tempfile::tempdir().unwrap();
        assert!(!remove_model_file(root.path(), "missing.part", "partial").unwrap());
        let outside = tempfile::NamedTempFile::new().unwrap();
        let partial = root.path().join("ggml-base.bin.part");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &partial).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(outside.path(), &partial).unwrap();
        assert!(
            open_model_file_for_write(root.path(), "ggml-base.bin.part", false, "partial").is_err()
        );
    }

    #[test]
    fn refuses_recursive_cleanup_when_a_model_tree_contains_a_link() {
        let root = tempfile::tempdir().unwrap();
        let provider = provider_directory(root.path(), "parakeet").unwrap();
        let model = ensure_direct_directory(&provider, "test-model", "model").unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), model.join("escape.onnx")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(outside.path(), model.join("escape.onnx")).unwrap();
        assert!(remove_model_directory(&provider, "test-model").is_err());
        assert!(outside.path().exists());
        assert!(model.exists());
    }

    #[test]
    fn validates_exact_resume_content_ranges() {
        assert_eq!(
            validate_resume_content_range(Some("bytes 100-199/200"), 100, Some(100)).unwrap(),
            200
        );
        for (header, length) in [
            (Some("bytes 99-199/200"), Some(101)),
            (Some("bytes 100-198/200"), Some(99)),
            (Some("bytes 100-199/*"), Some(100)),
            (Some("bytes 100-199/200"), Some(99)),
            (None, Some(100)),
        ] {
            assert!(validate_resume_content_range(header, 100, length).is_err());
        }
    }
}
