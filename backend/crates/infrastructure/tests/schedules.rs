//! Repositórios de agendas e execuções em SQLite.

use application::ports::*;
use chrono::{DateTime, Duration, Utc, Weekday};
use domain::catalog::{Environment, Project, Service, ServiceInstance};
use domain::ids::*;
use domain::power::PowerKind;
use domain::schedule::*;
use infrastructure::sqlite::*;
use sqlx::SqlitePool;

fn rid<T: std::str::FromStr>(n: u32) -> T
where
    T::Err: std::fmt::Debug,
{
    format!("00000000-0000-4000-8000-{n:012}").parse().unwrap()
}

fn utc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().to_utc()
}

struct Fx {
    pool: SqlitePool,
    project: Project,
    env: Environment,
    instances: Vec<ServiceInstance>,
}

async fn fixture() -> Fx {
    let pool = connect("sqlite::memory:").await.unwrap();
    let project = Project::new(CredentialId::new(), rid(1), "loja", None, Utc::now()).unwrap();
    let project = Project {
        credential_id: None,
        ..project
    };
    SqliteProjects::new(pool.clone())
        .insert(&project)
        .await
        .unwrap();
    let inv = SqliteInventory::new(pool.clone());
    let env = inv
        .upsert_environment(&Environment::new(project.id, rid(10), "production", false).unwrap())
        .await
        .unwrap();
    let mut instances = vec![];
    for n in 0..2 {
        let service = inv
            .upsert_service(&Service::new(project.id, rid(20 + n), &format!("svc{n}")).unwrap())
            .await
            .unwrap();
        let instance = ServiceInstance::new(&service, &env).unwrap();
        inv.insert_instance(&instance).await.unwrap();
        instances.push(instance);
    }
    Fx {
        pool,
        project,
        env,
        instances,
    }
}

fn spec(target: ScheduleTarget) -> ScheduleSpec {
    let t = |s: &str| s.parse::<LocalTime>().unwrap();
    ScheduleSpec {
        name: "comercial".into(),
        timezone: chrono_tz::America::Sao_Paulo,
        days: Weekdays::from_days(&[Weekday::Mon, Weekday::Fri]),
        windows: vec![
            Window {
                start: t("07:00"),
                end: t("12:00"),
            },
            Window {
                start: t("22:00"),
                end: t("02:00"),
            },
        ],
        target,
    }
}

#[tokio::test]
async fn agenda_ida_e_volta_com_janelas_alvo_e_fuso() {
    let fx = fixture().await;
    let repo = SqliteSchedules::new(fx.pool.clone());
    let now = utc("2026-11-17T10:00:00Z");
    let s = Schedule::new(
        fx.project.id,
        spec(ScheduleTarget::Project {
            environment_id: Some(fx.env.id),
        }),
        now,
    )
    .unwrap();
    repo.insert(&s).await.unwrap();
    assert_eq!(repo.get(s.id).await.unwrap().unwrap(), s);

    let mut by_instance = Schedule::new(
        fx.project.id,
        spec(ScheduleTarget::Instances {
            instance_ids: vec![fx.instances[0].id, fx.instances[1].id],
        }),
        now,
    )
    .unwrap();
    by_instance.name = "aaa".into();
    repo.insert(&by_instance).await.unwrap();
    let loaded = repo.get(by_instance.id).await.unwrap().unwrap();
    let ScheduleTarget::Instances { instance_ids } = &loaded.target else {
        panic!()
    };
    assert_eq!(instance_ids.len(), 2);

    let names: Vec<_> = repo
        .list(Some(fx.project.id))
        .await
        .unwrap()
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(names, ["aaa", "comercial"]);
    assert_eq!(repo.list(Some(ProjectId::new())).await.unwrap().len(), 0);
}

