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
use application::logs::LogsService;
use application::ports::{Clock, SessionRepository};
use application::power::PowerService;
use application::projects::ProjectService;
use application::scheduled_actions::ScheduledActionService;
use application::schedules::{ScheduleService, SchedulerService};
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
    pub schedules: Arc<ScheduleService>,
    pub scheduled_actions: Arc<ScheduledActionService>,
    pub logs: Arc<LogsService>,
    pub scheduler: Arc<SchedulerService>,
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
        .route("/instances/{id}/logs", get(instance_logs))
        .route("/instances/{id}/deployments", get(instance_deployments))
        .route("/services/{id}", delete(delete_service))
        .route("/operations/plan", post(plan_operation))
        .route("/operations", post(execute_operation))
        .route("/operations/{id}", get(get_operation))
        .route("/history", get(history))
        .route("/schedules", get(list_schedules).post(create_schedule))
        .route(
            "/schedules/{id}",
            get(get_schedule)
                .put(update_schedule)
                .delete(delete_schedule),
        )
        .route("/schedules/{id}/pause", post(pause_schedule))
        .route("/schedules/{id}/resume", post(resume_schedule))
        .route("/schedules/{id}/runs", get(schedule_runs))
        .route(
            "/scheduled-actions",
            get(list_scheduled_actions).post(create_scheduled_action),
        )
        .route("/scheduled-actions/{id}", get(get_scheduled_action))
        .route(
            "/scheduled-actions/{id}/cancel",
            post(cancel_scheduled_action),
        )
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
