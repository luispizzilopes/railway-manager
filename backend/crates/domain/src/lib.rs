//! Domínio do Railway Manager: entidades, value objects e regras puras, sem I/O.
//!
//! Os módulos ficam agrupados por contexto e são reexportados na raiz, então
//! `domain::power` e `domain::operations::power` são o mesmo caminho.

pub mod access;
pub mod catalog;
pub mod ids;
pub mod logs;
pub mod operations;
pub mod scheduling;

pub use access::{credential, user};
pub use operations::{deployment, operation, power, state};
pub use scheduling::{schedule, scheduled_action};
