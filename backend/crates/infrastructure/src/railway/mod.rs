//! Adaptador da API pública do Railway.

pub mod client;
pub mod ops;
pub mod rate_limit;
pub mod transport;

pub use client::RailwayClient;
pub use transport::{Transport, TransportConfig};