#[tokio::test]
async fn edicao_substitui_janelas_e_instancias() {
    let fx = fixture().await;
    let repo = SqliteSchedules::new(fx.pool.clone());
    let now = utc("2026-11-17T10:00:00Z");
    let mut s = Schedule::new(
        fx.project.id,
        spec(ScheduleTarget::Instances {
            instance_ids: vec![fx.instances[0].id, fx.instances[1].id],
        }),
        now,
    )
    .unwrap();
    repo.insert(&s).await.unwrap();

    let mut edited = spec(ScheduleTarget::Instances {
        instance_ids: vec![fx.instances[1].id],
    });
    edited.windows.truncate(1);
    edited.timezone = chrono_tz::UTC;
    s.update(edited, now + Duration::hours(1)).unwrap();
    repo.update(&s).await.unwrap();
    let loaded = repo.get(s.id).await.unwrap().unwrap();
    assert_eq!(loaded, s);
    assert_eq!(loaded.windows.len(), 1);

    s.pause(Some("manual".into()), now + Duration::hours(2));
    repo.update(&s).await.unwrap();
    assert!(!repo.get(s.id).await.unwrap().unwrap().enabled);

    repo.delete(s.id).await.unwrap();
    assert!(repo.get(s.id).await.unwrap().is_none());
    assert_eq!(repo.delete(s.id).await, Err(RepoError::NotFound));
}

#[tokio::test]
async fn instancia_inexistente_e_conflito() {
    let fx = fixture().await;
    let repo = SqliteSchedules::new(fx.pool.clone());
    let s = Schedule::new(
        fx.project.id,
        spec(ScheduleTarget::Instances {
            instance_ids: vec![ServiceInstanceId::new()],
        }),
        Utc::now(),
    )
    .unwrap();
    assert!(matches!(repo.insert(&s).await, Err(RepoError::Conflict(_))));
    assert!(
        repo.get(s.id).await.unwrap().is_none(),
        "nada é salvo pela metade"
    );
}

#[tokio::test]
async fn agenda_sem_instancias_e_pausada() {
    let fx = fixture().await;
    let repo = SqliteSchedules::new(fx.pool.clone());
    let only = fx.instances[0].id;
    let s = Schedule::new(
        fx.project.id,
        spec(ScheduleTarget::Instances {
            instance_ids: vec![only],
        }),
        Utc::now(),
    )
    .unwrap();
    let whole = Schedule::new(
        fx.project.id,
        spec(ScheduleTarget::Project {
            environment_id: None,
        }),
        Utc::now(),
    )
    .unwrap();
    repo.insert(&s).await.unwrap();
    repo.insert(&whole).await.unwrap();

    SqliteInventory::new(fx.pool.clone())
        .delete_instance(only)
        .await
        .unwrap();
    assert_eq!(
        repo.pause_without_targets("sem instâncias no alvo", Utc::now())
            .await
            .unwrap(),
        1
    );
    let paused = repo.get(s.id).await.unwrap().unwrap();
    assert!(!paused.enabled);
    assert_eq!(
        paused.paused_reason.as_deref(),
        Some("sem instâncias no alvo")
    );
    assert!(repo.get(whole.id).await.unwrap().unwrap().enabled);
}

fn run(schedule: ScheduleId, at: &str, action: PowerKind) -> ScheduleRun {
    ScheduleRun {
        id: ScheduleRunId::new(),
        schedule_id: schedule,
        schedule_name: "comercial".into(),
        action,
        scheduled_for: utc(at),
        processed_at: utc(at) + Duration::seconds(5),
        status: RunStatus::Pending,
        operation_id: None,
        message: None,
    }
}

#[tokio::test]
async fn execucoes_idempotentes_estado_e_listagem() {
    let fx = fixture().await;
    let schedules = SqliteSchedules::new(fx.pool.clone());
    let s = Schedule::new(
        fx.project.id,
        spec(ScheduleTarget::Project {
            environment_id: None,
        }),
        Utc::now(),
    )
    .unwrap();
    schedules.insert(&s).await.unwrap();
    let runs = SqliteScheduleRuns::new(fx.pool.clone());
    assert_eq!(runs.last_evaluated().await.unwrap(), None);

    let first = [
        run(s.id, "2026-11-17T10:00:00Z", PowerKind::Start),
        run(s.id, "2026-11-17T15:00:00Z", PowerKind::Stop),
    ];
    let inserted = runs
        .record_tick(&first, utc("2026-11-17T15:00:10Z"))
        .await
        .unwrap();
    assert_eq!(inserted.len(), 2);
    assert_eq!(
        runs.last_evaluated().await.unwrap(),
        Some(utc("2026-11-17T15:00:10Z"))
    );

    // Mesmo evento outra vez (ex.: reinício): ignorado. Relógio para trás não recua o estado.
    let again = [run(s.id, "2026-11-17T15:00:00Z", PowerKind::Stop)];
    assert!(
        runs.record_tick(&again, utc("2026-11-17T14:00:00Z"))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        runs.last_evaluated().await.unwrap(),
        Some(utc("2026-11-17T15:00:10Z"))
    );

    let mut done = inserted[1].clone();
    done.status = RunStatus::Executed;
    done.operation_id = Some(OperationId::new());
    runs.update(&done).await.unwrap();

    let page = runs.list(s.id, 1, 10).await.unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.items[0], done, "mais recente primeiro");
    assert_eq!(page.items[1].status, RunStatus::Pending);

    assert_eq!(
        runs.fail_pending("interrompido", Utc::now()).await.unwrap(),
        1
    );
    let page = runs.list(s.id, 1, 10).await.unwrap();
    assert_eq!(page.items[1].status, RunStatus::Failed);
    assert_eq!(page.items[1].message.as_deref(), Some("interrompido"));
}

