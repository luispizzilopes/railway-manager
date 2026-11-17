//! Casos de uso e portas (traits) implementadas pela infraestrutura.

pub mod credentials;
pub mod dashboard;
pub mod error;
pub mod history;
pub mod inventory;
pub mod ports;
pub mod power;
pub mod projects;
pub mod railway;
#[cfg(any(test, feature = "testkit"))]
pub mod testkit;
