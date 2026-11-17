//! Acesso do administrador: senha (argon2 ou texto claro em dev), sessão por cookie
//! opaco (só o hash vai ao banco), limite de tentativas e proteção das rotas.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use application::ports::SessionRepository;
use argon2::Argon2;
use argon2::password_hash::PasswordVerifier;
use argon2::password_hash::phc::PasswordHash;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::error::ApiError;

pub const COOKIE: &str = "rm_session";

/// Senha do administrador.
pub enum AdminPassword {
    /// Hash PHC argon2 (produção).
    Hash(String),
    /// Texto claro (desenvolvimento).
    Plain(String),
}

impl AdminPassword {
    pub fn verify(&self, candidate: &str) -> bool {
        match self {
            Self::Hash(phc) => PasswordHash::new(phc).is_ok_and(|hash| {
                Argon2::default()
                    .verify_password(candidate.as_bytes(), &hash)
                    .is_ok()
            }),
            Self::Plain(expected) => constant_time_eq(expected.as_bytes(), candidate.as_bytes()),
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Gera o hash PHC para `RM_ADMIN_PASSWORD_HASH`.
pub fn hash_password(password: &str) -> Result<String, String> {
    use argon2::password_hash::PasswordHasher;
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

/// Janela deslizante de tentativas falhas (há um único administrador).
pub struct LoginLimiter {
    max_attempts: usize,
    window: Duration,
    failures: Mutex<VecDeque<Instant>>,
}

impl LoginLimiter {
    pub fn new(max_attempts: u32, window: Duration) -> Self {
        Self {
            max_attempts: max_attempts.max(1) as usize,
            window,
            failures: Mutex::new(VecDeque::new()),
        }
    }

    /// `Some(segundos)` enquanto o limite estiver estourado.
    pub fn blocked_for(&self) -> Option<Duration> {
        let mut failures = self.failures.lock().unwrap();
        let now = Instant::now();
        while failures
            .front()
            .is_some_and(|t| now.duration_since(*t) >= self.window)
        {
            failures.pop_front();
        }
        (failures.len() >= self.max_attempts).then(|| {
            self.window
                .saturating_sub(now.duration_since(*failures.front().unwrap()))
        })
    }

    pub fn record_failure(&self) {
        self.failures.lock().unwrap().push_back(Instant::now());
    }

    pub fn reset(&self) {
        self.failures.lock().unwrap().clear();
    }
}

pub struct AuthConfig {
    pub password: AdminPassword,
    pub session_ttl: Duration,
    pub cookie_secure: bool,
    pub limiter: LoginLimiter,
}

pub fn new_session_id() -> String {
    let bytes: [u8; 32] = rand::random();
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_session(id: &str) -> String {
    Sha256::digest(id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn session_cookie(id: &str, config: &AuthConfig) -> String {
    let secure = if config.cookie_secure { "; Secure" } else { "" };
    format!(
        "{COOKIE}={id}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{secure}",
        config.session_ttl.as_secs()
    )
}

pub fn clear_cookie(config: &AuthConfig) -> String {
    let secure = if config.cookie_secure { "; Secure" } else { "" };
    format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{secure}")
}

pub fn session_from(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .map(|(_, value)| value.to_owned())
        .filter(|v| !v.is_empty())
}

pub async fn is_authenticated(
    sessions: &Arc<dyn SessionRepository>,
    headers: &HeaderMap,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    match session_from(headers) {
        Some(id) => sessions
            .is_valid(&hash_session(&id), now)
            .await
            .unwrap_or(false),
        None => false,
    }
}

/// Exige sessão em todas as rotas `/api`, exceto login/logout.
pub async fn require_session(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    // Dentro de `nest("/api")` o caminho chega sem o prefixo.
    let is_session = path == "/session" || path == "/api/session";
    let public = is_session && matches!(*request.method(), Method::POST | Method::DELETE);
    if !public && !is_authenticated(&state.sessions, request.headers(), state.clock.now()).await {
        return ApiError::unauthorized().into_response();
    }
    next.run(request).await
}

/// Mitigação de CSRF (junto de `SameSite=Strict`): mutações só com JSON.
pub async fn require_json(request: Request, next: Next) -> Response {
    let mutating = matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    let is_json = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if mutating && !is_json {
        return ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "envie Content-Type: application/json",
        )
        .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn senha_hash_e_texto_claro() {
        let phc = hash_password("s3nha").unwrap();
        assert!(phc.starts_with("$argon2id$"));
        assert!(AdminPassword::Hash(phc.clone()).verify("s3nha"));
        assert!(!AdminPassword::Hash(phc).verify("outra"));
        assert!(AdminPassword::Plain("abc".into()).verify("abc"));
        assert!(!AdminPassword::Plain("abc".into()).verify("abd"));
        assert!(!AdminPassword::Plain("abc".into()).verify("ab"));
    }

    #[test]
    fn limitador_bloqueia_apos_o_maximo() {
        let limiter = LoginLimiter::new(2, Duration::from_secs(60));
        assert!(limiter.blocked_for().is_none());
        limiter.record_failure();
        assert!(limiter.blocked_for().is_none());
        limiter.record_failure();
        assert!(limiter.blocked_for().unwrap() <= Duration::from_secs(60));
        limiter.reset();
        assert!(limiter.blocked_for().is_none());
    }

    #[test]
    fn cookie_de_sessao() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "a=1; rm_session=xyz; b=2".parse().unwrap());
        assert_eq!(session_from(&headers).as_deref(), Some("xyz"));
        let config = AuthConfig {
            password: AdminPassword::Plain("x".into()),
            session_ttl: Duration::from_secs(60),
            cookie_secure: true,
            limiter: LoginLimiter::new(1, Duration::from_secs(1)),
        };
        let cookie = session_cookie("xyz", &config);
        for part in ["HttpOnly", "SameSite=Strict", "Secure", "Max-Age=60"] {
            assert!(cookie.contains(part), "{cookie}");
        }
        assert_eq!(hash_session("xyz").len(), 64);
    }
}
