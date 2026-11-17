//! Portas de persistência, criptografia e relógio.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::catalog::{Environment, Project, Service, ServiceInstance};
use domain::credential::{CredentialMetadata, CredentialStatus};
use domain::deployment::DeploymentStatus;
use domain::ids::{
    CredentialId, EnvironmentId, OperationId, PlanId, ProjectId, RailwayDeploymentId,
    RailwayEnvironmentId, RailwayProjectId, RailwayServiceId, ServiceId, ServiceInstanceId,
};
use domain::operation::{
    ItemResult, Operation, OperationItem, OperationScope, OperationStatus, Plan,
};
use domain::power::PowerKind;
use domain::state::ObservedState;
use serde::Serialize;

use crate::railway::RailwayToken;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RepoError {
    #[error("conflito: {0}")]
    Conflict(String),
    #[error("registro não encontrado")]
    NotFound,
    #[error("erro de banco de dados: {0}")]
    Database(String),
}

pub type RepoResult<T> = Result<T, RepoError>;

pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Token cifrado como gravado no banco.
#[derive(Clone, PartialEq, Eq)]
pub struct SealedSecret {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub key_version: i64,
}

impl std::fmt::Debug for SealedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealedSecret")
            .field("key_version", &self.key_version)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CipherError {
    #[error("chave mestra não configurada")]
    MissingKey,
    #[error("credencial indecifrável com a chave mestra atual")]
    Undecipherable,
    #[error("falha ao cifrar a credencial")]
    Encrypt,
}

pub trait CredentialCipher: Send + Sync {
    fn seal(&self, id: CredentialId, token: &RailwayToken) -> Result<SealedSecret, CipherError>;
    fn open(&self, id: CredentialId, sealed: &SealedSecret) -> Result<RailwayToken, CipherError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCredential {
    pub metadata: CredentialMetadata,
    pub sealed: SealedSecret,
}

#[async_trait]
pub trait CredentialRepository: Send + Sync {
    async fn get(&self) -> RepoResult<Option<StoredCredential>>;
    /// Substitui a credencial (há no máximo uma) e reatribui os projetos a ela.
    async fn replace(&self, credential: &StoredCredential) -> RepoResult<()>;
    /// Apaga o valor cifrado; projetos e histórico permanecem.
    async fn delete(&self) -> RepoResult<()>;
    async fn set_status(
        &self,
        id: CredentialId,
        status: CredentialStatus,
        validated_at: Option<DateTime<Utc>>,
    ) -> RepoResult<()>;
}

#[async_trait]
pub trait ProjectRepository: Send + Sync {
    /// `Conflict` se o Railway Project ID já estiver cadastrado.
    async fn insert(&self, project: &Project) -> RepoResult<()>;
    async fn get(&self, id: ProjectId) -> RepoResult<Option<Project>>;
    async fn find_by_railway_id(&self, id: &RailwayProjectId) -> RepoResult<Option<Project>>;
    async fn list(&self) -> RepoResult<Vec<Project>>;
    async fn update(&self, project: &Project) -> RepoResult<()>;
    /// Remove com cascata local; `Conflict` se houver item ativo em alguma instância.
    async fn delete(&self, id: ProjectId) -> RepoResult<()>;
}

/// Instância com o contexto necessário para exibir, planejar e auditar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstanceView {
    pub instance: ServiceInstance,
    pub project: Project,
    pub service: Service,
    pub environment: Environment,
}

/// Leitura atual de uma instância.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceObservation {
    pub state: ObservedState,
    pub not_found: bool,
    pub latest_deployment_id: Option<RailwayDeploymentId>,
    pub latest_deployment_status: Option<DeploymentStatus>,
    pub observed_at: DateTime<Utc>,
}

#[async_trait]
pub trait InventoryRepository: Send + Sync {
    /// Insere ou atualiza (por Railway ID) e retorna o registro local.
    async fn upsert_environment(&self, env: &Environment) -> RepoResult<Environment>;
    async fn upsert_service(&self, service: &Service) -> RepoResult<Service>;
    /// `Conflict` se o par serviço × ambiente já existir.
    async fn insert_instance(&self, instance: &ServiceInstance) -> RepoResult<()>;

    async fn list_environments(&self, project: ProjectId) -> RepoResult<Vec<Environment>>;
    async fn list_services(&self, project: ProjectId) -> RepoResult<Vec<Service>>;
    async fn find_environment(
        &self,
        project: ProjectId,
        id: &RailwayEnvironmentId,
    ) -> RepoResult<Option<Environment>>;
    async fn find_service(
        &self,
        project: ProjectId,
        id: &RailwayServiceId,
    ) -> RepoResult<Option<Service>>;

