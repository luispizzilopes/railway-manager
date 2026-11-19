//! Ações agendadas pontuais: ligar/desligar uma única vez num instante futuro
//! (change command-console, design decisão 6).

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::catalog::{DESCRIPTION_MAX, optional_text};
use crate::ids::{OperationId, ProjectId, ScheduledActionId, ServiceInstanceId};
use crate::operation::str_enum;
use crate::power::PowerKind;

/// Maior antecedência aceita para uma ação.
pub const MAX_HORIZON_DAYS: i64 = 30;
/// Quantos nomes o rótulo mostra antes de resumir ("e mais N").
const LABEL_NAMES: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidScheduledAction {
    #[error("o instante da ação já passou")]
    InPast,
    #[error("o instante da ação está a mais de {MAX_HORIZON_DAYS} dias")]
    TooFar,
    #[error("selecione ao menos um projeto ou instância")]
    EmptyTarget,
    #[error("{0}")]
    Note(String),
}

/// Alvo, resolvido em instâncias só na hora da execução.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionTarget {
    /// Todos os projetos gerenciados no momento da execução.
    All { environment_name: Option<String> },
    Projects {
        project_ids: Vec<ProjectId>,
        environment_name: Option<String>,
    },
    Instances {
        instance_ids: Vec<ServiceInstanceId>,
    },
}

impl ActionTarget {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::All { .. } => "all",
            Self::Projects { .. } => "projects",
            Self::Instances { .. } => "instances",
        }
    }

    pub fn environment_name(&self) -> Option<&str> {
        match self {
            Self::All { environment_name }
            | Self::Projects {
                environment_name, ..
            } => environment_name.as_deref(),
            Self::Instances { .. } => None,
        }
    }

    /// Remove duplicatas e normaliza o nome do ambiente (vazio → nenhum).
    fn normalized(self) -> Self {
        fn env(e: Option<String>) -> Option<String> {
            e.map(|e| e.trim().to_owned()).filter(|e| !e.is_empty())
        }
        fn dedup<T: PartialEq + Copy>(ids: Vec<T>) -> Vec<T> {
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
            out
        }
        match self {
            Self::All { environment_name } => Self::All {
                environment_name: env(environment_name),
            },
            Self::Projects {
                project_ids,
                environment_name,
            } => Self::Projects {
                project_ids: dedup(project_ids),
                environment_name: env(environment_name),
            },
            Self::Instances { instance_ids } => Self::Instances {
                instance_ids: dedup(instance_ids),
            },
        }
    }

    fn is_empty(&self) -> bool {
        match self {
            Self::All { .. } => false,
            Self::Projects { project_ids, .. } => project_ids.is_empty(),
            Self::Instances { instance_ids } => instance_ids.is_empty(),
        }
    }
}

/// Situação de uma ação. `Processing` é interno: reivindicada por um ciclo do agendador.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledActionStatus {
    Pending,
    Processing,
    Executed,
    Late,
    Skipped,
    Missed,
    Failed,
    Cancelled,
}

str_enum!(ScheduledActionStatus {
    Pending => "pending",
    Processing => "processing",
    Executed => "executed",
    Late => "late",
    Skipped => "skipped",
    Missed => "missed",
    Failed => "failed",
    Cancelled => "cancelled",
});

/// Dados de entrada de uma ação (já convertidos pela API).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledActionSpec {
    pub kind: PowerKind,
    pub run_at: DateTime<Utc>,
    pub target: ActionTarget,
    pub note: Option<String>,
}

