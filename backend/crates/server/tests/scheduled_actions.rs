//! Ações agendadas pontuais com Railway falso e relógio manual.

mod common;

use application::error::AppError;
use application::inventory::InstanceRef;
use application::scheduled_actions::NO_TARGETS;
use chrono::{DateTime, Utc};
use common::*;
use domain::ids::{ProjectId, ServiceInstanceId};
use domain::operation::{ItemResult, OperationTrigger};
use domain::power::PowerKind;
use domain::schedule::{LocalTime, Weekdays, Window};
use domain::scheduled_action::{
    ActionTarget, ScheduledAction, ScheduledActionSpec, ScheduledActionStatus,
};

fn utc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().to_utc()
}

fn pair(env: u32, service: u32) -> InstanceRef {
    InstanceRef {
        environment_id: rid(env),
        service_id: rid(service),
    }
}

/// `loja` com api@production (running), worker@production (stopped), api@staging (running).
async fn loja(h: &Harness) -> ProjectId {
    h.with_account().await;
    h.seed_loja();
    let p = h
        .projects
        .register(&rid::<String>(1), None)
        .await
        .unwrap()
        .id;
    h.inventory
        .import(p, &[pair(10, 20), pair(10, 21), pair(11, 20)])
        .await
        .unwrap();
    p
}

async fn blog(h: &Harness) -> ProjectId {
    h.railway
        .add_project(2, "blog", Some(900))
        .add_environment(2, 30, "production", false)
        .add_service(2, 40, "web")
        .add_running(2, 30, 40, 200);
    let p = h
        .projects
        .register(&rid::<String>(2), None)
        .await
        .unwrap()
        .id;
    h.inventory.import(p, &[pair(30, 40)]).await.unwrap();
    p
}

async fn instance(h: &Harness, project: ProjectId, env: &str, service: &str) -> ServiceInstanceId {
    h.inventory
        .local_instances(Some(project))
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.environment.name == env && v.service.name == service)
        .unwrap()
        .instance
        .id
}

fn stop_at(at: &str, target: ActionTarget) -> ScheduledActionSpec {
    ScheduledActionSpec {
        kind: PowerKind::Stop,
        run_at: utc(at),
        target,
        note: None,
    }
}

fn all(env: Option<&str>) -> ActionTarget {
    ActionTarget::All {
        environment_name: env.map(str::to_owned),
    }
}

impl Harness {
    async fn tick_at(&self, now: &str) -> application::schedules::TickReport {
        let now = utc(now);
        self.clock.as_ref().unwrap().set(now);
        let report = self.scheduler.tick(now).await.unwrap();
        self.power.wait_idle().await;
        report
    }

    async fn reload(&self, action: &ScheduledAction) -> ScheduledAction {
        self.actions.get(action.id).await.unwrap()
    }

    /// Serviços tocados pela operação da ação, como `serviço@ambiente`.
    async fn touched(&self, action: &ScheduledAction) -> Vec<String> {
        let (op, items) = self
            .power
            .get(action.operation_id.expect("operação criada"))
            .await
            .unwrap();
        assert_eq!(op.trigger, OperationTrigger::ScheduledAction);
        assert_eq!(op.scheduled_action_id, Some(action.id));
        let mut names: Vec<_> = items
            .iter()
            .map(|i| format!("{}@{}", i.label.service_name, i.label.environment_name))
            .collect();
        names.sort();
        names
    }
}

// ---------- 3.1 cadastro e cancelamento ----------

#[tokio::test]
async fn cria_com_rotulos_e_valida() {
    let h = scheduling_harness(utc("2026-11-17T14:48:00Z")).await;
    let p = loja(&h).await;
    let api = instance(&h, p, "production", "api").await;

    let everything = h
        .actions
        .create(stop_at("2026-11-17T18:00:00Z", all(Some("production"))))
        .await
        .unwrap();
    assert_eq!(everything.status, ScheduledActionStatus::Pending);
    assert_eq!(everything.label, "todos os projetos · production");

    let by_project = h
        .actions
        .create(stop_at(
            "2026-11-17T18:00:00Z",
            ActionTarget::Projects {
                project_ids: vec![p],
                environment_name: None,
            },
        ))
        .await
        .unwrap();
    assert_eq!(by_project.label, "loja");

    let one = h
        .actions
        .create(stop_at(
            "2026-11-17T18:00:00Z",
            ActionTarget::Instances {
                instance_ids: vec![api],
            },
        ))
        .await
        .unwrap();
    assert_eq!(one.label, "loja/api@production");

    for bad in [
        stop_at("2026-11-17T14:00:00Z", all(None)),
        stop_at("2027-01-17T14:00:00Z", all(None)),
        stop_at(
            "2026-11-17T18:00:00Z",
            ActionTarget::Projects {
                project_ids: vec![ProjectId::new()],
                environment_name: None,
            },
        ),
    ] {
        assert!(
            matches!(h.actions.create(bad).await, Err(AppError::Validation(_))),
            "deveria recusar"
        );
    }
    assert!(matches!(
        h.actions
            .create(stop_at(
                "2026-11-17T18:00:00Z",
                ActionTarget::Instances {
                    instance_ids: vec![ServiceInstanceId::new()],
                },
            ))
            .await,
        Err(AppError::UnknownInstances(_))
    ));
    let pending = h
        .actions
        .list(Some(ScheduledActionStatus::Pending), None, None)
        .await
        .unwrap();
    assert_eq!(pending.total, 3);
}

