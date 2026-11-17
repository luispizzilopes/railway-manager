//! Composição do Railway Manager: configuração, wiring dos casos de uso e servidor HTTP.

pub mod config;

use std::sync::Arc;

use api::{AdminPassword, AppState, AuthConfig, LoginLimiter};
use application::credentials::CredentialService;
use application::dashboard::DashboardService;
use application::history::HistoryService;
use application::inventory::InventoryService;
use application::ports::{Clock, OperationRepository, SystemClock};
use application::power::{PowerConfig, PowerService};
use application::projects::ProjectService;
use application::railway::RailwayGateway;
use infrastructure::crypto::XChaChaCipher;
use infrastructure::railway::{RailwayClient, Transport, TransportConfig};
use infrastructure::sqlite::*;
use secrecy::ExposeSecret;
use sqlx::SqlitePool;

use config::Config;

/// Cliente Railway real a partir da configuração.
pub fn railway_client(config: &Config) -> Result<RailwayClient, String> {
    let r = &config.railway;
    let transport = Transport::new(TransportConfig {
        api_url: r.api_url.clone(),
        connect_timeout: r.connect_timeout,
        request_timeout: r.request_timeout,
        rps: r.rps,
        max_retries: r.max_retries,
        retry_base: std::time::Duration::from_millis(500),
    })
    .map_err(|e| e.to_string())?;
    Ok(RailwayClient::new(transport))
}

/// Monta todos os casos de uso sobre o banco e o gateway informados.
pub fn build_state(
    config: &Config,
    pool: SqlitePool,
    railway: Arc<dyn RailwayGateway>,
) -> AppState {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let master_key = config.master_key.as_ref().map(|k| *k.expose_secret());
    let credentials = Arc::new(CredentialService::new(
        Arc::new(SqliteCredentials::new(pool.clone())),
        Arc::new(XChaChaCipher::new(master_key.as_ref())),
        railway.clone(),
        clock.clone(),
    ));
    let projects_repo = Arc::new(SqliteProjects::new(pool.clone()));
    let inventory_repo = Arc::new(SqliteInventory::new(pool.clone()));
    let operations_repo = Arc::new(SqliteOperations::new(pool.clone()));
    let inventory = Arc::new(InventoryService::new(
        projects_repo.clone(),
        inventory_repo.clone(),
        credentials.clone(),
        railway.clone(),
        clock.clone(),
    ));
    let projects = Arc::new(ProjectService::new(
        projects_repo.clone(),
        inventory_repo.clone(),
        inventory.clone(),
        credentials.clone(),
        railway.clone(),
        clock.clone(),
    ));
    let o = &config.operations;
    let power = Arc::new(PowerService::new(
        inventory_repo.clone(),
        Arc::new(SqlitePlans::new(pool.clone())),
        operations_repo.clone(),
        credentials.clone(),
        railway.clone(),
        clock.clone(),
        PowerConfig {
            max_concurrency: o.max_concurrency,
            plan_ttl: o.plan_ttl,
            start_timeout: o.start_timeout,
            stop_timeout: o.stop_timeout,
            poll_interval: o.poll_interval,
            poll_max_interval: o.poll_max_interval,
            stop_mechanism: config.railway.stop_mechanism,
        },
    ));
    let history = Arc::new(HistoryService::new(operations_repo.clone()));
    let dashboard = Arc::new(DashboardService::new(
        projects_repo,
        inventory_repo,
        operations_repo,
        credentials.clone(),
        railway,
        clock.clone(),
        config.stale_after,
    ));
    let password = match &config.admin_password {
        config::AdminPassword::Hash(hash) => AdminPassword::Hash(hash.clone()),
        config::AdminPassword::Plain(plain) => {
            AdminPassword::Plain(plain.expose_secret().to_owned())
        }
    };
    AppState {
        credentials,
        projects,
        inventory,
        power,
        history,
        dashboard,
        sessions: Arc::new(SqliteSessions::new(pool)),
        clock,
        auth: Arc::new(AuthConfig {
            password,
            session_ttl: config.session_ttl,
            cookie_secure: config.cookie_secure,
            limiter: LoginLimiter::new(config.login_max_attempts, config.login_window),
        }),
    }
}

/// Recuperação após reinício: itens não finalizados viram `interrupted`.
pub async fn recover(pool: &SqlitePool) -> Result<u64, String> {
    SqliteOperations::new(pool.clone())
        .interrupt_unfinished(chrono::Utc::now())
        .await
        .map_err(|e| e.to_string())
}
