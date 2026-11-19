//! Handlers HTTP, um módulo por assunto. Validam a entrada, chamam os casos de uso e
//! devolvem DTOs sem segredos.

mod credentials;
mod dashboard;
mod history;
mod inventory;
mod logs;
mod operations;
mod projects;
mod scheduled_actions;
mod schedules;
mod session;
mod users;
mod util;

pub use credentials::*;
pub use dashboard::*;
pub use history::*;
pub use inventory::*;
pub use logs::*;
pub use operations::*;
pub use projects::*;
pub use scheduled_actions::*;
pub use schedules::*;
pub use session::*;
pub use users::*;