    async fn list_instances(&self, project: Option<ProjectId>) -> RepoResult<Vec<InstanceView>>;
    async fn get_instance(&self, id: ServiceInstanceId) -> RepoResult<Option<InstanceView>>;

    /// `Conflict` se houver item ativo sobre a instância.
    async fn delete_instance(&self, id: ServiceInstanceId) -> RepoResult<()>;
    /// Remove o serviço e suas instâncias; `Conflict` se alguma estiver em operação.
    async fn delete_service(&self, id: ServiceId) -> RepoResult<()>;
    async fn rename_environment(&self, id: EnvironmentId, name: &str) -> RepoResult<()>;
    async fn rename_service(&self, id: ServiceId, name: &str) -> RepoResult<()>;

    async fn record_observation(
        &self,
        id: ServiceInstanceId,
        observation: &InstanceObservation,
    ) -> RepoResult<()>;
    /// Mantém o último estado e marca a tentativa como falha (frescor `unavailable`).
    async fn record_sync_error(&self, ids: &[ServiceInstanceId], error: &str) -> RepoResult<()>;
}

/// Situação de um plano ao ser consumido.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsumeOutcome {
    Created {
        operation_id: OperationId,
        conflicts: Vec<ServiceInstanceId>,
    },
    NotFound,
    Expired,
    AlreadyConsumed {
        operation_id: Option<OperationId>,
    },
    /// Operação individual em conflito com outra ativa: nada foi criado.
    Conflict,
}

#[async_trait]
pub trait PlanRepository: Send + Sync {
    async fn save(&self, plan: &Plan) -> RepoResult<()>;
    async fn get(&self, id: PlanId) -> RepoResult<Option<Plan>>;
    /// Consome o plano e cria operação e itens numa única transação.
    /// Itens em conflito com operação ativa viram `skipped` ("operação em andamento"),
    /// exceto em escopo `instance`, que é recusado por inteiro.
    async fn consume(
        &self,
        plan_id: PlanId,
        now: DateTime<Utc>,
        operation: &Operation,
        items: &[OperationItem],
    ) -> RepoResult<ConsumeOutcome>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryFilter {
    pub railway_project_id: Option<RailwayProjectId>,
    pub railway_service_id: Option<RailwayServiceId>,
    pub environment_name: Option<String>,
    pub kind: Option<PowerKind>,
    pub result: Option<ItemResult>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub page: u32,
    pub per_page: u32,
}

/// Item do histórico com os dados da operação.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryEntry {
    pub item: OperationItem,
    pub kind: PowerKind,
    pub scope: OperationScope,
    pub requested_by: String,
    pub operation_status: OperationStatus,
    pub created_at: DateTime<Utc>,
}

#[async_trait]
pub trait OperationRepository: Send + Sync {
    async fn get(&self, id: OperationId) -> RepoResult<Option<(Operation, Vec<OperationItem>)>>;
    async fn find_by_plan(&self, plan: PlanId) -> RepoResult<Option<OperationId>>;
    async fn update_item(&self, item: &OperationItem) -> RepoResult<()>;
    async fn update_status(
        &self,
        id: OperationId,
        status: OperationStatus,
        started_at: Option<DateTime<Utc>>,
        finished_at: Option<DateTime<Utc>>,
    ) -> RepoResult<()>;
    /// Itens `pending|running|verifying` → `interrupted` e operações finalizadas.
    async fn interrupt_unfinished(&self, now: DateTime<Utc>) -> RepoResult<u64>;
    async fn history(
        &self,
        filter: &HistoryFilter,
        page: u32,
        per_page: u32,
    ) -> RepoResult<Page<HistoryEntry>>;
    async fn recent(&self, limit: u32) -> RepoResult<Vec<(Operation, Vec<OperationItem>)>>;
    async fn active_instance_ids(&self) -> RepoResult<Vec<ServiceInstanceId>>;
}

#[async_trait]
pub trait SessionRepository: Send + Sync {
    async fn create(
        &self,
        id_hash: &str,
        created_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> RepoResult<()>;
    async fn is_valid(&self, id_hash: &str, now: DateTime<Utc>) -> RepoResult<bool>;
    async fn delete(&self, id_hash: &str) -> RepoResult<()>;
    async fn purge_expired(&self, now: DateTime<Utc>) -> RepoResult<u64>;
}
