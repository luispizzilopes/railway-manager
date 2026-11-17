//! Transporte HTTP das operações GraphQL: autenticação, timeouts, rate limit,
//! classificação de erros e retry (só para queries).

use std::sync::Arc;
use std::time::{Duration, Instant};

use application::railway::{RailwayError, RailwayResult, RailwayToken, RateLimitStatus};
use graphql_client::{GraphQLQuery, QueryBody, Response};
use reqwest::header::{HeaderMap, RETRY_AFTER};
use reqwest::{Client, StatusCode};
use serde_json::Value;

use super::rate_limit::RateLimiter;

#[derive(Debug, Clone)]
pub struct TransportConfig {
    pub api_url: String,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub rps: u32,
    /// Novas tentativas de uma query após a primeira.
    pub max_retries: u32,
    /// Base do backoff exponencial (com jitter).
    pub retry_base: Duration,
}

impl TransportConfig {
    pub fn new(api_url: impl Into<String>) -> Self {
        Self {
            api_url: api_url.into(),
            connect_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(20),
            rps: 5,
            max_retries: 3,
            retry_base: Duration::from_millis(500),
        }
    }
}

const RETRY_CAP: Duration = Duration::from_secs(8);
const MESSAGE_MAX: usize = 300;
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct Transport {
    http: Client,
    config: Arc<TransportConfig>,
    limiter: Arc<RateLimiter>,
}

impl Transport {
    pub fn new(config: TransportConfig) -> RailwayResult<Self> {
        let http = Client::builder()
            .connect_timeout(config.connect_timeout)
            .timeout(config.request_timeout)
            .user_agent(concat!("railway-manager/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| RailwayError::Unknown(format!("cliente HTTP: {e}")))?;
        Ok(Self {
            http,
            limiter: Arc::new(RateLimiter::new(config.rps)),
            config: Arc::new(config),
        })
    }

    pub fn rate_limit_status(&self) -> RateLimitStatus {
        self.limiter.status()
    }

    /// Executa uma operação. Queries são repetidas em falhas transitórias;
    /// mutations são enviadas uma única vez.
    pub async fn execute<Q: GraphQLQuery>(
        &self,
        token: &RailwayToken,
        variables: Q::Variables,
    ) -> RailwayResult<Q::ResponseData> {
        let body = Q::build_query(variables);
        let is_mutation = body.query.trim_start().starts_with("mutation");
        let attempts = if is_mutation {
            1
        } else {
            self.config.max_retries + 1
        };

        let mut attempt = 0;
        loop {
            attempt += 1;
            let started = Instant::now();
            let result = self.send::<Q>(token, &body, is_mutation).await;
            let duration_ms = started.elapsed().as_millis() as u64;
            match &result {
                Ok(_) => tracing::info!(
                    operation = body.operation_name,
                    attempt,
                    duration_ms,
                    outcome = "ok",
                    "railway"
                ),
                Err(err) => tracing::warn!(
                    operation = body.operation_name,
                    attempt,
                    duration_ms,
                    outcome = outcome_label(err),
                    "railway"
                ),
            }
            match result {
                Err(err) if attempt < attempts && is_retryable(&err) => {
                    // Em 429 a espera vem do limitador (Retry-After); aqui só o backoff.
                    tokio::time::sleep(self.backoff(attempt)).await;
                }
                other => return other,
            }
        }
    }

    async fn send<Q: GraphQLQuery>(
        &self,
        token: &RailwayToken,
        body: &QueryBody<Q::Variables>,
        is_mutation: bool,
    ) -> RailwayResult<Q::ResponseData> {
        self.limiter.acquire().await;
        let sanitize = |msg: &str| sanitize(msg, token);

        let response = self
            .http
            .post(&self.config.api_url)
            .bearer_auth(token.expose())
            .json(body)
            .send()
            .await
            .map_err(|e| transport_error(&e, is_mutation, body.operation_name))?;

        let status = response.status();
        self.observe_quota(response.headers());

        if status == StatusCode::TOO_MANY_REQUESTS {
            let wait = retry_after(response.headers()).unwrap_or(DEFAULT_RETRY_AFTER);
            self.limiter.pause_for(wait);
            return Err(RailwayError::RateLimited {
                retry_after_secs: wait.as_secs().max(1),
            });
        }
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(RailwayError::Unauthorized);
        }
        if status.is_server_error() {
            return Err(RailwayError::Unavailable(format!(
                "HTTP {}",
                status.as_u16()
            )));
        }

        let text = response
            .text()
            .await
            .map_err(|e| transport_error(&e, is_mutation, body.operation_name))?;
        let parsed: Result<Response<Q::ResponseData>, _> = serde_json::from_str(&text);

        let Ok(parsed) = parsed else {
            return Err(if status == StatusCode::BAD_REQUEST {
                RailwayError::Validation("requisição inválida".into())
            } else {
                RailwayError::Unknown(format!("resposta inesperada (HTTP {})", status.as_u16()))
            });
        };

        if let Some(error) = parsed.errors.as_ref().and_then(|errors| errors.first()) {
            return Err(classify_graphql_error(error, status, &sanitize));
        }
        if !status.is_success() {
            return Err(RailwayError::Unknown(format!("HTTP {}", status.as_u16())));
        }
        parsed
            .data
            .ok_or_else(|| RailwayError::Unknown("resposta sem dados".into()))
    }

    fn observe_quota(&self, headers: &HeaderMap) {
        let number = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok())
        };
        let remaining = number("x-ratelimit-remaining");
        let limit = number("x-ratelimit-limit");
        let reset_in = number("x-ratelimit-reset").map(reset_delay);
        if remaining.is_some() || limit.is_some() {
            self.limiter.observe_quota(remaining, limit, reset_in);
        }
    }

    /// Backoff exponencial com jitter completo, limitado a `RETRY_CAP`.
    fn backoff(&self, attempt: u32) -> Duration {
        let exp = self
            .config
            .retry_base
            .saturating_mul(2u32.saturating_pow(attempt - 1));
        let ceiling = exp.min(RETRY_CAP).as_millis().max(1) as u64;
        Duration::from_millis(rand::random_range(ceiling / 2..=ceiling))
    }
}

