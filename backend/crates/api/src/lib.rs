//! Camada HTTP (Axum): rotas, DTOs, sessão e erros.

pub mod auth;
pub mod error;
mod routes;

use std::path::Path;
use std::sync::Arc;

use application::credentials::CredentialService;
use application::dashboard::DashboardService;
use application::history::HistoryService;
use application::inventory::InventoryService;
use application::ports::{Clock, SessionRepository};
use application::power::PowerService;
use application::projects::ProjectService;
use axum::Router;
use axum::middleware::from_fn;
use axum::middleware::from_fn_with_state;
use axum::routing::{delete, get, post};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

pub use auth::{AdminPassword, AuthConfig, LoginLimiter, hash_password};

#[derive(Clone)]
pub struct AppState {
    pub credentials: Arc<CredentialService>,
    pub projects: Arc<ProjectService>,
    pub inventory: Arc<InventoryService>,
    pub power: Arc<PowerService>,
    pub history: Arc<HistoryService>,
    pub dashboard: Arc<DashboardService>,
    pub sessions: Arc<dyn SessionRepository>,
    pub clock: Arc<dyn Clock>,
    pub auth: Arc<AuthConfig>,
}

/// Rotas `/api` (todas protegidas, exceto login/logout).
fn api(state: AppState) -> Router<AppState> {
    use routes::*;
    Router::new()
        .route("/session", get(session).post(login).delete(logout))
        .route(
            "/credential",
            get(get_credential)
                .put(put_credential)
                .delete(delete_credential),
        )
        .route("/railway/projects", get(discover_projects))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/import", post(import_projects))
        .route(
            "/projects/{id}",
            get(get_project).patch(edit_project).delete(delete_project),
        )
        .route("/projects/{id}/sync", post(sync_project))
        .route("/projects/{id}/environments", get(list_environments))
        .route("/projects/{id}/railway-instances", get(discover_instances))
        .route(
            "/projects/{id}/instances",
            get(list_instances).post(associate_instance),
        )
        .route("/projects/{id}/instances/import", post(import_instances))
        .route("/instances/{id}", delete(delete_instance))
        .route("/services/{id}", delete(delete_service))
        .route("/operations/plan", post(plan_operation))
        .route("/operations", post(execute_operation))
        .route("/operations/{id}", get(get_operation))
        .route("/history", get(history))
        .route("/dashboard", get(dashboard))
        .route("/dashboard/refresh", post(refresh))
        .fallback(api_not_found)
        .layer(from_fn_with_state(state, auth::require_session))
        .layer(from_fn(auth::require_json))
}

/// Aplicação completa. Com `frontend_dir`, serve o build estático com fallback SPA.
pub fn router(state: AppState, frontend_dir: Option<&Path>) -> Router {
    let mut app = Router::new()
        .route("/healthz", get(routes::healthz))
        .nest("/api", api(state.clone()))
        .with_state(state)
        .layer(TraceLayer::new_for_http());
    if let Some(dir) = frontend_dir {
        let spa = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
        app = app.fallback_service(spa);
    }
    app
}
