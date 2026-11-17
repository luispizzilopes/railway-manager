//! Formato único de erro HTTP: `{ code, message, details? }`.

use application::error::AppError;
use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "validation", message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "autenticação necessária",
        )
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

impl From<AppError> for ApiError {
    fn from(err: AppError) -> Self {
        use StatusCode as S;
        let message = err.to_string();
        let (status, code) = match &err {
            AppError::Validation(_) => (S::BAD_REQUEST, "validation"),
            AppError::Unprocessable(_) => (S::UNPROCESSABLE_ENTITY, "unprocessable"),
            AppError::NotFound(_) => (S::NOT_FOUND, "not_found"),
            AppError::Conflict(_) => (S::CONFLICT, "conflict"),
            AppError::PlanAlreadyUsed(_) => (S::CONFLICT, "plan_already_used"),
            AppError::Gone(_) => (S::GONE, "plan_expired"),
            AppError::IntegrationNotConfigured => (S::CONFLICT, "integration_not_configured"),
            AppError::CredentialInvalid => (S::CONFLICT, "credential_invalid"),
            AppError::CredentialUndecipherable => (S::CONFLICT, "credential_undecipherable"),
            AppError::RailwayUnavailable(_) => (S::SERVICE_UNAVAILABLE, "railway_unavailable"),
            AppError::RateLimited(_) => (S::TOO_MANY_REQUESTS, "rate_limited"),
            AppError::Railway(_) => (S::BAD_GATEWAY, "railway_error"),
            AppError::Internal(_) => (S::INTERNAL_SERVER_ERROR, "internal"),
        };
        let details = match &err {
            AppError::PlanAlreadyUsed(Some(id)) => Some(json!({ "operation_id": id })),
            AppError::RateLimited(secs) => Some(json!({ "retry_after_secs": secs })),
            _ => None,
        };
        if status.is_server_error() {
            tracing::error!(code, %message, "erro ao atender requisição");
        }
        // Detalhes internos ficam no log, não na resposta.
        let message = if matches!(err, AppError::Internal(_)) {
            "erro interno".into()
        } else {
            message
        };
        Self {
            status,
            code,
            message,
            details,
        }
    }
}

impl From<JsonRejection> for ApiError {
    fn from(rejection: JsonRejection) -> Self {
        Self::bad_request(format!("corpo inválido: {}", rejection.body_text()))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "code": self.code, "message": self.message });
        if let Some(details) = self.details {
            body["details"] = details;
        }
        (self.status, Json(body)).into_response()
    }
}
