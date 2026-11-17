//! Operações de energia, seus itens e planos (design, Decisão 6).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{
    OperationId, OperationItemId, PlanId, ProjectId, RailwayDeploymentId, RailwayEnvironmentId,
    RailwayProjectId, RailwayServiceId, ScheduleId, ServiceInstanceId,
};
use crate::power::{Decision, PowerKind};
use crate::state::ObservedState;

macro_rules! str_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl ::std::str::FromStr for $name {
            type Err = String;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($text => Ok(Self::$variant),)+
                    other => Err(format!(concat!(stringify!($name), " inválido: '{}'"), other)),
                }
            }
        }
    };
}
pub(crate) use str_enum;

/// Resultado/etapa de um item. Os quatro primeiros são ativos (bloqueiam a instância).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemResult {
    Pending,
    Running,
    Verifying,
    Succeeded,
    Failed,
    Skipped,
    TimedOut,
    Interrupted,
}

str_enum!(ItemResult {
    Pending => "pending",
    Running => "running",
    Verifying => "verifying",
    Succeeded => "succeeded",
    Failed => "failed",
    Skipped => "skipped",
    TimedOut => "timed_out",
    Interrupted => "interrupted",
});

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("transição inválida de item: {from} → {to}")]
pub struct InvalidTransition {
    pub from: ItemResult,
    pub to: ItemResult,
}

impl ItemResult {
    pub const ACTIVE: [Self; 3] = [Self::Pending, Self::Running, Self::Verifying];

    pub fn is_active(self) -> bool {
        Self::ACTIVE.contains(&self)
    }

    pub fn is_final(self) -> bool {
        !self.is_active()
    }

    /// Conta como falha no agregado da operação.
    pub fn is_failure(self) -> bool {
        matches!(self, Self::Failed | Self::TimedOut | Self::Interrupted)
    }

    pub fn can_transition_to(self, to: Self) -> bool {
        use ItemResult::*;
        match (self, to) {
            (_, Interrupted) => self.is_active(),
            (Pending, Running | Skipped | Failed) => true,
            (Running, Verifying | Skipped | Failed) => true,
            (Verifying, Succeeded | Failed | TimedOut) => true,
            _ => false,
        }
    }

