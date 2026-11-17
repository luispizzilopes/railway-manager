//! Agendas e agendador com Railway falso e relógio manual.

mod common;

use std::time::Duration;

use application::error::AppError;
use application::inventory::InstanceRef;
use application::schedules::{NO_TARGETS, spec};
use chrono::{DateTime, Utc};
use common::*;
use domain::ids::{ProjectId, ServiceInstanceId};
use domain::operation::{ItemResult, OperationTrigger};
use domain::power::PowerKind;
use domain::schedule::{InvalidSchedule, LocalTime, RunStatus, Weekdays, Window};

fn utc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().to_utc()
}

fn w(a: &str, b: &str) -> Window {
    Window {
        start: a.parse::<LocalTime>().unwrap(),
        end: b.parse::<LocalTime>().unwrap(),
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
    let pairs = [(10, 20), (10, 21), (11, 20)];
    let refs: Vec<_> = pairs
        .iter()
        .map(|(e, s)| InstanceRef {
            environment_id: rid(*e),
            service_id: rid(*s),
        })
        .collect();
    h.inventory.import(p, &refs).await.unwrap();
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

fn whole_project(name: &str, windows: Vec<Window>) -> domain::schedule::ScheduleSpec {
    spec(
        name.into(),
        chrono_tz::UTC,
        Weekdays::ALL,
        windows,
        None,
        None,
    )
}

fn only(
    name: &str,
    windows: Vec<Window>,
    instances: Vec<ServiceInstanceId>,
) -> domain::schedule::ScheduleSpec {
    spec(
        name.into(),
        chrono_tz::UTC,
        Weekdays::ALL,
        windows,
        None,
        Some(instances),
    )
}

impl Harness {
    fn at(&self, now: &str) -> DateTime<Utc> {
        let now = utc(now);
        self.clock.as_ref().unwrap().set(now);
        now
    }

    async fn tick(&self, now: &str) -> application::schedules::TickReport {
        let now = self.at(now);
        let report = self.scheduler.tick(now).await.unwrap();
        self.power.wait_idle().await;
        report
    }

    async fn runs(&self, schedule: domain::ids::ScheduleId) -> Vec<(String, PowerKind, RunStatus)> {
        let mut runs: Vec<_> = self
            .schedules
            .runs(schedule, Some(1), Some(100))
            .await
            .unwrap()
            .items
            .into_iter()
            .map(|r| {
                (
                    r.scheduled_for.format("%H:%M").to_string(),
                    r.action,
                    r.status,
                )
            })
            .collect();
        runs.reverse();
        runs
    }
}

// ---------- 3.1 cadastro ----------

#[tokio::test]
async fn cria_agenda_com_proximas_execucoes() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let view = h
        .schedules
        .create(
            p,
            whole_project("comercial", vec![w("07:00", "12:00"), w("13:00", "18:00")]),
        )
        .await
        .unwrap();
    let next: Vec<_> = view
        .next_runs
        .iter()
        .map(|o| (o.at.format("%H:%M").to_string(), o.action))
        .collect();
    assert_eq!(
        next,
        [
            ("07:00".into(), PowerKind::Start),
            ("12:00".into(), PowerKind::Stop),
            ("13:00".into(), PowerKind::Start),
            ("18:00".into(), PowerKind::Stop),
            ("07:00".into(), PowerKind::Start),
        ]
    );
    assert!(view.warnings.is_empty(), "{:?}", view.warnings);
    assert_eq!(h.schedules.list(Some(p)).await.unwrap().len(), 1);
}

#[tokio::test]
async fn validacoes_de_agenda() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let err = h
        .schedules
        .create(
            p,
            whole_project("x", vec![w("07:00", "12:00"), w("11:00", "15:00")]),
        )
        .await
        .unwrap_err();
    assert_eq!(
        err,
        AppError::InvalidSchedule(InvalidSchedule::Overlap(1, 2))
    );

    // Instância e ambiente precisam ser do projeto.
    let foreign = only(
        "x",
        vec![w("07:00", "12:00")],
        vec![ServiceInstanceId::new()],
    );
    assert!(matches!(
        h.schedules.create(p, foreign).await,
        Err(AppError::Validation(_))
    ));
    let other_env = spec(
        "x".into(),
        chrono_tz::UTC,
        Weekdays::ALL,
        vec![w("07:00", "12:00")],
        Some(domain::ids::EnvironmentId::new()),
        None,
    );
    assert!(matches!(
        h.schedules.create(p, other_env).await,
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        h.schedules
            .create(
                ProjectId::new(),
                whole_project("x", vec![w("07:00", "12:00")])
            )
            .await,
        Err(AppError::NotFound(_))
    ));
    assert!(h.schedules.list(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn avisos_de_sobreposicao_e_janela_curta() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let api = instance(&h, p, "production", "api").await;
    h.schedules
        .create(p, whole_project("comercial", vec![w("07:00", "12:00")]))
        .await
        .unwrap();

    let overlapping = h
        .schedules
        .create(p, only("plantão", vec![w("11:00", "13:00")], vec![api]))
        .await
        .unwrap();
    assert!(
        overlapping.warnings.iter().any(|m| m.contains("comercial")),
        "{:?}",
        overlapping.warnings
    );

    let short = h
        .schedules
        .create(p, only("rápida", vec![w("20:00", "20:05")], vec![api]))
        .await
        .unwrap();
    assert!(
        short.warnings.iter().any(|m| m.contains("20:00–20:05")),
        "{:?}",
        short.warnings
    );
}

#[tokio::test]
async fn pausar_retomar_editar_e_excluir() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let id = h
        .schedules
        .create(p, whole_project("comercial", vec![w("07:00", "12:00")]))
        .await
        .unwrap()
        .schedule
        .id;

    let paused = h.schedules.pause(id).await.unwrap();
    assert!(!paused.schedule.enabled);
    assert!(paused.next_runs.is_empty());
    assert!(h.schedules.resume(id).await.unwrap().schedule.enabled);

    let edited = h
        .schedules
        .update(id, whole_project("comercial 2", vec![w("08:00", "09:00")]))
        .await
        .unwrap();
    assert_eq!(edited.schedule.name, "comercial 2");
    assert_eq!(edited.next_runs[0].at, utc("2026-11-17T08:00:00Z"));

    h.schedules.delete(id).await.unwrap();
    assert!(matches!(
        h.schedules.get(id).await,
        Err(AppError::NotFound(_))
    ));
}

// ---------- 3.2 alvo vazio ----------

#[tokio::test]
async fn agenda_sem_instancias_no_alvo_e_pausada() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let worker = instance(&h, p, "production", "worker").await;
    let id = h
        .schedules
        .create(p, only("worker", vec![w("07:00", "12:00")], vec![worker]))
        .await
        .unwrap()
        .schedule
        .id;

    h.inventory.remove_instance(worker).await.unwrap();
    let view = h.schedules.get(id).await.unwrap();
    assert!(!view.schedule.enabled);
    assert_eq!(view.schedule.paused_reason.as_deref(), Some(NO_TARGETS));
    assert!(matches!(
        h.schedules.resume(id).await,
        Err(AppError::Validation(_))
    ));
}

