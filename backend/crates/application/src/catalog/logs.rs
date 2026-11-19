//! Leitura dos logs de runtime e de build de uma instância gerenciada. Somente leitura:
//! nada é gravado no banco nem no histórico de operações.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use domain::deployment::DeploymentStatus;
use domain::ids::{RailwayDeploymentId, ServiceInstanceId};
use domain::logs::{LogLine, LogQuery, LogSeverity};
use domain::power::DeploymentRecord;
use serde::Serialize;

use crate::credentials::CredentialService;
use crate::error::{AppError, AppResult};
use crate::ports::InventoryRepository;
use crate::railway::RailwayGateway;

pub const DEFAULT_LIMIT: u32 = 200;
pub const MAX_LIMIT: u32 = 1000;
/// Deployments recentes oferecidos para escolha (e aceitos em `deployment_id`).
pub const RECENT_DEPLOYMENTS: u32 = 20;
/// Tamanho máximo do texto de busca.
const MAX_SEARCH_LEN: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LogKind {
    #[default]
    Runtime,
    Build,
}

impl LogKind {
    pub fn parse(raw: &str) -> AppResult<Self> {
        match raw {
            "runtime" => Ok(Self::Runtime),
            "build" => Ok(Self::Build),
            other => Err(AppError::Validation(format!(
                "tipo de log inválido: {other} (use runtime ou build)"
            ))),
        }
    }
}

/// Pedido como chega da API: valores crus, validados por `LogsService::read`.
#[derive(Debug, Clone, Default)]
pub struct LogsRequest {
    pub kind: LogKind,
    pub deployment_id: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub severities: Vec<LogSeverity>,
    pub search: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogsResponse {
    /// `None` quando a instância nunca teve deploy.
    pub deployment_id: Option<RailwayDeploymentId>,
    pub deployment_status: Option<DeploymentStatus>,
    /// O deploy lido é o mais recente da instância.
    pub is_current: bool,
    pub truncated: bool,
    pub lines: Vec<LogLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeploymentSummary {
    pub id: RailwayDeploymentId,
    pub status: DeploymentStatus,
    pub created_at: Option<DateTime<Utc>>,
    pub is_current: bool,
}

pub struct LogsService {
    inventory: Arc<dyn InventoryRepository>,
    credentials: Arc<CredentialService>,
    railway: Arc<dyn RailwayGateway>,
}

/// Parâmetros já validados.
struct Checked {
    query: LogQuery,
    severities: Vec<LogSeverity>,
    search: Option<String>,
}

fn parse_instant(name: &str, raw: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw.trim())
        .map(|d| d.to_utc())
        .map_err(|_| AppError::Validation(format!("{name} deve ser um instante ISO 8601: {raw}")))
}

fn check(request: &LogsRequest) -> AppResult<Checked> {
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(AppError::Validation(format!(
            "limit deve estar entre 1 e {MAX_LIMIT}"
        )));
    }
    let instant = |name: &str, raw: &Option<String>| {
        raw.as_deref()
            .filter(|r| !r.trim().is_empty())
            .map(|r| parse_instant(name, r))
            .transpose()
    };
    let start = instant("start", &request.start)?;
    let end = instant("end", &request.end)?;
    if let (Some(s), Some(e)) = (start, end)
        && s > e
    {
        return Err(AppError::Validation(
            "start não pode ser posterior a end".into(),
        ));
    }
    let search = request
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if search
        .as_ref()
        .is_some_and(|s| s.chars().count() > MAX_SEARCH_LEN)
    {
        return Err(AppError::Validation(format!(
            "q deve ter no máximo {MAX_SEARCH_LEN} caracteres"
        )));
    }
    let mut severities = request.severities.clone();
    severities.sort_by_key(|s| s.as_str());
    severities.dedup();
    Ok(Checked {
        query: LogQuery {
            start,
            end,
            filter: railway_filter(&severities, search.as_deref()),
            limit,
        },
        severities,
        search,
    })
}