    pub fn transition(self, to: Self) -> Result<Self, InvalidTransition> {
        if self.can_transition_to(to) {
            Ok(to)
        } else {
            Err(InvalidTransition { from: self, to })
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Pending,
    Running,
    Succeeded,
    PartiallyFailed,
    Failed,
}

str_enum!(OperationStatus {
    Pending => "pending",
    Running => "running",
    Succeeded => "succeeded",
    PartiallyFailed => "partially_failed",
    Failed => "failed",
});

impl OperationStatus {
    pub fn is_final(self) -> bool {
        matches!(self, Self::Succeeded | Self::PartiallyFailed | Self::Failed)
    }

    /// Agrega o resultado final. `None` enquanto houver item ativo.
    /// Sem falhas → `succeeded`; só falhas → `failed`; misto → `partially_failed`.
    pub fn aggregate(results: impl IntoIterator<Item = ItemResult>) -> Option<Self> {
        let (mut ok, mut failed) = (0usize, 0usize);
        for result in results {
            if result.is_active() {
                return None;
            }
            if result.is_failure() {
                failed += 1
            } else {
                ok += 1
            }
        }
        Some(match (ok, failed) {
            (_, 0) => Self::Succeeded,
            (0, _) => Self::Failed,
            _ => Self::PartiallyFailed,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationScope {
    Instance,
    Project,
    Batch,
}

str_enum!(OperationScope { Instance => "instance", Project => "project", Batch => "batch" });

/// Origem da operação: clique do administrador ou evento de agenda.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationTrigger {
    Manual,
    Schedule,
}

str_enum!(OperationTrigger { Manual => "manual", Schedule => "schedule" });

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Operation {
    pub id: OperationId,
    pub kind: PowerKind,
    pub scope: OperationScope,
    pub trigger: OperationTrigger,
    /// Agenda que disparou a operação (nome copiado: sobrevive à exclusão da agenda).
    pub schedule_id: Option<ScheduleId>,
    pub schedule_name: Option<String>,
    pub requested_by: String,
    pub plan_id: PlanId,
    pub status: OperationStatus,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// Nomes e IDs Railway copiados no momento da operação (sobrevivem à remoção local).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceLabel {
    pub project_id: ProjectId,
    pub project_name: String,
    pub railway_project_id: RailwayProjectId,
    pub service_name: String,
    pub railway_service_id: RailwayServiceId,
    pub environment_name: String,
    pub railway_environment_id: RailwayEnvironmentId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationItem {
    pub id: OperationItemId,
    pub operation_id: OperationId,
    /// `None` após a instância ser removida do gerenciamento.
    pub service_instance_id: Option<ServiceInstanceId>,
    pub label: InstanceLabel,
    pub previous_state: ObservedState,
    pub desired_state: ObservedState,
    pub final_state: Option<ObservedState>,
    pub deployment_id: Option<RailwayDeploymentId>,
    pub result: ItemResult,
    pub error_message: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
}

impl OperationItem {
    /// Aplica uma transição validada, registrando início/fim e duração.
    pub fn advance(&mut self, to: ItemResult, now: DateTime<Utc>) -> Result<(), InvalidTransition> {
        self.result = self.result.transition(to)?;
        if to == ItemResult::Running {
            self.started_at = Some(now);
        }
        if to.is_final() {
            self.finished_at = Some(now);
            let started = self.started_at.unwrap_or(now);
            self.duration_ms = Some((now - started).num_milliseconds());
        }
        Ok(())
    }
}

/// Uma linha do plano: instância, estado lido e ação prevista.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub service_instance_id: ServiceInstanceId,
    pub label: InstanceLabel,
    pub current_state: ObservedState,
    pub decision: Decision,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidPlan {
    #[error("o plano não contém nenhuma instância")]
    Empty,
    #[error("a instância {0} aparece mais de uma vez no plano")]
    Duplicate(ServiceInstanceId),
    #[error("a validade do plano deve ser posterior à criação")]
    Expiry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub id: PlanId,
    pub kind: PowerKind,
    pub scope: OperationScope,
    pub entries: Vec<PlanEntry>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl Plan {
    pub fn new(
        kind: PowerKind,
        scope: OperationScope,
        entries: Vec<PlanEntry>,
        created_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> Result<Self, InvalidPlan> {
        if entries.is_empty() {
            return Err(InvalidPlan::Empty);
        }
        let mut seen = std::collections::HashSet::new();
        if let Some(dup) = entries.iter().find(|e| !seen.insert(e.service_instance_id)) {
            return Err(InvalidPlan::Duplicate(dup.service_instance_id));
        }
        if expires_at <= created_at {
            return Err(InvalidPlan::Expiry);
        }
        Ok(Self {
            id: PlanId::new(),
            kind,
            scope,
            entries,
            created_at,
            expires_at,
        })
    }

    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::power::SkipReason;
    use ItemResult::*;

    #[test]
    fn transicoes_validas() {
        for (from, to) in [
            (Pending, Running),
            (Pending, Skipped),
            (Pending, Failed),
            (Pending, Interrupted),
            (Running, Verifying),
            (Running, Skipped),
            (Running, Failed),
            (Running, Interrupted),
            (Verifying, Succeeded),
            (Verifying, Failed),
            (Verifying, TimedOut),
            (Verifying, Interrupted),
        ] {
            assert_eq!(from.transition(to), Ok(to), "{from} → {to}");
        }
    }

    #[test]
    fn transicoes_invalidas_sao_rejeitadas() {
        let valid = |from: ItemResult, to: ItemResult| from.can_transition_to(to);
        let mut rejected = 0;
        for &from in ItemResult::ALL {
            for &to in ItemResult::ALL {
                if !valid(from, to) {
                    assert_eq!(from.transition(to), Err(InvalidTransition { from, to }));
                    rejected += 1;
                }
            }
        }
        // 64 pares, 12 válidos.
        assert_eq!(rejected, 52);
        // Estados finais não saem do lugar; não se pula a verificação.
        assert!(Succeeded.transition(Running).is_err());
        assert!(Interrupted.transition(Interrupted).is_err());
        assert!(Pending.transition(Succeeded).is_err());
        assert!(Running.transition(Succeeded).is_err());
    }

    #[test]
    fn agregado() {
        assert_eq!(
            OperationStatus::aggregate([Succeeded, Skipped]),
            Some(OperationStatus::Succeeded)
        );
        assert_eq!(
            OperationStatus::aggregate([Skipped]),
            Some(OperationStatus::Succeeded)
        );
        assert_eq!(
            OperationStatus::aggregate([Succeeded, Succeeded, Failed, Succeeded, Succeeded]),
            Some(OperationStatus::PartiallyFailed)
        );
        assert_eq!(
            OperationStatus::aggregate([Failed, TimedOut, Interrupted]),
            Some(OperationStatus::Failed)
        );
        assert_eq!(OperationStatus::aggregate([Succeeded, Verifying]), None);
    }

    fn label() -> InstanceLabel {
        InstanceLabel {
            project_id: ProjectId::new(),
            project_name: "loja".into(),
            railway_project_id: RailwayProjectId::parse("00000000-0000-4000-8000-000000000001")
                .unwrap(),
            service_name: "api".into(),
            railway_service_id: RailwayServiceId::parse("00000000-0000-4000-8000-000000000002")
                .unwrap(),
            environment_name: "production".into(),
            railway_environment_id: RailwayEnvironmentId::parse(
                "00000000-0000-4000-8000-000000000003",
            )
            .unwrap(),
        }
    }

    fn entry(id: ServiceInstanceId) -> PlanEntry {
        PlanEntry {
            service_instance_id: id,
            label: label(),
            current_state: ObservedState::Stopped,
            decision: Decision::WillSkip {
                reason: SkipReason::AlreadyInDesiredState,
            },
        }
    }

    #[test]
    fn plano_invariantes() {
        let now = Utc::now();
        let later = now + Duration::minutes(5);
        let kind = PowerKind::Stop;
        let scope = OperationScope::Project;
        assert_eq!(
            Plan::new(kind, scope, vec![], now, later),
            Err(InvalidPlan::Empty)
        );

        let id = ServiceInstanceId::new();
        assert_eq!(
            Plan::new(kind, scope, vec![entry(id), entry(id)], now, later),
            Err(InvalidPlan::Duplicate(id))
        );
        assert_eq!(
            Plan::new(kind, scope, vec![entry(id)], now, now),
            Err(InvalidPlan::Expiry)
        );

        let plan = Plan::new(kind, scope, vec![entry(id)], now, later).unwrap();
        assert!(!plan.is_expired(now));
        assert!(plan.is_expired(later));
    }

    #[test]
    fn item_registra_duracao() {
        let t0 = Utc::now();
        let mut item = OperationItem {
            id: OperationItemId::new(),
            operation_id: OperationId::new(),
            service_instance_id: Some(ServiceInstanceId::new()),
            label: label(),
            previous_state: ObservedState::Running,
            desired_state: ObservedState::Stopped,
            final_state: None,
            deployment_id: None,
            result: Pending,
            error_message: None,
            started_at: None,
            finished_at: None,
            duration_ms: None,
        };
        item.advance(Running, t0).unwrap();
        item.advance(Verifying, t0 + Duration::seconds(1)).unwrap();
        item.advance(Succeeded, t0 + Duration::seconds(3)).unwrap();
        assert_eq!(item.duration_ms, Some(3000));
        assert!(item.advance(Failed, t0).is_err());
        assert_eq!(item.result, Succeeded);
    }

    #[test]
    fn enums_roundtrip() {
        for &r in ItemResult::ALL {
            assert_eq!(r.as_str().parse::<ItemResult>(), Ok(r));
        }
        for &s in OperationStatus::ALL {
            assert_eq!(s.as_str().parse::<OperationStatus>(), Ok(s));
        }
        for &t in OperationTrigger::ALL {
            assert_eq!(t.as_str().parse::<OperationTrigger>(), Ok(t));
        }
        assert_eq!(OperationTrigger::Schedule.as_str(), "schedule");
    }
}
