//! Montagem dos casos de uso com SQLite em memória e Railway falso.
#![allow(dead_code)]

use std::sync::Arc;

use application::credentials::{CredentialService, RegisterCredential};
use application::inventory::InventoryService;
use application::ports::SystemClock;
use application::power::{PowerConfig, PowerService};
use application::projects::ProjectService;
use application::railway::RailwayToken;
use application::testkit::FakeRailway;
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

pub async fn harness_full(pool: SqlitePool, key: Option<[u8; 32]>, power: PowerConfig) -> Harness {
    let railway = Arc::new(FakeRailway::new());
    railway.accept_token(TOKEN);
    let clock = Arc::new(SystemClock);
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
        inventory_repo,
        Arc::new(SqlitePlans::new(pool.clone())),
        Arc::new(SqliteOperations::new(pool.clone())),
        credentials.clone(),
        railway.clone(),
        clock,
        power,
    ));
    Harness {
        pool,
        railway,
        credentials,
        inventory,
        projects,
        power,
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