// ---------- 3.4 agendador ----------

#[tokio::test]
async fn executa_no_horario_sem_duplicar() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let id = h
        .schedules
        .create(p, whole_project("comercial", vec![w("07:00", "12:00")]))
        .await
        .unwrap()
        .schedule
        .id;

    h.tick("2026-11-17T06:59:40Z").await; // primeira avaliação: só registra o instante
    let report = h.tick("2026-11-17T07:00:10Z").await;
    assert_eq!(report.executed, 1);
    assert_eq!(
        h.runs(id).await,
        [("07:00".into(), PowerKind::Start, RunStatus::Executed)]
    );
    // worker estava desligado: um redeploy; os demais já estavam ligados.
    assert_eq!(
        h.railway.mutation_calls(),
        [format!("deploymentRedeploy({})", rid::<String>(101))]
    );

    let history = h
        .power
        .get(
            h.schedules.runs(id, None, None).await.unwrap().items[0]
                .operation_id
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(history.0.trigger, OperationTrigger::Schedule);
    assert_eq!(history.0.schedule_name.as_deref(), Some("comercial"));

    // Mesmo instante de novo e "reinício": nada é repetido.
    h.tick("2026-11-17T07:00:10Z").await;
    h.scheduler.startup().await.unwrap();
    h.tick("2026-11-17T07:00:40Z").await;
    assert_eq!(h.runs(id).await.len(), 1);
    assert_eq!(h.railway.mutation_calls().len(), 1);

    // Às 12:00 desliga.
    h.tick("2026-11-17T12:00:05Z").await;
    assert_eq!(
        h.runs(id).await[1],
        ("12:00".into(), PowerKind::Stop, RunStatus::Executed)
    );
    assert!(
        h.railway
            .mutation_calls()
            .iter()
            .filter(|c| c.starts_with("deploymentRemove"))
            .count()
            >= 2
    );
}

#[tokio::test]
async fn volta_dentro_do_limite_executa_atrasado() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let id = h
        .schedules
        .create(p, whole_project("comercial", vec![w("07:00", "12:00")]))
        .await
        .unwrap()
        .schedule
        .id;
    h.tick("2026-11-17T06:55:00Z").await;
    h.tick("2026-11-17T07:10:00Z").await;
    assert_eq!(
        h.runs(id).await,
        [("07:00".into(), PowerKind::Start, RunStatus::Late)]
    );
}