/// Filtro na sintaxe de busca de logs do Railway (`@level:error`, `"texto"`).
fn railway_filter(severities: &[LogSeverity], search: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    if !severities.is_empty() {
        let levels: Vec<_> = severities
            .iter()
            .map(|s| format!("@level:{}", s.as_str()))
            .collect();
        parts.push(if levels.len() > 1 {
            format!("({})", levels.join(" OR "))
        } else {
            levels.join("")
        });
    }
    if let Some(text) = search {
        parts.push(format!("\"{}\"", text.replace(['"', '\\'], " ")));
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// Reaplica os filtros localmente: não dependemos da semântica exata do filtro do Railway.
fn keep(line: &LogLine, checked: &Checked) -> bool {
    if !checked.severities.is_empty()
        && !line
            .severity
            .is_some_and(|s| checked.severities.contains(&s))
    {
        return false;
    }
    match &checked.search {
        Some(text) => line.message.to_lowercase().contains(&text.to_lowercase()),
        None => true,
    }
}

/// Do mais novo para o mais antigo; sem data, mantém a ordem da API depois dos datados.
fn newest_first(mut records: Vec<DeploymentRecord>) -> Vec<DeploymentRecord> {
    records.sort_by_key(|r| std::cmp::Reverse(r.created_at));
    records
}

impl LogsService {
    pub fn new(
        inventory: Arc<dyn InventoryRepository>,
        credentials: Arc<CredentialService>,
        railway: Arc<dyn RailwayGateway>,
    ) -> Self {
        Self {
            inventory,
            credentials,
            railway,
        }
    }

    async fn recent(
        &self,
        instance: ServiceInstanceId,
    ) -> AppResult<(crate::credentials::ActiveCredential, Vec<DeploymentRecord>)> {
        let view = self
            .inventory
            .get_instance(instance)
            .await?
            .ok_or_else(|| AppError::NotFound("instância não encontrada".into()))?;
        let cred = self.credentials.active().await?;
        let result = self
            .railway
            .recent_deployments(
                &cred.token,
                &view.environment.railway_environment_id,
                &view.service.railway_service_id,
                RECENT_DEPLOYMENTS,
            )
            .await;
        let records = self.credentials.check(&cred, result).await?;
        Ok((cred, newest_first(records)))
    }

    /// Deploys recentes da instância, do mais novo para o mais antigo.
    pub async fn deployments(
        &self,
        instance: ServiceInstanceId,
    ) -> AppResult<Vec<DeploymentSummary>> {
        let (_, records) = self.recent(instance).await?;
        Ok(records
            .into_iter()
            .enumerate()
            .map(|(index, r)| DeploymentSummary {
                id: r.deployment.id,
                status: r.deployment.status,
                created_at: r.created_at,
                is_current: index == 0,
            })
            .collect())
    }

    pub async fn read(
        &self,
        instance: ServiceInstanceId,
        request: LogsRequest,
    ) -> AppResult<LogsResponse> {
        // Valida tudo antes de qualquer chamada ao Railway.
        let checked = check(&request)?;
        let wanted = request
            .deployment_id
            .as_deref()
            .filter(|d| !d.trim().is_empty())
            .map(|d| {
                RailwayDeploymentId::parse(d.trim())
                    .map_err(|e| AppError::Validation(format!("deployment_id inválido: {e}")))
            })
            .transpose()?;

        let (cred, records) = self.recent(instance).await?;
        let chosen =
            match &wanted {
                None => records.first(),
                Some(id) => Some(records.iter().find(|r| &r.deployment.id == id).ok_or_else(
                    || {
                        AppError::Unprocessable(
                            "o deploy informado não pertence a esta instância".into(),
                        )
                    },
                )?),
            };
        let Some(chosen) = chosen else {
            return Ok(LogsResponse {
                deployment_id: None,
                deployment_status: None,
                is_current: true,
                truncated: false,
                lines: vec![],
            });
        };
        let id = chosen.deployment.id.clone();
        let is_current = records
            .first()
            .is_some_and(|r| r.deployment.id == chosen.deployment.id);
        let status = chosen.deployment.status;

        let result = match request.kind {
            LogKind::Runtime => {
                self.railway
                    .deployment_logs(&cred.token, &id, &checked.query)
                    .await
            }
            LogKind::Build => {
                self.railway
                    .build_logs(&cred.token, &id, &checked.query)
                    .await
            }
        };
        let mut lines = self.credentials.check(&cred, result).await?;
        let truncated = lines.len() >= checked.query.limit as usize;
        lines.sort_by_key(|l| l.timestamp);
        let excess = lines.len().saturating_sub(checked.query.limit as usize);
        lines.drain(..excess);
        lines.retain(|l| keep(l, &checked));
        Ok(LogsResponse {
            deployment_id: Some(id),
            deployment_status: Some(status),
            is_current,
            truncated,
            lines,
        })
    }
}
