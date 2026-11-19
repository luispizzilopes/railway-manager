//! Casos de uso e portas (traits) implementadas pela infraestrutura.
//!
//! Os casos de uso ficam agrupados por contexto e são reexportados na raiz, então
//! `application::power` e `application::operations::power` são o mesmo caminho.

pub mod access;
pub mod catalog;
pub mod error;
pub mod operations;
pub mod ports;
pub mod railway;
pub mod scheduling;
#[cfg(any(test, feature = "testkit"))]
pub mod testkit;

pub use access::{credentials, users};
pub use catalog::{dashboard, inventory, logs, projects};
pub use operations::{history, power};
pub use scheduling::{scheduled_actions, schedules};
