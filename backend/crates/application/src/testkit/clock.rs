//! Relógio controlado pelo teste.

use std::sync::Mutex;

pub struct ManualClock(Mutex<chrono::DateTime<chrono::Utc>>);

impl ManualClock {
    pub fn at(now: chrono::DateTime<chrono::Utc>) -> Self {
        Self(Mutex::new(now))
    }

    pub fn set(&self, now: chrono::DateTime<chrono::Utc>) {
        *self.0.lock().unwrap() = now;
    }
}

impl crate::ports::Clock for ManualClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        *self.0.lock().unwrap()
    }
}