#[tokio::test]
async fn cancelar_pendente_e_recusar_executada() {
    let h = scheduling_harness(utc("2026-11-17T14:48:00Z")).await;
    loja(&h).await;
    let a = h
        .actions
        .create(stop_at("2026-11-17T18:00:00Z", all(None)))
        .await
        .unwrap();
    let cancelled = h.actions.cancel(a.id).await.unwrap();
    assert_eq!(cancelled.status, ScheduledActionStatus::Cancelled);
    h.tick_at("2026-11-17T17:59:30Z").await;
    let before = h.railway.mutation_calls().len();
    h.tick_at("2026-11-17T18:00:10Z").await;
    assert_eq!(
        h.railway.mutation_calls().len(),
        before,
        "cancelada não age"
    );

    let b = h
        .actions
        .create(stop_at("2026-11-17T18:01:00Z", all(None)))
        .await
        .unwrap();
    h.tick_at("2026-11-17T18:01:10Z").await;
    match h.actions.cancel(b.id).await {
        Err(AppError::Conflict(msg)) => assert!(msg.contains("executada"), "{msg}"),
        other => panic!("esperava 409, veio {other:?}"),
    }
}

// ---------- 3.2 / 3.3 execução pelo agendador ----------

#[tokio::test]
async fn executa_no_horario_com_origem_e_sem_duplicar() {
    let h = scheduling_harness(utc("2026-11-17T14:48:00Z")).await;
    let p = loja(&h).await;
    let a = h
        .actions
        .create(stop_at(
            "2026-11-17T18:00:00Z",
            ActionTarget::Projects {
                project_ids: vec![p],
                environment_name: None,
            },
        ))
        .await
        .unwrap();
    h.tick_at("2026-11-17T17:59:40Z").await;
    assert_eq!(h.reload(&a).await.status, ScheduledActionStatus::Pending);

    let report = h.tick_at("2026-11-17T18:00:10Z").await;
    assert_eq!(report.executed, 1);
    let done = h.reload(&a).await;
    assert_eq!(done.status, ScheduledActionStatus::Executed);
    assert_eq!(
        h.touched(&done).await,
        ["api@production", "api@staging", "worker@production"]
    );
    let (op, _) = h.power.get(done.operation_id.unwrap()).await.unwrap();
    assert_eq!(op.scheduled_action_label.as_deref(), Some("loja"));
    assert_eq!(op.requested_by, "agendador");

    // "Reinício": nada é reexecutado.
    h.scheduler.startup().await.unwrap();
    let before = h.railway.mutation_calls().len();
    let report = h.tick_at("2026-11-17T18:00:40Z").await;
    assert_eq!(report.executed, 0);
    assert_eq!(h.railway.mutation_calls().len(), before);
    assert_eq!(h.reload(&a).await.status, ScheduledActionStatus::Executed);
}

#[tokio::test]
async fn todos_os_projetos_inclui_importado_depois() {
    let h = scheduling_harness(utc("2026-11-17T14:00:00Z")).await;
    loja(&h).await;
    let a = h
        .actions
        .create(stop_at("2026-11-17T18:00:00Z", all(Some("Production"))))
        .await
        .unwrap();
    blog(&h).await;
    h.tick_at("2026-11-17T17:59:40Z").await;
    h.tick_at("2026-11-17T18:00:10Z").await;
    let done = h.reload(&a).await;
    assert_eq!(done.status, ScheduledActionStatus::Executed);
    assert_eq!(
        h.touched(&done).await,
        ["api@production", "web@production", "worker@production"]
    );
}

#[tokio::test]
async fn alvo_vazio_termina_skipped_sem_operacao() {
    let h = scheduling_harness(utc("2026-11-17T14:00:00Z")).await;
    let p = loja(&h).await;
    let api = instance(&h, p, "production", "api").await;
    let a = h
        .actions
        .create(stop_at(
            "2026-11-17T18:00:00Z",
            ActionTarget::Instances {
                instance_ids: vec![api],
            },
        ))
        .await
        .unwrap();
    h.inventory.remove_instance(api).await.unwrap();
    h.tick_at("2026-11-17T17:59:40Z").await;
    let report = h.tick_at("2026-11-17T18:00:10Z").await;
    assert_eq!(report.skipped, 1);
    let done = h.reload(&a).await;
    assert_eq!(done.status, ScheduledActionStatus::Skipped);
    assert_eq!(done.message.as_deref(), Some(NO_TARGETS));
    assert_eq!(done.operation_id, None);
}

