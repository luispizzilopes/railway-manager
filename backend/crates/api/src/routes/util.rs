//! Auxiliares compartilhados pelos handlers.

use std::str::FromStr;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use chrono::{DateTime, NaiveDate, Utc};

use crate::error::{ApiError, ApiResult};

pub(super) type Body<T> = Result<Json<T>, JsonRejection>;

pub(super) fn id<T: FromStr>(raw: &str) -> ApiResult<T> {
    raw.parse()
        .map_err(|_| ApiError::not_found("recurso não encontrado"))
}

pub(super) fn parse<T: FromStr>(field: &str, raw: &str) -> ApiResult<T> {
    raw.parse()
        .map_err(|_| ApiError::bad_request(format!("{field} inválido: '{raw}'")))
}

/// Aceita RFC 3339 ou `AAAA-MM-DD` (início do dia; `to` vai até o fim do dia).
pub(super) fn date(field: &str, raw: &str, end_of_day: bool) -> ApiResult<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Ok(dt.to_utc());
    }
    let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| ApiError::bad_request(format!("{field} inválida: '{raw}'")))?;
    let time = if end_of_day {
        day.and_hms_milli_opt(23, 59, 59, 999)
    } else {
        day.and_hms_opt(0, 0, 0)
    };
    Ok(time.expect("hora válida").and_utc())
}

pub(super) fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}
