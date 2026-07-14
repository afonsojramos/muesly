#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    // Quiet verbose native ML internals while preserving explicit RUST_LOG overrides.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,ort=warn"))
        .init();

    // Async logger will be initialized lazily when first needed (after Tauri runtime starts)
    log::info!("Starting application...");
    app_lib::run();
}
