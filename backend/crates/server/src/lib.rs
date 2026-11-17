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
use application::schedules::{ScheduleService, SchedulerConfig, SchedulerService};
use infrastructure::crypto::XChaChaCipher;
use infrastructure::railway::{RailwayClient, Transport, TransportConfig};
use infrastructure::sqlite::*;
use secrecy::ExposeSecret;
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

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
    let schedule_repo = Arc::new(SqliteSchedules::new(pool.clone()));
    let schedule_runs = Arc::new(SqliteScheduleRuns::new(pool.clone()));
    let schedules = Arc::new(ScheduleService::new(
        schedule_repo.clone(),
        schedule_runs.clone(),
        projects_repo.clone(),
        inventory_repo.clone(),
        clock.clone(),
        config.scheduler.timezone,
        o.start_timeout,
    ));
    let scheduler = Arc::new(SchedulerService::new(
        schedules.clone(),
        schedule_repo,
        schedule_runs,
        inventory_repo.clone(),
        credentials.clone(),
        power.clone(),
        clock.clone(),
        SchedulerConfig {
            tick: config.scheduler.tick,
            catchup: config.scheduler.catchup,
        },
    ));
    let history = Arc::new(HistoryService::new(operations_repo.clone()));
    let dashboard = Arc::new(DashboardService::new(
        projects_repo,
        inventory_repo,
        operations_repo,
        credentials.clone(),
        railway,
        schedules.clone(),
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
        schedules,
        scheduler,
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

/// Agendador em segundo plano: marca eventos órfãos ao subir e avalia as agendas a
/// cada `RM_SCHEDULER_TICK_SECS`. Erros de um ciclo são registrados e o próximo segue.
pub fn spawn_scheduler(scheduler: Arc<SchedulerService>, clock: Arc<dyn Clock>) -> JoinHandle<()> {
    tokio::spawn(async move {
        match scheduler.startup().await {
            Ok(0) => {}
            Ok(n) => tracing::warn!(
                n,
                "eventos de agenda interrompidos por reinício marcados como falhos"
            ),
            Err(err) => tracing::error!(%err, "falha ao preparar o agendador"),
        }
        let mut interval = tokio::time::interval(scheduler.config().tick);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(err) = scheduler.tick(clock.now()).await {
                tracing::error!(%err, "falha no ciclo do agendador");
            }
        }
    })
}
