//! Montagem dos casos de uso com SQLite em memória e Railway falso.
#![allow(dead_code)]

use std::sync::Arc;

use application::credentials::{CredentialService, RegisterCredential};
use application::inventory::InventoryService;
use application::logs::LogsService;
use application::ports::{Clock, SystemClock};
use application::power::{PowerConfig, PowerService};
use application::projects::ProjectService;
use application::railway::RailwayToken;
use application::scheduled_actions::ScheduledActionService;
use application::schedules::{ScheduleService, SchedulerConfig, SchedulerService};
use application::testkit::FakeRailway;
use application::testkit::ManualClock;
use domain::credential::CredentialKind;
use infrastructure::crypto::XChaChaCipher;
use infrastructure::sqlite::*;
use sqlx::SqlitePool;

pub use application::testkit::rid;

pub const TOKEN: &str = "tok-de-teste-0123456789";

pub struct Harness {
    pub pool: SqlitePool,
    pub railway: Arc<FakeRailway>,
    pub credentials: Arc<CredentialService>,
    pub inventory: Arc<InventoryService>,
    pub projects: Arc<ProjectService>,
    pub power: Arc<PowerService>,
    pub schedules: Arc<ScheduleService>,
    pub actions: Arc<ScheduledActionService>,
    pub logs: Arc<LogsService>,
    pub scheduler: Arc<SchedulerService>,
    /// Presente quando o harness usa relógio manual.
    pub clock: Option<Arc<ManualClock>>,
}

pub async fn harness() -> Harness {
    harness_with_key(Some([9; 32])).await
}

pub async fn harness_with_key(key: Option<[u8; 32]>) -> Harness {
    let pool = connect("sqlite::memory:").await.unwrap();
    harness_on(pool, key).await
}

pub async fn harness_on(pool: SqlitePool, key: Option<[u8; 32]>) -> Harness {
    harness_full(pool, key, fast_power()).await
}

/// Intervalos e prazos curtos em tempo real (o relógio pausado do tokio não convive
/// com os timers internos do pool do sqlx).
pub fn fast_power() -> PowerConfig {
    PowerConfig {
        max_concurrency: 3,
        plan_ttl: std::time::Duration::from_secs(300),
        start_timeout: std::time::Duration::from_millis(800),
        stop_timeout: std::time::Duration::from_millis(800),
        poll_interval: std::time::Duration::from_millis(10),
        poll_max_interval: std::time::Duration::from_millis(30),
        stop_mechanism: domain::power::StopMechanism::Remove,
    }
}

pub async fn harness_with_power(config: PowerConfig) -> Harness {
    harness_full(
        connect("sqlite::memory:").await.unwrap(),
        Some([9; 32]),
        config,
    )
    .await
}

/// Harness com relógio manual (agendas e agendador).
pub async fn scheduling_harness(now: chrono::DateTime<chrono::Utc>) -> Harness {
    let manual = Arc::new(ManualClock::at(now));
    let pool = connect("sqlite::memory:").await.unwrap();
    let mut h = harness_with_clock(pool, Some([9; 32]), fast_power(), manual.clone()).await;
    h.clock = Some(manual);
    h
}

pub async fn harness_full(pool: SqlitePool, key: Option<[u8; 32]>, power: PowerConfig) -> Harness {
    harness_with_clock(pool, key, power, Arc::new(SystemClock)).await
}

pub async fn harness_with_clock(
    pool: SqlitePool,
    key: Option<[u8; 32]>,
    power: PowerConfig,
    clock: Arc<dyn Clock>,
) -> Harness {
    let railway = Arc::new(FakeRailway::new());
    railway.accept_token(TOKEN);
    let credentials = Arc::new(CredentialService::new(
        Arc::new(SqliteCredentials::new(pool.clone())),
        Arc::new(XChaChaCipher::new(key.as_ref())),
        railway.clone(),
        clock.clone(),
    ));
    let projects_repo = Arc::new(SqliteProjects::new(pool.clone()));
    let inventory_repo = Arc::new(SqliteInventory::new(pool.clone()));
    let inventory = Arc::new(InventoryService::new(
        projects_repo.clone(),
        inventory_repo.clone(),
        credentials.clone(),
        railway.clone(),
        clock.clone(),
    ));
    let projects = Arc::new(ProjectService::new(
        projects_repo,
        inventory_repo.clone(),
        inventory.clone(),
        credentials.clone(),
        railway.clone(),
        clock.clone(),
    ));
    let power = Arc::new(PowerService::new(
        inventory_repo.clone(),
        Arc::new(SqlitePlans::new(pool.clone())),
        Arc::new(SqliteOperations::new(pool.clone())),
        credentials.clone(),
        railway.clone(),
        clock.clone(),
        power,
    ));
    let schedule_repo = Arc::new(SqliteSchedules::new(pool.clone()));
    let runs = Arc::new(SqliteScheduleRuns::new(pool.clone()));
    let schedules = Arc::new(ScheduleService::new(
        schedule_repo.clone(),
        runs.clone(),
        Arc::new(SqliteProjects::new(pool.clone())),
        inventory_repo.clone(),
        clock.clone(),
        chrono_tz::UTC,
        std::time::Duration::from_secs(600),
    ));
    let actions = Arc::new(ScheduledActionService::new(
        Arc::new(SqliteScheduledActions::new(pool.clone())),
        Arc::new(SqliteProjects::new(pool.clone())),
        inventory_repo.clone(),
        clock.clone(),
        chrono_tz::UTC,
    ));
    let logs = Arc::new(LogsService::new(
        inventory_repo.clone(),
        credentials.clone(),
        railway.clone(),
    ));
    let scheduler = Arc::new(SchedulerService::new(
        schedules.clone(),
        actions.clone(),
        schedule_repo,
        runs,
        inventory_repo,
        credentials.clone(),
        power.clone(),
        clock,
        SchedulerConfig {
            tick: std::time::Duration::from_secs(30),
            catchup: std::time::Duration::from_secs(1800),
        },
    ));
    Harness {
        pool,
        railway,
        credentials,
        inventory,
        projects,
        power,
        schedules,
        actions,
        logs,
        scheduler,
        clock: None,
    }
}

impl Harness {
    /// Conta com um workspace e token de conta cadastrado.
    pub async fn with_account(&self) {
        self.railway
            .with_account("Ana", "ana@example.com", &[(900, "pessoal")]);
        self.credentials
            .register(RegisterCredential {
                kind: CredentialKind::Account,
                workspace_id: None,
                token: RailwayToken::new(TOKEN),
            })
            .await
            .unwrap();
    }

    /// Projeto `loja` (1) com production (10), staging (11) e serviços api (20), worker (21).
    pub fn seed_loja(&self) {
        self.railway
            .add_project(1, "loja", Some(900))
            .add_environment(1, 10, "production", false)
            .add_environment(1, 11, "staging", false)
            .add_environment(1, 12, "pr-7", true)
            .add_service(1, 20, "api")
            .add_service(1, 21, "worker")
            .add_running(1, 10, 20, 100)
            .add_stopped(1, 10, 21, 101)
            .add_running(1, 11, 20, 102);
    }
}