/// `X-RateLimit-Reset` pode vir como epoch (segundos) ou como segundos restantes.
fn reset_delay(value: u64) -> Duration {
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    if value > 1_000_000_000 {
        Duration::from_secs(value.saturating_sub(now))
    } else {
        Duration::from_secs(value)
    }
}

fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    (at.with_timezone(&chrono::Utc) - chrono::Utc::now())
        .to_std()
        .ok()
}

fn is_retryable(err: &RailwayError) -> bool {
    matches!(
        err,
        RailwayError::Unavailable(_) | RailwayError::RateLimited { .. }
    )
}

fn outcome_label(err: &RailwayError) -> &'static str {
    match err {
        RailwayError::Unauthorized => "unauthorized",
        RailwayError::NotFound(_) => "not_found",
        RailwayError::Validation(_) => "validation",
        RailwayError::RateLimited { .. } => "rate_limited",
        RailwayError::Unavailable(_) => "unavailable",
        RailwayError::Uncertain(_) => "uncertain",
        RailwayError::Unknown(_) => "unknown",
    }
}

fn transport_error(err: &reqwest::Error, is_mutation: bool, operation: &str) -> RailwayError {
    // Sem conexão a requisição não saiu: nada foi aplicado, mesmo para mutations.
    if err.is_connect() {
        return RailwayError::Unavailable("falha de conexão".into());
    }
    if is_mutation {
        return RailwayError::Uncertain(operation.to_owned());
    }
    if err.is_timeout() {
        RailwayError::Unavailable("tempo esgotado".into())
    } else {
        RailwayError::Unavailable("falha de comunicação".into())
    }
}

fn classify_graphql_error(
    error: &graphql_client::Error,
    status: StatusCode,
    sanitize: &dyn Fn(&str) -> String,
) -> RailwayError {
    let message = sanitize(&error.message);
    let lower = error.message.to_lowercase();
    let code = error
        .extensions
        .as_ref()
        .and_then(|ext| ext.get("code"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_uppercase();

    if matches!(
        code.as_str(),
        "UNAUTHENTICATED" | "FORBIDDEN" | "UNAUTHORIZED"
    ) || lower.contains("not authorized")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
    {
        RailwayError::Unauthorized
    } else if code == "NOT_FOUND" || lower.contains("not found") {
        RailwayError::NotFound(message)
    } else if code == "RATE_LIMITED" || lower.contains("rate limit") {
        RailwayError::RateLimited {
            retry_after_secs: DEFAULT_RETRY_AFTER.as_secs(),
        }
    } else if status == StatusCode::BAD_REQUEST
        || matches!(
            code.as_str(),
            "BAD_USER_INPUT" | "GRAPHQL_VALIDATION_FAILED" | "GRAPHQL_PARSE_FAILED"
        )
    {
        RailwayError::Validation(message)
    } else {
        RailwayError::Unknown(message)
    }
}

/// Remove o token e limita o tamanho de mensagens repassadas ao usuário.
fn sanitize(message: &str, token: &RailwayToken) -> String {
    let secret = token.expose();
    let cleaned = if secret.is_empty() {
        message.to_owned()
    } else {
        message.replace(secret, "[REDACTED]")
    };
    let mut out: String = cleaned.chars().take(MESSAGE_MAX).collect();
    if cleaned.chars().count() > MESSAGE_MAX {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_remove_token_e_trunca() {
        let token = RailwayToken::new("tok-secreto");
        assert_eq!(
            sanitize("falhou com tok-secreto", &token),
            "falhou com [REDACTED]"
        );
        assert_eq!(
            sanitize(&"x".repeat(400), &token).chars().count(),
            MESSAGE_MAX + 1
        );
    }

    #[test]
    fn reset_aceita_epoch_e_delta() {
        assert_eq!(reset_delay(30), Duration::from_secs(30));
        let epoch = chrono::Utc::now().timestamp() as u64 + 90;
        let delay = reset_delay(epoch).as_secs();
        assert!((88..=90).contains(&delay), "{delay}");
    }
}