#[tokio::test]
async fn sem_credencial_falha_sem_chamar_o_railway() {
    let h = scheduling_harness(utc("2026-11-17T14:00:00Z")).await;
    loja(&h).await;
    let a = h
        .actions
        .create(stop_at("2026-11-17T18:00:00Z", all(None)))
        .await
        .unwrap();
    h.credentials.remove().await.unwrap();
    h.tick_at("2026-11-17T17:59:40Z").await;
    let before = h.railway.calls().len();
    let report = h.tick_at("2026-11-17T18:00:10Z").await;
    assert_eq!(report.failed, 1);
    let done = h.reload(&a).await;
    assert_eq!(done.status, ScheduledActionStatus::Failed);
    assert!(
        done.message
            .as_deref()
            .unwrap()
            .contains("integração não configurada")
    );
    assert_eq!(h.railway.calls().len(), before);
}

#[tokio::test]
async fn volta_dentro_do_limite_executa_atrasada() {
    let h = scheduling_harness(utc("2026-11-17T14:00:00Z")).await;
    loja(&h).await;
    let a = h
        .actions
        .create(stop_at("2026-11-17T18:00:00Z", all(None)))
        .await
        .unwrap();
    h.tick_at("2026-11-17T17:55:00Z").await;
    h.tick_at("2026-11-17T18:10:00Z").await;
    let done = h.reload(&a).await;
    assert_eq!(done.status, ScheduledActionStatus::Late);
    assert!(done.operation_id.is_some());
}

#[tokio::test]
async fn volta_fora_do_limite_registra_missed() {
    let h = scheduling_harness(utc("2026-11-17T14:00:00Z")).await;
    loja(&h).await;
    let a = h
        .actions
        .create(stop_at("2026-11-17T18:00:00Z", all(None)))
        .await
        .unwrap();
    h.tick_at("2026-11-17T17:55:00Z").await;
    let before = h.railway.mutation_calls().len();
    let report = h.tick_at("2026-11-17T19:00:00Z").await;
    assert_eq!(report.missed, 1);
    let done = h.reload(&a).await;
    assert_eq!(done.status, ScheduledActionStatus::Missed);
    assert_eq!(done.operation_id, None);
    assert_eq!(h.railway.mutation_calls().len(), before);
}

#[tokio::test]
async fn conflito_com_evento_de_agenda_no_mesmo_ciclo() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let api = instance(&h, p, "production", "api").await;
    h.railway
        .mutation_delay(std::time::Duration::from_millis(200));
    let window = Window {
        start: "06:30".parse::<LocalTime>().unwrap(),
        end: "07:00".parse::<LocalTime>().unwrap(),
    };
    h.schedules
        .create(
            p,
            application::schedules::spec(
                "noite".into(),
                chrono_tz::UTC,
                Weekdays::ALL,
                vec![window],
                None,
                Some(vec![api]),
            ),
        )
        .await
        .unwrap();
    let a = h
        .actions
        .create(stop_at("2026-11-17T07:00:00Z", all(Some("production"))))
        .await
        .unwrap();
    h.tick_at("2026-11-17T06:59:40Z").await;
    h.tick_at("2026-11-17T07:00:10Z").await;

    let done = h.reload(&a).await;
    assert_eq!(done.status, ScheduledActionStatus::Executed);
    let (_, items) = h.power.get(done.operation_id.unwrap()).await.unwrap();
    let api_item = items
        .iter()
        .find(|i| i.label.service_name == "api")
        .unwrap();
    assert_eq!(api_item.result, ItemResult::Skipped);
    assert_eq!(
        api_item.error_message.as_deref(),
        Some("operação em andamento")
    );
}

// ---------- 3.4 inicialização ----------

#[tokio::test]
async fn startup_marca_reivindicada_orfa_como_falha() {
    use application::ports::ScheduledActionRepository;
    let h = scheduling_harness(utc("2026-11-17T14:00:00Z")).await;
    loja(&h).await;
    let a = h
        .actions
        .create(stop_at("2026-11-17T18:00:00Z", all(None)))
        .await
        .unwrap();
    // Processo caiu depois de reivindicar a ação.
    let repo = infrastructure::sqlite::SqliteScheduledActions::new(h.pool.clone());
    assert!(repo.claim(a.id).await.unwrap());

    assert_eq!(h.scheduler.startup().await.unwrap(), 1);
    let done = h.reload(&a).await;
    assert_eq!(done.status, ScheduledActionStatus::Failed);
    assert!(done.message.unwrap().contains("reinício"));
    h.tick_at("2026-11-17T17:59:40Z").await;
    let before = h.railway.mutation_calls().len();
    h.tick_at("2026-11-17T18:00:10Z").await;
    assert_eq!(h.railway.mutation_calls().len(), before);
}
