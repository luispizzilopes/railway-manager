//! Porta de saída para a API do Railway. Lista fechada de operações: não existe
//! método genérico de execução de query.

use std::fmt;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::deployment::Deployment;
use domain::ids::{
    RailwayDeploymentId, RailwayEnvironmentId, RailwayProjectId, RailwayServiceId,
    RailwayWorkspaceId,
};
use domain::logs::{LogLine, LogQuery};
use domain::power::{DeploymentRecord, StopMechanism};
use domain::state::InstanceSnapshot;
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;

/// Token Railway em memória. `Debug` não revela o valor.
#[derive(Clone)]
pub struct RailwayToken(SecretString);

impl RailwayToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self(SecretString::from(value.into()))
    }

    pub fn expose(&self) -> &str {
        self.0.expose_secret()
    }
}

impl fmt::Debug for RailwayToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RailwayToken([REDACTED])")
    }
}

/// Classificação de falhas da integração (spec `railway-api-integration`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RailwayError {
    #[error("token inválido ou sem permissão no Railway")]
    Unauthorized,
    #[error("recurso não encontrado no Railway: {0}")]
    NotFound(String),
    #[error("requisição rejeitada pelo Railway: {0}")]
    Validation(String),
    #[error("rate limit do Railway atingido; tente novamente em {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    #[error("Railway indisponível: {0}")]
    Unavailable(String),
    /// Mutation enviada sem resposta conclusiva (timeout): não deve ser reenviada.
    #[error("resultado incerto: o Railway não respondeu a tempo à {0}")]
    Uncertain(String),
    #[error("erro inesperado do Railway: {0}")]
    Unknown(String),
}

impl RailwayError {
    pub fn is_auth(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }
}

pub type RailwayResult<T> = Result<T, RailwayError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceInfo {
    pub id: RailwayWorkspaceId,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub name: Option<String>,
    pub email: String,
    pub workspaces: Vec<WorkspaceInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RailwayProject {
    pub id: RailwayProjectId,
    pub name: String,
    pub description: Option<String>,
    pub workspace_id: Option<RailwayWorkspaceId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RailwayEnvironment {
    pub id: RailwayEnvironmentId,
    pub name: String,
    pub is_ephemeral: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RailwayService {
    pub id: RailwayServiceId,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailwayProjectDetail {
    pub project: RailwayProject,
    pub environments: Vec<RailwayEnvironment>,
    pub services: Vec<RailwayService>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailwayServiceInstance {
    pub service_id: RailwayServiceId,
    pub service_name: String,
    pub environment_id: RailwayEnvironmentId,
    pub snapshot: InstanceSnapshot,
}

/// Estado da cota exposto ao dashboard.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RateLimitStatus {
    pub paused_until: Option<DateTime<Utc>>,
    pub remaining: Option<u64>,
    pub limit: Option<u64>,
}

#[async_trait]
pub trait RailwayGateway: Send + Sync {
    /// Valida token de conta (`me`).
    async fn me(&self, token: &RailwayToken) -> RailwayResult<AccountInfo>;

    /// Valida token de workspace (`workspace(workspaceId)`).
    async fn workspace(
        &self,
        token: &RailwayToken,
        id: &RailwayWorkspaceId,
    ) -> RailwayResult<WorkspaceInfo>;

    /// Todos os projetos não excluídos (todas as páginas) do workspace informado
    /// ou, sem workspace, os acessíveis pelo token.
    async fn list_projects(
        &self,
        token: &RailwayToken,
        workspace: Option<&RailwayWorkspaceId>,
    ) -> RailwayResult<Vec<RailwayProject>>;

    /// Projeto com ambientes e serviços; `None` se não existe ou foi excluído.
    async fn get_project(
        &self,
        token: &RailwayToken,
        id: &RailwayProjectId,
    ) -> RailwayResult<Option<RailwayProjectDetail>>;

    /// Instâncias de um ambiente (uma chamada cobre todas); `None` se o ambiente não existe.
    async fn list_service_instances(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
    ) -> RailwayResult<Option<Vec<RailwayServiceInstance>>>;

    async fn get_service_instance(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
        service: &RailwayServiceId,
    ) -> RailwayResult<Option<RailwayServiceInstance>>;

    /// Deployment a reaproveitar para iniciar: o último commit que subiu, escolhido no
    /// histórico do serviço (inclui `REMOVED`, que `latestDeployment` omite) pela regra
    /// `domain::power::restart_source`.
    async fn restart_source(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
        service: &RailwayServiceId,
    ) -> RailwayResult<Option<Deployment>>;

    async fn get_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
    ) -> RailwayResult<Option<Deployment>>;

    /// `deploymentRemove` ou `deploymentStop`, conforme o mecanismo. Nunca é repetida.
    async fn stop_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
        mechanism: StopMechanism,
    ) -> RailwayResult<()>;

    /// `deploymentRedeploy(usePreviousImageTag: true)`; retorna o novo deployment.
    async fn redeploy_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
    ) -> RailwayResult<Deployment>;

    /// Deployments recentes do serviço no ambiente (inclui `REMOVED`), do mais novo
    /// para o mais antigo. Somente leitura.
    async fn recent_deployments(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
        service: &RailwayServiceId,
        first: u32,
    ) -> RailwayResult<Vec<DeploymentRecord>>;

    /// Logs de runtime do deployment, em ordem cronológica crescente. Somente leitura.
    async fn deployment_logs(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
        query: &LogQuery,
    ) -> RailwayResult<Vec<LogLine>>;

    /// Logs de build do deployment, em ordem cronológica crescente. Somente leitura.
    async fn build_logs(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
        query: &LogQuery,
    ) -> RailwayResult<Vec<LogLine>>;

    fn rate_limit_status(&self) -> RateLimitStatus;
}
