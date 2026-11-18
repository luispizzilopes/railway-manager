//! Acesso: master (nome e senha do ambiente, argon2 ou texto claro em dev) e usuários do
//! banco; sessão por cookie opaco (só o hash vai ao banco), limite de tentativas por
//! usuário e autorização por papel.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use application::ports::{PasswordHasher, SessionOwner};
use argon2::Argon2;
use argon2::password_hash::PasswordVerifier;
use argon2::password_hash::phc::PasswordHash;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use domain::user::Role;
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::error::ApiError;
use crate::permissions;

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

/// Hash argon2 de senhas de usuários cadastrados.
pub struct Argon2Hasher {
    dummy_hash: String,
}

impl Argon2Hasher {
    pub fn new() -> Self {
        Self {
            dummy_hash: hash_password("senha-fictícia-para-igualar-o-tempo").unwrap_or_default(),
        }
    }
}

impl Default for Argon2Hasher {
    fn default() -> Self {
        Self::new()
    }
}

impl PasswordHasher for Argon2Hasher {
    fn hash(&self, password: &str) -> Result<String, String> {
        hash_password(password)
    }

    fn verify(&self, password: &str, hash: &str) -> bool {
        AdminPassword::Hash(hash.to_owned()).verify(password)
    }

    fn verify_dummy(&self, password: &str) {
        let _ = self.verify(password, &self.dummy_hash);
    }
}

/// Gera o hash PHC para `RM_ADMIN_PASSWORD_HASH`.
pub fn hash_password(password: &str) -> Result<String, String> {
    use argon2::password_hash::PasswordHasher;
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

/// Máximo de nomes distintos acompanhados; acima disso, nomes novos dividem um só balde
/// (evita crescer sem limite com nomes aleatórios).
const MAX_TRACKED_USERS: usize = 1024;
const SHARED_BUCKET: &str = "*";

/// Janela deslizante de tentativas falhas por nome de usuário.
pub struct LoginLimiter {
    max_attempts: usize,
    window: Duration,
    failures: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl LoginLimiter {
    pub fn new(max_attempts: u32, window: Duration) -> Self {
        Self {
            max_attempts: max_attempts.max(1) as usize,
            window,
            failures: Mutex::new(HashMap::new()),
        }
    }

    fn expire(&self, queue: &mut VecDeque<Instant>, now: Instant) {
        while queue
            .front()
            .is_some_and(|t| now.duration_since(*t) >= self.window)
        {
            queue.pop_front();
        }
    }

    fn bucket<'a>(map: &HashMap<String, VecDeque<Instant>>, key: &'a str) -> &'a str {
        if map.contains_key(key) || map.len() < MAX_TRACKED_USERS {
            key
        } else {
            SHARED_BUCKET
        }
    }

    /// Tempo restante de bloqueio enquanto o limite do `key` (nome normalizado) estiver estourado.
    pub fn blocked_for(&self, key: &str) -> Option<Duration> {
        let mut map = self.failures.lock().unwrap();
        let now = Instant::now();
        let key = Self::bucket(&map, key).to_owned();
        let queue = map.get_mut(&key)?;
        self.expire(queue, now);
        if queue.is_empty() {
            map.remove(&key);
            return None;
        }
        (queue.len() >= self.max_attempts).then(|| {
            self.window
                .saturating_sub(now.duration_since(*queue.front().unwrap()))
        })
    }

    pub fn record_failure(&self, key: &str) {
        let mut map = self.failures.lock().unwrap();
        let now = Instant::now();
        if map.len() >= MAX_TRACKED_USERS {
            map.retain(|_, queue| {
                self.expire(queue, now);
                !queue.is_empty()
            });
        }
        let key = Self::bucket(&map, key).to_owned();
        map.entry(key).or_default().push_back(now);
    }

    pub fn reset(&self, key: &str) {
        self.failures.lock().unwrap().remove(key);
    }
}

pub struct AuthConfig {
    /// Nome do master (do ambiente), comparado sem diferenciar maiúsculas.
    pub master_username: String,
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

/// Quem está autenticado na requisição, colocado nas extensions pelo middleware.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub username: String,
    pub role: Role,
}

impl Principal {
    fn from_owner(owner: SessionOwner, master_username: &str) -> Self {
        match owner {
            SessionOwner::Master => Self {
                username: master_username.to_owned(),
                role: Role::Master,
            },
            SessionOwner::User { username, role } => Self { username, role },
        }
    }
}

/// Exige sessão em todas as rotas `/api`, exceto login/logout, e aplica o papel mínimo
/// da rota (`permissions::required_role`): sem sessão `401`, papel insuficiente `403`.
pub async fn require_session(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    // Dentro de `nest("/api")` o caminho chega sem o prefixo.
    let is_session = path == "/session" || path == "/api/session";
    let public = is_session && matches!(*request.method(), Method::POST | Method::DELETE);
    if public {
        return next.run(request).await;
    }
    let owner = match session_from(request.headers()) {
        Some(id) => state
            .sessions
            .resolve(&hash_session(&id), state.clock.now())
            .await
            .ok()
            .flatten(),
        None => None,
    };
    let Some(owner) = owner else {
        return ApiError::unauthorized().into_response();
    };
    let principal = Principal::from_owner(owner, &state.auth.master_username);
    let required = permissions::required_role(request.method(), path);
    if !principal.role.allows(required) {
        tracing::warn!(user = %principal.username, role = %principal.role, %required, "acesso negado por papel");
        return ApiError::forbidden().into_response();
    }
    request.extensions_mut().insert(principal);
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
        assert!(limiter.blocked_for("ana").is_none());
        limiter.record_failure("ana");
        assert!(limiter.blocked_for("ana").is_none());
        limiter.record_failure("ana");
        assert!(limiter.blocked_for("ana").unwrap() <= Duration::from_secs(60));
        limiter.reset("ana");
        assert!(limiter.blocked_for("ana").is_none());
    }

    #[test]
    fn limite_e_por_usuario() {
        let limiter = LoginLimiter::new(1, Duration::from_secs(60));
        limiter.record_failure("ana");
        assert!(limiter.blocked_for("ana").is_some());
        assert!(limiter.blocked_for("bia").is_none());
    }

    #[test]
    fn nomes_demais_dividem_um_balde() {
        let limiter = LoginLimiter::new(1, Duration::from_secs(60));
        for n in 0..MAX_TRACKED_USERS {
            limiter.record_failure(&format!("u{n}"));
        }
        limiter.record_failure("novo");
        assert!(limiter.failures.lock().unwrap().len() <= MAX_TRACKED_USERS + 1);
        assert!(limiter.blocked_for("outro-novo").is_some());
    }

    #[test]
    fn hasher_argon2_confere_senha() {
        let hasher = Argon2Hasher::new();
        let hash = hasher.hash("senha-forte").unwrap();
        assert!(hasher.verify("senha-forte", &hash));
        assert!(!hasher.verify("outra", &hash));
        hasher.verify_dummy("qualquer");
    }

    #[test]
    fn cookie_de_sessao() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "a=1; rm_session=xyz; b=2".parse().unwrap());
        assert_eq!(session_from(&headers).as_deref(), Some("xyz"));
        let config = AuthConfig {
            master_username: "chefe".into(),
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