async fn operation(
    fx: &Fx,
    trigger: domain::operation::OperationTrigger,
    schedule: Option<&Schedule>,
) {
    use domain::operation::*;
    use domain::power::Decision;
    use domain::state::ObservedState;
    let now = Utc::now();
    let instance = &fx.instances[0];
    let label = InstanceLabel {
        project_id: fx.project.id,
        project_name: "loja".into(),
        railway_project_id: rid(1),
        service_name: "svc0".into(),
        railway_service_id: rid(20),
        environment_name: "production".into(),
        railway_environment_id: rid(10),
    };
    let entry = PlanEntry {
        service_instance_id: instance.id,
        label: label.clone(),
        current_state: ObservedState::Stopped,
        decision: Decision::WillSkip {
            reason: domain::power::SkipReason::AlreadyInDesiredState,
        },
    };
    let plan = Plan::new(
        PowerKind::Stop,
        OperationScope::Project,
        vec![entry],
        now,
        now + Duration::minutes(5),
    )
    .unwrap();
    let plans = SqlitePlans::new(fx.pool.clone());
    plans.save(&plan).await.unwrap();
    let op = Operation {
        id: OperationId::new(),
        kind: PowerKind::Stop,
        scope: OperationScope::Project,
        trigger,
        schedule_id: schedule.map(|s| s.id),
        schedule_name: schedule.map(|s| s.name.clone()),
        requested_by: "agendador".into(),
        plan_id: plan.id,
        status: OperationStatus::Succeeded,
        created_at: now,
        started_at: None,
        finished_at: None,
    };
    let item = OperationItem {
        id: OperationItemId::new(),
        operation_id: op.id,
        service_instance_id: Some(instance.id),
        label,
        previous_state: ObservedState::Stopped,
        desired_state: ObservedState::Stopped,
        final_state: Some(ObservedState::Stopped),
        deployment_id: None,
        result: ItemResult::Skipped,
        error_message: None,
        started_at: None,
        finished_at: Some(now),
        duration_ms: Some(0),
    };
    plans.consume(plan.id, now, &op, &[item]).await.unwrap();
}

#[tokio::test]
async fn historico_filtra_por_origem_e_preserva_nome_da_agenda() {
    use domain::operation::OperationTrigger;
    let fx = fixture().await;
    let schedules = SqliteSchedules::new(fx.pool.clone());
    let s = Schedule::new(
        fx.project.id,
        spec(ScheduleTarget::Project {
            environment_id: None,
        }),
        Utc::now(),
    )
    .unwrap();
    schedules.insert(&s).await.unwrap();
    operation(&fx, OperationTrigger::Manual, None).await;
    operation(&fx, OperationTrigger::Schedule, Some(&s)).await;

    let ops = SqliteOperations::new(fx.pool.clone());
    let filter = HistoryFilter {
        trigger: Some(OperationTrigger::Schedule),
        ..Default::default()
    };
    let page = ops.history(&filter, 1, 50).await.unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].trigger, OperationTrigger::Schedule);
    assert_eq!(page.items[0].schedule_name.as_deref(), Some("comercial"));
    let manual = HistoryFilter {
        trigger: Some(OperationTrigger::Manual),
        ..Default::default()
    };
    assert_eq!(ops.history(&manual, 1, 50).await.unwrap().total, 1);

    schedules.delete(s.id).await.unwrap();
    let page = ops.history(&filter, 1, 50).await.unwrap();
    assert_eq!(page.items[0].schedule_name.as_deref(), Some("comercial"));
    let (op, _) = ops
        .get(page.items[0].item.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(op.schedule_id, Some(s.id));
}
