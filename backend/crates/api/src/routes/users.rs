//! Usuários (somente master).

use application::users::{CreateUser, UpdateUser};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use domain::ids::UserId;
use domain::user::{Role, User};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::util::{Body, id};
use crate::AppState;
use crate::error::{ApiError, ApiResult};

#[derive(Serialize)]
struct UserDto {
    id: UserId,
    username: String,
    role: Role,
    is_active: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<User> for UserDto {
    fn from(user: User) -> Self {
        Self {
            id: user.id,
            username: user.username.to_string(),
            role: user.role,
            is_active: user.is_active,
            created_at: user.created_at,
            updated_at: user.updated_at,
        }
    }
}

fn role_of(raw: &str) -> ApiResult<Role> {
    raw.parse()
        .map_err(|e: domain::user::InvalidRole| ApiError::bad_request(e.to_string()))
}

pub async fn list_users(State(state): State<AppState>) -> ApiResult<Response> {
    let users: Vec<UserDto> = state
        .users
        .list()
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(json!({ "users": users })).into_response())
}

#[derive(Deserialize)]
pub struct CreateUserInput {
    username: String,
    password: String,
    role: String,
}

pub async fn create_user(
    State(state): State<AppState>,
    body: Body<CreateUserInput>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let user = state
        .users
        .create(CreateUser {
            username: input.username,
            password: input.password,
            role: role_of(&input.role)?,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(UserDto::from(user))).into_response())
}

#[derive(Deserialize)]
pub struct UpdateUserInput {
    role: Option<String>,
    is_active: Option<bool>,
}

pub async fn update_user(
    State(state): State<AppState>,
    Path(user): Path<String>,
    body: Body<UpdateUserInput>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    let role = input.role.as_deref().map(role_of).transpose()?;
    let user = state
        .users
        .update(
            id::<UserId>(&user)?,
            UpdateUser {
                role,
                is_active: input.is_active,
            },
        )
        .await?;
    Ok(Json(UserDto::from(user)).into_response())
}

#[derive(Deserialize)]
pub struct PasswordInput {
    password: String,
}

pub async fn set_user_password(
    State(state): State<AppState>,
    Path(user): Path<String>,
    body: Body<PasswordInput>,
) -> ApiResult<Response> {
    let Json(input) = body?;
    state
        .users
        .set_password(id::<UserId>(&user)?, &input.password)
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn delete_user(
    State(state): State<AppState>,
    Path(user): Path<String>,
) -> ApiResult<Response> {
    state.users.delete(id::<UserId>(&user)?).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
