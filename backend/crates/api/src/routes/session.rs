//! Login, logout e sessão atual.

use axum::Extension;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use domain::user::key_of;
use serde::Deserialize;
use serde_json::json;

use super::util::Body;
use crate::AppState;
use crate::auth::{
    Principal, clear_cookie, hash_session, new_session_id, session_cookie, session_from,
};
use crate::error::{ApiError, ApiResult};

#[derive(Deserialize)]
pub struct Login {
    username: String,
    password: String,
}

pub async fn login(State(state): State<AppState>, body: Body<Login>) -> ApiResult<Response> {
    let auth = &state.auth;
    let Json(login) = body?;
    let key = key_of(&login.username);
    if let Some(wait) = auth.limiter.blocked_for(&key) {
        let mut response = ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
            "muitas tentativas de login; aguarde e tente novamente",
        )
        .into_response();
        if let Ok(value) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return Ok(response);
    }
    // `Some(None)` = master; `Some(Some(id))` = usuário cadastrado.
    let user_id = if key == key_of(&auth.master_username) {
        auth.password.verify(&login.password).then_some(None)
    } else {
        state
            .users
            .authenticate(&login.username, &login.password)
            .await?
            .map(|user| Some(user.id))
    };
    let Some(user_id) = user_id else {
        auth.limiter.record_failure(&key);
        tracing::warn!(usuario = %key, "tentativa de login recusada");
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "usuário ou senha incorretos",
        ));
    };
    auth.limiter.reset(&key);
    let session = new_session_id();
    let now = state.clock.now();
    let ttl = chrono::Duration::from_std(auth.session_ttl).unwrap_or(chrono::Duration::hours(12));
    state
        .sessions
        .create(&hash_session(&session), user_id, now, now + ttl)
        .await
        .map_err(application::error::AppError::from)?;
    let _ = state.sessions.purge_expired(now).await;
    tracing::info!(usuario = %key, "login");
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&session_cookie(&session, auth)).expect("cookie ASCII"),
    );
    Ok(response)
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(session) = session_from(&headers) {
        state
            .sessions
            .delete(&hash_session(&session))
            .await
            .map_err(application::error::AppError::from)?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&clear_cookie(&state.auth)).expect("cookie ASCII"),
    );
    Ok(response)
}

pub async fn session(Extension(principal): Extension<Principal>) -> Json<serde_json::Value> {
    Json(json!({
        "authenticated": true,
        "username": principal.username,
        "role": principal.role,
    }))
}
