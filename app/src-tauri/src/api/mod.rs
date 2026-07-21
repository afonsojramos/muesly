pub mod bars;
pub mod commands;
pub mod folder_context;
pub mod folders;
pub mod meetings;
pub mod nl_search;
pub mod people;
pub mod settings;
pub mod types;

pub use folders::*;
pub use meetings::*;
pub use nl_search::*;
pub use people::*;
pub use settings::*;
pub use types::*;
// Don't re-export commands to avoid conflicts - lib.rs will import directly
