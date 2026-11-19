//! Estado observado de uma instância e frescor da leitura (design, Decisão 5).

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::deployment::{Deployment, DeploymentStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservedState {
    Running,
    Stopped,
    Sleeping,
    Transitioning,
    Failed,
    AwaitingApproval,
    Unknown,
}

impl ObservedState {
    pub const ALL: [Self; 7] = [
        Self::Running,
        Self::Stopped,
        Self::Sleeping,
        Self::Transitioning,
        Self::Failed,
        Self::AwaitingApproval,
        Self::Unknown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Sleeping => "sleeping",
            Self::Transitioning => "transitioning",
            Self::Failed => "failed",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for ObservedState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ObservedState {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|state| state.as_str() == s)
            .ok_or_else(|| format!("estado observado desconhecido: '{s}'"))
    }
}

/// Leitura de uma instância no Railway (`environment.serviceInstances` ou `serviceInstance`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceSnapshot {
    pub deleted: bool,
    pub latest: Option<Deployment>,
    pub active: Vec<Deployment>,
}

/// Resultado da derivação de estado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Observation {
    pub state: ObservedState,
    /// A instância não existe mais no Railway (ausente ou com `deletedAt`).
    pub not_found: bool,
}

/// Deriva o estado observado. `None` significa que o Railway não retornou a instância.
/// As regras são aplicadas em ordem; a primeira que casar vence.
pub fn observe(snapshot: Option<&InstanceSnapshot>) -> Observation {
    let Some(snapshot) = snapshot.filter(|s| !s.deleted) else {
        return Observation {
            state: ObservedState::Unknown,
            not_found: true,
        };
    };
    let found = |state| Observation {
        state,
        not_found: false,
    };
    let any_active = |status| snapshot.active.iter().any(|d| d.status == status);

    if any_active(DeploymentStatus::Success) {
        return found(ObservedState::Running);
    }
    if any_active(DeploymentStatus::Sleeping) {
        return found(ObservedState::Sleeping);
    }
    let latest = snapshot.latest.as_ref().map(|d| d.status);
    match latest {
        Some(s) if s.is_transitioning() => found(ObservedState::Transitioning),
        Some(DeploymentStatus::NeedsApproval) => found(ObservedState::AwaitingApproval),
        Some(s) if s.is_failure() => found(ObservedState::Failed),
        Some(DeploymentStatus::Removed | DeploymentStatus::Skipped) => {
            found(ObservedState::Stopped)
        }
        _ if snapshot.active.is_empty() => found(ObservedState::Stopped),
        _ => found(ObservedState::Unknown),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Fresh,
    Stale,
    Unavailable,
}

impl Freshness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Frescor calculado na leitura: `unavailable` se a última tentativa falhou;
/// `fresh` se a última leitura bem-sucedida tem até `stale_after`; senão `stale`.
pub fn freshness(
    last_observed_at: Option<DateTime<Utc>>,
    last_attempt_failed: bool,
    now: DateTime<Utc>,
    stale_after: Duration,
) -> Freshness {
    if last_attempt_failed {
        return Freshness::Unavailable;
    }
    match last_observed_at {
        Some(at) if now - at <= stale_after => Freshness::Fresh,
        _ => Freshness::Stale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::RailwayDeploymentId;

    fn dep(status: DeploymentStatus) -> Deployment {
        Deployment {
            id: RailwayDeploymentId::parse("00000000-0000-4000-8000-000000000001").unwrap(),
            status,
            can_redeploy: true,
            stopped: false,
        }
    }

    fn snap(latest: Option<DeploymentStatus>, active: &[DeploymentStatus]) -> InstanceSnapshot {
        InstanceSnapshot {
            deleted: false,
            latest: latest.map(dep),
            active: active.iter().copied().map(dep).collect(),
        }
    }

    fn state(latest: Option<DeploymentStatus>, active: &[DeploymentStatus]) -> ObservedState {
        observe(Some(&snap(latest, active))).state
    }

    /// Estado esperado quando só existe o deployment mais recente, sem nenhum ativo.
    fn expected_without_active(status: DeploymentStatus) -> ObservedState {
        use DeploymentStatus::*;
        match status {
            Queued | Waiting | Initializing | Building | Deploying | Removing => {
                ObservedState::Transitioning
            }
            NeedsApproval => ObservedState::AwaitingApproval,
            Failed | Crashed => ObservedState::Failed,
            Removed | Skipped => ObservedState::Stopped,
            // Sem deployment ativo, o último "SUCCESS"/"SLEEPING" não está rodando.
            Success | Sleeping => ObservedState::Stopped,
        }
    }

    #[test]
    fn tabela_latest_sem_ativos_cobre_todos_os_status() {
        for status in DeploymentStatus::ALL {
            assert_eq!(
                state(Some(status), &[]),
                expected_without_active(status),
                "{status}"
            );
        }
    }

    #[test]
    fn ativo_success_vence_qualquer_latest() {
        for status in DeploymentStatus::ALL {
            let got = state(Some(status), &[DeploymentStatus::Success]);
            assert_eq!(got, ObservedState::Running, "latest {status}");
        }
    }

    #[test]
    fn ativo_sleeping_vence_qualquer_latest() {
        for status in DeploymentStatus::ALL {
            let got = state(Some(status), &[DeploymentStatus::Sleeping]);
            assert_eq!(got, ObservedState::Sleeping, "latest {status}");
        }
    }

    #[test]
    fn success_vence_sleeping_entre_ativos() {
        let got = state(
            None,
            &[DeploymentStatus::Sleeping, DeploymentStatus::Success],
        );
        assert_eq!(got, ObservedState::Running);
    }

    #[test]
    fn ativos_sem_success_nem_sleeping_seguem_o_latest() {
        use DeploymentStatus::*;
        assert_eq!(
            state(Some(Deploying), &[Crashed]),
            ObservedState::Transitioning
        );
        assert_eq!(state(Some(Crashed), &[Crashed]), ObservedState::Failed);
        assert_eq!(state(Some(Removed), &[Removing]), ObservedState::Stopped);
        // Ativo sem status estável e latest SUCCESS: nada casa → unknown.
        assert_eq!(state(Some(Success), &[Crashed]), ObservedState::Unknown);
    }

    #[test]
    fn sem_deployments_e_parado() {
        assert_eq!(state(None, &[]), ObservedState::Stopped);
    }

    #[test]
    fn ausente_ou_excluida_e_unknown_nao_encontrada() {
        let missing = observe(None);
        assert_eq!(
            missing,
            Observation {
                state: ObservedState::Unknown,
                not_found: true
            }
        );

        let mut deleted = snap(
            Some(DeploymentStatus::Success),
            &[DeploymentStatus::Success],
        );
        deleted.deleted = true;
        assert!(observe(Some(&deleted)).not_found);
    }

    #[test]
    fn frescor() {
        let now = Utc::now();
        let limit = Duration::minutes(5);
        assert_eq!(freshness(Some(now), false, now, limit), Freshness::Fresh);
        assert_eq!(
            freshness(Some(now - limit), false, now, limit),
            Freshness::Fresh
        );
        let old = now - limit - Duration::seconds(1);
        assert_eq!(freshness(Some(old), false, now, limit), Freshness::Stale);
        assert_eq!(freshness(None, false, now, limit), Freshness::Stale);
        assert_eq!(
            freshness(Some(now), true, now, limit),
            Freshness::Unavailable
        );
    }

    #[test]
    fn estado_roundtrip() {
        for s in ObservedState::ALL {
            assert_eq!(s.as_str().parse::<ObservedState>().unwrap(), s);
        }
    }
}