impl ScheduledActionSpec {
    /// Valida contra o relógio atual e normaliza alvo e observação.
    pub fn validate(self, now: DateTime<Utc>) -> Result<Self, InvalidScheduledAction> {
        if self.run_at <= now {
            return Err(InvalidScheduledAction::InPast);
        }
        if self.run_at > now + Duration::days(MAX_HORIZON_DAYS) {
            return Err(InvalidScheduledAction::TooFar);
        }
        let target = self.target.normalized();
        if target.is_empty() {
            return Err(InvalidScheduledAction::EmptyTarget);
        }
        let note = optional_text("observação", self.note.as_deref(), DESCRIPTION_MAX)
            .map_err(|e| InvalidScheduledAction::Note(e.to_string()))?;
        Ok(Self {
            target,
            note,
            ..self
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScheduledAction {
    pub id: ScheduledActionId,
    pub kind: PowerKind,
    pub run_at: DateTime<Utc>,
    pub target: ActionTarget,
    pub note: Option<String>,
    /// Descrição legível do alvo, calculada na criação.
    pub label: String,
    pub status: ScheduledActionStatus,
    pub message: Option<String>,
    pub operation_id: Option<OperationId>,
    pub created_at: DateTime<Utc>,
    pub processed_at: Option<DateTime<Utc>>,
}

impl ScheduledAction {
    pub fn new(spec: ScheduledActionSpec, label: String, now: DateTime<Utc>) -> Self {
        Self {
            id: ScheduledActionId::new(),
            kind: spec.kind,
            run_at: spec.run_at,
            target: spec.target,
            note: spec.note,
            label,
            status: ScheduledActionStatus::Pending,
            message: None,
            operation_id: None,
            created_at: now,
            processed_at: None,
        }
    }
}

/// Rótulo do alvo: "todos os projetos · production", "loja, blog", "3 instâncias".
/// `names` são os nomes dos projetos ou das instâncias (`projeto/serviço@ambiente`).
pub fn label(target: &ActionTarget, names: &[String]) -> String {
    let base = match target {
        ActionTarget::All { .. } => "todos os projetos".to_owned(),
        ActionTarget::Instances { instance_ids } if instance_ids.len() > LABEL_NAMES => {
            format!("{} instâncias", instance_ids.len())
        }
        _ if names.len() > LABEL_NAMES => format!(
            "{} e mais {}",
            names[..LABEL_NAMES].join(", "),
            names.len() - LABEL_NAMES
        ),
        _ => names.join(", "),
    };
    match target.environment_name() {
        Some(env) => format!("{base} · {env}"),
        None => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().to_utc()
    }

    fn spec(run_at: &str, target: ActionTarget) -> ScheduledActionSpec {
        ScheduledActionSpec {
            kind: PowerKind::Stop,
            run_at: utc(run_at),
            target,
            note: Some("  fim do dia ".into()),
        }
    }

    fn all() -> ActionTarget {
        ActionTarget::All {
            environment_name: None,
        }
    }

    const NOW: &str = "2026-11-17T14:48:00Z";

    #[test]
    fn validacao_de_instante() {
        let now = utc(NOW);
        assert_eq!(
            spec(NOW, all()).validate(now),
            Err(InvalidScheduledAction::InPast)
        );
        assert_eq!(
            spec("2026-11-17T10:00:00Z", all()).validate(now),
            Err(InvalidScheduledAction::InPast)
        );
        assert_eq!(
            spec("2026-12-17T14:49:00Z", all()).validate(now),
            Err(InvalidScheduledAction::TooFar)
        );
        let ok = spec("2026-11-17T21:00:00Z", all()).validate(now).unwrap();
        assert_eq!(ok.note.as_deref(), Some("fim do dia"));
        assert!(spec("2026-12-17T14:48:00Z", all()).validate(now).is_ok());
    }

    #[test]
    fn alvo_vazio_e_normalizacao() {
        let now = utc(NOW);
        let empty = ActionTarget::Projects {
            project_ids: vec![],
            environment_name: None,
        };
        assert_eq!(
            spec("2026-11-17T21:00:00Z", empty).validate(now),
            Err(InvalidScheduledAction::EmptyTarget)
        );
        let i = ServiceInstanceId::new();
        let ok = spec(
            "2026-11-17T21:00:00Z",
            ActionTarget::Instances {
                instance_ids: vec![i, i],
            },
        )
        .validate(now)
        .unwrap();
        assert_eq!(
            ok.target,
            ActionTarget::Instances {
                instance_ids: vec![i]
            }
        );
        let ok = spec(
            "2026-11-17T21:00:00Z",
            ActionTarget::All {
                environment_name: Some("  ".into()),
            },
        )
        .validate(now)
        .unwrap();
        assert_eq!(ok.target.environment_name(), None);
    }

    #[test]
    fn rotulos() {
        let env = ActionTarget::All {
            environment_name: Some("production".into()),
        };
        assert_eq!(label(&env, &[]), "todos os projetos · production");
        let projects = ActionTarget::Projects {
            project_ids: vec![ProjectId::new(), ProjectId::new()],
            environment_name: None,
        };
        assert_eq!(
            label(&projects, &["loja".into(), "blog".into()]),
            "loja, blog"
        );
        let names: Vec<String> = ["a", "b", "c", "d", "e"].map(String::from).to_vec();
        assert_eq!(label(&projects, &names), "a, b, c e mais 2");
        let instances = ActionTarget::Instances {
            instance_ids: (0..4).map(|_| ServiceInstanceId::new()).collect(),
        };
        assert_eq!(label(&instances, &names[..4]), "4 instâncias");
        let one = ActionTarget::Instances {
            instance_ids: vec![ServiceInstanceId::new()],
        };
        assert_eq!(
            label(&one, &["loja/api@production".into()]),
            "loja/api@production"
        );
    }

    #[test]
    fn enums_e_alvo_serializados() {
        for status in ScheduledActionStatus::ALL {
            assert_eq!(
                status.as_str().parse::<ScheduledActionStatus>().unwrap(),
                *status
            );
        }
        let json = serde_json::to_value(ActionTarget::All {
            environment_name: Some("staging".into()),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "all", "environment_name": "staging" })
        );
        let back: ActionTarget = serde_json::from_value(serde_json::json!({
            "type": "projects", "project_ids": []
        }))
        .unwrap();
        assert_eq!(back.kind(), "projects");
    }
}