#[tokio::test]
async fn volta_fora_do_limite_registra_perdidos() {
    let h = scheduling_harness(utc("2026-11-17T05:00:00Z")).await;
    let p = loja(&h).await;
    let id = h
        .schedules
        .create(
            p,
            whole_project("comercial", vec![w("07:00", "12:00"), w("13:00", "18:00")]),
        )
        .await
        .unwrap()
        .schedule
        .id;
    h.tick("2026-11-17T06:00:00Z").await;
    let report = h.tick("2026-11-17T13:20:00Z").await;
    assert_eq!((report.missed, report.executed), (2, 1));
    assert_eq!(
        h.runs(id).await,
        [
            ("07:00".into(), PowerKind::Start, RunStatus::Missed),
            ("12:00".into(), PowerKind::Stop, RunStatus::Missed),
            ("13:00".into(), PowerKind::Start, RunStatus::Late),
        ]
    );
}

#[tokio::test]
async fn pausa_e_retomada_nao_recuperam_eventos() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let id = h
        .schedules
        .create(p, whole_project("comercial", vec![w("07:00", "12:00")]))
        .await
        .unwrap()
        .schedule
        .id;
    h.tick("2026-11-17T06:50:00Z").await;
    h.schedules.pause(id).await.unwrap();
    h.tick("2026-11-17T07:00:10Z").await;
    h.at("2026-11-17T07:05:00Z");
    h.schedules.resume(id).await.unwrap();
    h.tick("2026-11-17T07:06:00Z").await;
    assert!(h.runs(id).await.is_empty());
    assert!(h.railway.mutation_calls().is_empty());
}

#[tokio::test]
async fn sem_credencial_falha_sem_chamar_o_railway() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let id = h
        .schedules
        .create(p, whole_project("comercial", vec![w("07:00", "12:00")]))
        .await
        .unwrap()
        .schedule
        .id;
    h.credentials.remove().await.unwrap();
    h.tick("2026-11-17T06:59:00Z").await;
    let before = h.railway.calls().len();
    let report = h.tick("2026-11-17T07:00:10Z").await;
    assert_eq!(report.failed, 1);
    assert_eq!(
        h.runs(id).await,
        [("07:00".into(), PowerKind::Start, RunStatus::Failed)]
    );
    let run = &h.schedules.runs(id, None, None).await.unwrap().items[0];
    assert!(
        run.message
            .as_deref()
            .unwrap()
            .contains("integração não configurada")
    );
    assert_eq!(h.railway.calls().len(), before);
}

#[tokio::test]
async fn iniciar_prevalece_entre_agendas_no_mesmo_instante() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let worker = instance(&h, p, "production", "worker").await;
    let a = h
        .schedules
        .create(p, only("manhã", vec![w("07:00", "12:00")], vec![worker]))
        .await
        .unwrap()
        .schedule
        .id;
    let b = h
        .schedules
        .create(p, only("tarde", vec![w("12:00", "15:00")], vec![worker]))
        .await
        .unwrap()
        .schedule
        .id;

    h.tick("2026-11-17T11:59:00Z").await;
    let before = h.railway.mutation_calls().len();
    h.tick("2026-11-17T12:00:10Z").await;

    let stop = &h.schedules.runs(a, None, None).await.unwrap().items[0];
    assert_eq!(
        (stop.action, stop.status),
        (PowerKind::Stop, RunStatus::Skipped)
    );
    assert!(
        stop.message.as_deref().unwrap().contains("tarde"),
        "{:?}",
        stop.message
    );
    let start = &h.schedules.runs(b, None, None).await.unwrap().items[0];
    assert_eq!(
        (start.action, start.status),
        (PowerKind::Start, RunStatus::Executed)
    );
    assert!(
        start.message.as_deref().unwrap().contains("manhã"),
        "{:?}",
        start.message
    );
    let new: Vec<_> = h.railway.mutation_calls()[before..].to_vec();
    assert!(
        new.iter().all(|c| !c.starts_with("deploymentRemove")),
        "{new:?}"
    );
}

#[tokio::test]
async fn instancia_em_operacao_manual_e_ignorada() {
    let h = scheduling_harness(utc("2026-11-17T06:00:00Z")).await;
    let p = loja(&h).await;
    let api = instance(&h, p, "production", "api").await;
    let id = h
        .schedules
        .create(p, only("noite", vec![w("06:00", "07:00")], vec![api]))
        .await
        .unwrap()
        .schedule
        .id;
    h.tick("2026-11-17T06:59:00Z").await;

    // Desligamento manual em andamento quando o evento chega.
    h.railway.mutation_delay(Duration::from_millis(300));
    let manual = h
        .power
        .plan(
            PowerKind::Stop,
            &application::power::PowerTarget::Instance(api),
        )
        .await
        .unwrap();
    h.power.execute(manual.plan.id, "admin").await.unwrap();

    h.at("2026-11-17T07:00:10Z");
    h.scheduler.tick(utc("2026-11-17T07:00:10Z")).await.unwrap();
    h.power.wait_idle().await;
    let run = &h.schedules.runs(id, None, None).await.unwrap().items[0];
    assert_eq!(run.status, RunStatus::Executed);
    let (_, items) = h.power.get(run.operation_id.unwrap()).await.unwrap();
    assert_eq!(items[0].result, ItemResult::Skipped);
    assert_eq!(
        items[0].error_message.as_deref(),
        Some("operação em andamento")
    );
}
