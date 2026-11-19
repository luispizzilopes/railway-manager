//! Fakes para testes dos casos de uso e da API. Disponível com a feature `testkit`.

mod clock;
mod railway;
mod users;

pub use clock::ManualClock;
pub use railway::*;
pub use users::{FakeSessions, FakeUsers, PlainHasher};
