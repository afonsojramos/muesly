//! Best-effort free-disk-space lookup for download preflight. Fails open:
//! returns None when it cannot determine the answer, and callers proceed.

use std::path::{Path, PathBuf};

/// Pick the available bytes for the disk whose mount point is the longest
/// prefix of `path`. Pure, so it is unit-testable without real disks.
pub fn pick_available(path: &Path, disks: &[(PathBuf, u64)]) -> Option<u64> {
    disks
        .iter()
        .filter(|(mount, _)| path.starts_with(mount))
        .max_by_key(|(mount, _)| mount.as_os_str().len())
        .map(|(_, avail)| *avail)
}

/// Available bytes on the filesystem holding `path`, or None if undeterminable.
pub fn available_space_for(path: &Path) -> Option<u64> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let pairs: Vec<(PathBuf, u64)> = disks
        .list()
        .iter()
        .map(|d| (d.mount_point().to_path_buf(), d.available_space()))
        .collect();
    pick_available(&canonical, &pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_longest_matching_mount() {
        let disks = vec![
            (PathBuf::from("/"), 1_000u64),
            (PathBuf::from("/Users/me/data"), 50u64),
        ];
        // A path under the nested mount uses that mount, not "/".
        assert_eq!(pick_available(Path::new("/Users/me/data/models"), &disks), Some(50));
        // A path elsewhere falls back to "/".
        assert_eq!(pick_available(Path::new("/var/tmp"), &disks), Some(1_000));
    }

    #[test]
    fn no_matching_mount_returns_none() {
        let disks = vec![(PathBuf::from("/mnt/x"), 10u64)];
        assert_eq!(pick_available(Path::new("/home/y"), &disks), None);
    }
}
