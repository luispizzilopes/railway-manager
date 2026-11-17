//! Limitador de taxa compartilhado por todas as chamadas ao Railway: token bucket
//! (`RM_RAILWAY_RPS`) mais pausa global por `Retry-After` ou cota esgotada.

use std::sync::Mutex;
use std::time::Duration;

use application::railway::RateLimitStatus;
use chrono::Utc;
use tokio::time::Instant;

#[derive(Debug)]
struct State {
    tokens: f64,
    refilled_at: Instant,
    paused_until: Option<Instant>,
    status: RateLimitStatus,
}

#[derive(Debug)]
pub struct RateLimiter {
    rps: f64,
    state: Mutex<State>,
}

impl RateLimiter {
    pub fn new(rps: u32) -> Self {
        let rps = f64::from(rps.max(1));
        Self {
            rps,
            state: Mutex::new(State {
                tokens: rps,
                refilled_at: Instant::now(),
                paused_until: None,
                status: RateLimitStatus::default(),
            }),
        }
    }

    /// Aguarda até poder enviar uma requisição.
    pub async fn acquire(&self) {
        loop {
            let wait = {
                let mut s = self.state.lock().expect("rate limiter envenenado");
                let now = Instant::now();
                match s.paused_until {
                    Some(until) if until > now => until - now,
                    _ => {
                        if s.paused_until.take().is_some() {
                            s.status.paused_until = None;
                        }
                        let elapsed = now.duration_since(s.refilled_at).as_secs_f64();
                        s.tokens = (s.tokens + elapsed * self.rps).min(self.rps);
                        s.refilled_at = now;
                        if s.tokens >= 1.0 {
                            s.tokens -= 1.0;
                            return;
                        }
                        Duration::from_secs_f64((1.0 - s.tokens) / self.rps)
                    }
                }
            };
            tokio::time::sleep(wait).await;
        }
    }

    /// Bloqueia novas requisições pelo tempo indicado (nunca encurta uma pausa vigente).
    pub fn pause_for(&self, duration: Duration) {
        let mut s = self.state.lock().expect("rate limiter envenenado");
        let until = Instant::now() + duration;
        if s.paused_until.is_none_or(|current| current < until) {
            s.paused_until = Some(until);
            s.status.paused_until = chrono::Duration::from_std(duration)
                .ok()
                .map(|d| Utc::now() + d);
        }
    }

    /// Registra a cota informada pelos cabeçalhos; cota zerada pausa até o reset.
    pub fn observe_quota(
        &self,
        remaining: Option<u64>,
        limit: Option<u64>,
        reset_in: Option<Duration>,
    ) {
        {
            let mut s = self.state.lock().expect("rate limiter envenenado");
            if remaining.is_some() {
                s.status.remaining = remaining;
            }
            if limit.is_some() {
                s.status.limit = limit;
            }
        }
        if remaining == Some(0) {
            self.pause_for(reset_in.unwrap_or(Duration::from_secs(60)));
        }
    }

    pub fn status(&self) -> RateLimitStatus {
        let s = self.state.lock().expect("rate limiter envenenado");
        let mut status = s.status.clone();
        if s.paused_until.is_none_or(|until| until <= Instant::now()) {
            status.paused_until = None;
        }
        status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn token_bucket_respeita_rps() {
        let limiter = RateLimiter::new(2);
        let start = Instant::now();
        for _ in 0..6 {
            limiter.acquire().await;
        }
        // 2 imediatos (bucket cheio) + 4 a 2/s = 2s.
        assert_eq!(start.elapsed().as_secs(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn pausa_bloqueia_pelo_tempo_indicado() {
        let limiter = RateLimiter::new(10);
        limiter.pause_for(Duration::from_secs(30));
        assert!(limiter.status().paused_until.is_some());
        let start = Instant::now();
        limiter.acquire().await;
        assert!(start.elapsed() >= Duration::from_secs(30));
        assert!(limiter.status().paused_until.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn pausa_menor_nao_encurta_a_vigente() {
        let limiter = RateLimiter::new(10);
        limiter.pause_for(Duration::from_secs(30));
        limiter.pause_for(Duration::from_secs(1));
        let start = Instant::now();
        limiter.acquire().await;
        assert!(start.elapsed() >= Duration::from_secs(30));
    }

    #[tokio::test(start_paused = true)]
    async fn cota_zerada_pausa_ate_o_reset() {
        let limiter = RateLimiter::new(10);
        limiter.observe_quota(Some(0), Some(1000), Some(Duration::from_secs(12)));
        let status = limiter.status();
        assert_eq!((status.remaining, status.limit), (Some(0), Some(1000)));
        assert!(status.paused_until.is_some());
        let start = Instant::now();
        limiter.acquire().await;
        assert!(start.elapsed() >= Duration::from_secs(12));
    }
}
