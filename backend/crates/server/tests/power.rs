//! Plano, execução e verificação de operações de energia com Railway falso.
//! Prazos e intervalos curtos em tempo real (ver `common::fast_power`).

mod common;

use std::time::Duration;

use application::error::AppError;
use application::inventory::InstanceRef;
use application::power::{PowerConfig, PowerTarget};
use application::railway::RailwayError;
use common::*;
use domain::deployment::{Deployment, DeploymentStatus};
use domain::ids::{ProjectId, ServiceInstanceId};
use domain::operation::{ItemResult, OperationStatus};
use domain::power::{Decision, PowerKind, SkipReason};
use domain::state::{InstanceSnapshot, ObservedState};

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

fn all(project: ProjectId) -> PowerTarget {
    PowerTarget::Project {
        project,
        environment: None,
        instances: None,
    }
}

async fn run(
    h: &Harness,
    kind: PowerKind,
    target: PowerTarget,
) -> (OperationStatus, Vec<(String, ItemResult)>) {
    let planned = h.power.plan(kind, &target).await.unwrap();
    let id = h.power.execute(planned.plan.id, "admin").await.unwrap();
    h.power.wait_idle().await;
    let (op, items) = h.power.get(id).await.unwrap();
    let items = items
        .into_iter()
        .map(|i| {
            (
                format!("{}@{}", i.label.service_name, i.label.environment_name),
                i.result,
            )
        })
        .collect();
    (op.status, items)
}

// ---------- 7.1 plano ----------

#[tokio::test]
async fn plano_de_instancia_lista_acao_e_tem_validade() {
    let h = harness().await;
    let p = loja(&h).await;
    let api = instance(&h, p, "production", "api").await;
    let planned = h
        .power
        .plan(PowerKind::Stop, &PowerTarget::Instance(api))
        .await
        .unwrap();
    let plan = planned.plan;
    assert_eq!(plan.entries.len(), 1);
    assert_eq!(plan.entries[0].current_state, ObservedState::Running);
    assert_eq!(
        plan.entries[0].decision,
        Decision::WillStop {
            deployments: vec![rid(100)]
        }
    );
    assert_eq!((plan.expires_at - plan.created_at).num_seconds(), 300);
    assert_eq!(planned.estimate.mutations, 1);
    assert!(
        h.railway.mutation_calls().is_empty(),
        "planejar não envia mutations"
    );
}

#[tokio::test]
async fn plano_de_projeto_com_filtro_de_ambiente_e_ignorados() {
    let h = harness().await;
    let p = loja(&h).await;
    let envs = h.inventory.local_environments(p).await.unwrap();
    let staging = envs.iter().find(|e| e.name == "staging").unwrap().id;

    let target = PowerTarget::Project {
        project: p,
        environment: Some(staging),
        instances: None,
    };
    let plan = h.power.plan(PowerKind::Stop, &target).await.unwrap().plan;
    let names: Vec<_> = plan
        .entries
        .iter()
        .map(|e| e.label.environment_name.as_str())
        .collect();
    assert_eq!(names, ["staging"]);

    let plan = h.power.plan(PowerKind::Stop, &all(p)).await.unwrap().plan;
    let worker = plan
        .entries
        .iter()
        .find(|e| e.label.service_name == "worker")
        .unwrap();
    assert_eq!(
        worker.decision,
        Decision::WillSkip {
            reason: SkipReason::AlreadyInDesiredState
        }
    );
    assert_eq!(plan.entries.len(), 3);
    // Uma leitura por ambiente.
    assert_eq!(
        plan.entries
            .iter()
            .filter(|e| matches!(e.decision, Decision::WillStop { .. }))
            .count(),
        2
    );
}

#[tokio::test]
async fn plano_em_lote_multi_projeto_agrupa_por_projeto() {
    let h = harness().await;
    let loja_id = loja(&h).await;
    h.railway
        .add_project(2, "blog", Some(900))
        .add_environment(2, 30, "production", false)
        .add_service(2, 40, "web")
        .add_stopped(2, 30, 40, 200);
    let blog = h
        .projects
        .register(&rid::<String>(2), None)
        .await
        .unwrap()
        .id;
    h.inventory.import(blog, &[pair(30, 40)]).await.unwrap();

    let target = PowerTarget::Batch {
        projects: vec![loja_id, blog],
        environment_name: Some("Production".into()),
    };
    let plan = h.power.plan(PowerKind::Start, &target).await.unwrap().plan;
    let mut rows: Vec<_> = plan
        .entries
        .iter()
        .map(|e| {
            (
                e.label.project_name.as_str(),
                e.label.service_name.as_str(),
                matches!(e.decision, Decision::WillStart { .. }),
            )
        })
        .collect();
    rows.sort();
    assert_eq!(
        rows,
        [
            ("blog", "web", true),
            ("loja", "api", false),
            ("loja", "worker", true)
        ]
    );
}

#[tokio::test]
async fn alvo_vazio_e_invalido() {
    let h = harness().await;
    let p = loja(&h).await;
    let target = PowerTarget::Project {
        project: p,
        environment: None,
        instances: Some(vec![]),
    };
    assert!(matches!(
        h.power.plan(PowerKind::Stop, &target).await,
        Err(AppError::Validation(_))
    ));
    let target = PowerTarget::Batch {
        projects: vec![],
        environment_name: None,
    };
    assert!(matches!(
        h.power.plan(PowerKind::Stop, &target).await,
        Err(AppError::Validation(_))
    ));
}

// ---------- 7.2 execução ----------

#[tokio::test]
async fn desligar_projeto_pula_quem_ja_esta_parado() {
    let h = harness().await;
    let p = loja(&h).await;
    let (status, items) = run(&h, PowerKind::Stop, all(p)).await;
    assert_eq!(status, OperationStatus::Succeeded);
    assert_eq!(
        items,
        [
            ("api@production".into(), ItemResult::Succeeded),
            ("worker@production".into(), ItemResult::Skipped),
            ("api@staging".into(), ItemResult::Succeeded),
        ]
    );
    let mut mutations = h.railway.mutation_calls();
    mutations.sort();
    assert_eq!(
        mutations,
        [
            format!("deploymentRemove({})", rid::<String>(100)),
            format!("deploymentRemove({})", rid::<String>(102))
        ]
    );
    let states: Vec<_> = h
        .inventory
        .local_instances(Some(p))
        .await
        .unwrap()
        .iter()
        .map(|v| v.instance.observed_state)
        .collect();
    assert!(
        states.iter().all(|s| *s == ObservedState::Stopped),
        "{states:?}"
    );
}

#[tokio::test]
async fn uma_falha_em_cinco_nao_interrompe_as_demais() {
    let h = harness().await;
    h.with_account().await;
    h.railway
        .add_project(1, "loja", Some(900))
        .add_environment(1, 10, "production", false);
    let mut refs = vec![];
    for n in 0..5 {
        h.railway
            .add_service(1, 20 + n, &format!("svc{n}"))
            .add_running(1, 10, 20 + n, 100 + n);
        refs.push(pair(10, 20 + n));
    }
    h.railway
        .fail_deployment(102, RailwayError::Unknown("boom".into()));
    let p = h
        .projects
        .register(&rid::<String>(1), None)
        .await
        .unwrap()
        .id;
    h.inventory.import(p, &refs).await.unwrap();

    let (status, items) = run(&h, PowerKind::Stop, all(p)).await;
    assert_eq!(status, OperationStatus::PartiallyFailed);
    let failed: Vec<_> = items
        .iter()
        .filter(|(_, r)| *r == ItemResult::Failed)
        .map(|(n, _)| n.as_str())
        .collect();
    assert_eq!(failed, ["svc2@production"]);
    assert_eq!(
        items
            .iter()
            .filter(|(_, r)| *r == ItemResult::Succeeded)
            .count(),
        4
    );
}

#[tokio::test]
async fn limite_de_concorrencia_e_respeitado() {
    let h = harness().await;
    h.with_account().await;
    h.railway
        .add_project(1, "loja", Some(900))
        .add_environment(1, 10, "production", false)
        .mutation_delay(Duration::from_millis(40));
    let mut refs = vec![];
    for n in 0..20 {
        h.railway
            .add_service(1, 20 + n, &format!("svc{n:02}"))
            .add_running(1, 10, 20 + n, 100 + n);
        refs.push(pair(10, 20 + n));
    }
    let p = h
        .projects
        .register(&rid::<String>(1), None)
        .await
        .unwrap()
        .id;
    h.inventory.import(p, &refs).await.unwrap();

    let (status, items) = run(&h, PowerKind::Stop, all(p)).await;
    assert_eq!(status, OperationStatus::Succeeded);
    assert_eq!(items.len(), 20);
    assert_eq!(h.railway.max_in_flight(), 3);
}

#[tokio::test]
async fn estado_da_tela_desatualizado_usa_o_railway() {
    let h = harness().await;
    let p = loja(&h).await;
    let api = instance(&h, p, "staging", "api").await;
    let planned = h
        .power
        .plan(PowerKind::Stop, &PowerTarget::Instance(api))
        .await
        .unwrap();
    // Entre o plano e a execução, alguém desligou pelo painel do Railway.
    let removed = Deployment {
        id: rid(102),
        status: DeploymentStatus::Removed,
        can_redeploy: true,
        stopped: false,
    };
    h.railway.set_snapshot(
        11,
        20,
        InstanceSnapshot {
            deleted: false,
            latest: Some(removed),
            active: vec![],
        },
    );

    let id = h.power.execute(planned.plan.id, "admin").await.unwrap();
    h.power.wait_idle().await;
    let (_, items) = h.power.get(id).await.unwrap();
    assert_eq!(items[0].result, ItemResult::Skipped);
    assert_eq!(
        items[0].error_message.as_deref(),
        Some("já está no estado desejado")
    );
    assert!(h.railway.mutation_calls().is_empty());
}

#[tokio::test]
async fn iniciar_sem_deployment_reaproveitavel_falha_sem_mutation() {
    let h = harness().await;
    let p = loja(&h).await;
    let worker = instance(&h, p, "production", "worker").await;
    let no_image = Deployment {
        id: rid(101),
        status: DeploymentStatus::Removed,
        can_redeploy: false,
        stopped: false,
    };
    h.railway.set_snapshot(
        10,
        21,
        InstanceSnapshot {
            deleted: false,
            latest: Some(no_image),
            active: vec![],
        },
    );

    let (status, items) = run(&h, PowerKind::Start, PowerTarget::Instance(worker)).await;
    assert_eq!(status, OperationStatus::Failed);
    assert_eq!(items[0].1, ItemResult::Failed);
    assert!(
        h.railway.mutation_calls().is_empty(),
        "nenhum novo build é disparado"
    );
    let history = h
        .power
        .plan(PowerKind::Start, &PowerTarget::Instance(worker))
        .await
        .unwrap();
    assert_eq!(
        history.plan.entries[0].decision,
        Decision::WillSkip {
            reason: SkipReason::NoReusableDeployment
        }
    );
}

#[tokio::test]
async fn plano_reutilizado_expirado_inexistente_e_conflito() {
    let h = harness_with_power(PowerConfig {
        plan_ttl: Duration::from_millis(300),
        ..fast_power()
    })
    .await;
    let p = loja(&h).await;
    let api = instance(&h, p, "production", "api").await;

    let first = h
        .power
        .plan(PowerKind::Stop, &PowerTarget::Instance(api))
        .await
        .unwrap()
        .plan;
    let op = h.power.execute(first.id, "admin").await.unwrap();
    assert_eq!(
        h.power.execute(first.id, "admin").await.unwrap_err(),
        AppError::PlanAlreadyUsed(Some(op))
    );

    // Enquanto a primeira está ativa, uma individual sobre a mesma instância é recusada.
    let second = h
        .power
        .plan(PowerKind::Stop, &PowerTarget::Instance(api))
        .await
        .unwrap()
        .plan;
    assert_eq!(
        second.entries[0].decision,
        Decision::WillSkip {
            reason: SkipReason::OperationInProgress
        }
    );
    assert!(matches!(
        h.power.execute(second.id, "admin").await,
        Err(AppError::Conflict(_))
    ));
    h.power.wait_idle().await;

    let stale = h
        .power
        .plan(PowerKind::Start, &PowerTarget::Instance(api))
        .await
        .unwrap()
        .plan;
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(matches!(
        h.power.execute(stale.id, "admin").await,
        Err(AppError::Gone(_))
    ));
    assert!(matches!(
        h.power.execute(domain::ids::PlanId::new(), "admin").await,
        Err(AppError::Validation(_))
    ));
}

#[tokio::test]
async fn mutation_com_resultado_incerto_nao_e_reenviada_e_e_verificada() {
    let h = harness().await;
    let p = loja(&h).await;
    h.railway.uncertain(100);
    let api = instance(&h, p, "production", "api").await;
    let (status, items) = run(&h, PowerKind::Stop, PowerTarget::Instance(api)).await;
    assert_eq!(status, OperationStatus::Succeeded);
    assert_eq!(items[0].1, ItemResult::Succeeded);
    assert_eq!(
        h.railway.mutation_calls().len(),
        1,
        "mutation incerta não é reenviada"
    );
}

#[tokio::test]
async fn rate_limit_em_mutation_aguarda_e_reenvia() {
    let h = harness().await;
    let p = loja(&h).await;
    h.railway.fail_next(
        "deploymentRemove",
        RailwayError::RateLimited {
            retry_after_secs: 1,
        },
    );
    let api = instance(&h, p, "production", "api").await;
    let start = tokio::time::Instant::now();
    let (status, _) = run(&h, PowerKind::Stop, PowerTarget::Instance(api)).await;
    assert_eq!(status, OperationStatus::Succeeded);
    assert!(start.elapsed() >= Duration::from_secs(1));
    assert_eq!(h.railway.mutation_calls().len(), 2);
}

// ---------- 7.3 verificação ----------

#[tokio::test]
async fn inicio_confirmado_apos_transicoes() {
    let h = harness().await;
    let p = loja(&h).await;
    h.railway.settle_after(3);
    let worker = instance(&h, p, "production", "worker").await;
    let (status, items) = run(&h, PowerKind::Start, PowerTarget::Instance(worker)).await;
    assert_eq!(status, OperationStatus::Succeeded);
    assert_eq!(items[0].1, ItemResult::Succeeded);
    assert_eq!(
        h.railway.mutation_calls(),
        [format!("deploymentRedeploy({})", rid::<String>(101))]
    );
    let view = h.inventory.local_instances(Some(p)).await.unwrap();
    let worker = view.iter().find(|v| v.instance.id == worker).unwrap();
    assert_eq!(worker.instance.observed_state, ObservedState::Running);
}

#[tokio::test]
async fn deployment_que_falha_ao_subir_e_falha() {
    let h = harness().await;
    let p = loja(&h).await;
    h.railway
        .redeploy_outcome(101, DeploymentStatus::Crashed)
        .settle_after(1);
    let worker = instance(&h, p, "production", "worker").await;
    let planned = h
        .power
        .plan(PowerKind::Start, &PowerTarget::Instance(worker))
        .await
        .unwrap();
    let id = h.power.execute(planned.plan.id, "admin").await.unwrap();
    h.power.wait_idle().await;
    let (op, items) = h.power.get(id).await.unwrap();
    assert_eq!(op.status, OperationStatus::Failed);
    assert_eq!(items[0].result, ItemResult::Failed);
    assert!(
        items[0]
            .error_message
            .as_deref()
            .unwrap()
            .contains("CRASHED")
    );
    assert_eq!(items[0].final_state, Some(ObservedState::Failed));
}

#[tokio::test]
async fn sem_confirmacao_no_prazo_e_timed_out() {
    let h = harness().await;
    let p = loja(&h).await;
    h.railway.stuck(100);
    let api = instance(&h, p, "production", "api").await;
    let start = tokio::time::Instant::now();
    let planned = h
        .power
        .plan(PowerKind::Stop, &PowerTarget::Instance(api))
        .await
        .unwrap();
    let id = h.power.execute(planned.plan.id, "admin").await.unwrap();
    h.power.wait_idle().await;
    assert!(
        start.elapsed() >= Duration::from_millis(800),
        "{:?}",
        start.elapsed()
    );
    let (op, items) = h.power.get(id).await.unwrap();
    assert_eq!(items[0].result, ItemResult::TimedOut);
    assert_eq!(items[0].final_state, Some(ObservedState::Running));
    assert_eq!(op.status, OperationStatus::Failed);
    assert!(items[0].duration_ms.unwrap() >= 0);
}

#[tokio::test]
async fn polling_e_agrupado_por_ambiente() {
    let h = harness().await;
    h.with_account().await;
    h.railway
        .add_project(1, "loja", Some(900))
        .add_environment(1, 10, "production", false)
        .settle_after(4);
    let mut refs = vec![];
    for n in 0..3 {
        h.railway
            .add_service(1, 20 + n, &format!("svc{n}"))
            .add_running(1, 10, 20 + n, 100 + n);
        refs.push(pair(10, 20 + n));
    }
    let p = h
        .projects
        .register(&rid::<String>(1), None)
        .await
        .unwrap()
        .id;
    h.inventory.import(p, &refs).await.unwrap();
    let before = h.railway.calls().len();

    let (status, _) = run(&h, PowerKind::Stop, all(p)).await;
    assert_eq!(status, OperationStatus::Succeeded);
    let reads = h.railway.calls()[before..]
        .iter()
        .filter(|c| c.starts_with("list_service_instances"))
        .count();
    // Sem agrupamento seriam ≥ 3 instâncias × (1 pré-condição + 5 ciclos) + 1 do plano.
    assert!(reads < 3 * 6, "{reads} leituras");
}

#[tokio::test]
async fn iniciar_parada_sem_latest_deployment_usa_o_ultimo_deployment() {
    // O Railway real não devolve deployments REMOVED em `latestDeployment`.
    let h = harness().await;
    h.railway.railway_like_latest();
    let p = loja(&h).await;
    let worker = instance(&h, p, "production", "worker").await;

    let planned = h
        .power
        .plan(PowerKind::Start, &PowerTarget::Instance(worker))
        .await
        .unwrap();
    assert_eq!(
        planned.plan.entries[0].current_state,
        ObservedState::Stopped
    );
    assert_eq!(
        planned.plan.entries[0].decision,
        Decision::WillStart {
            from_deployment: rid(101)
        }
    );

    let id = h.power.execute(planned.plan.id, "admin").await.unwrap();
    h.power.wait_idle().await;
    let (op, items) = h.power.get(id).await.unwrap();
    assert_eq!(op.status, OperationStatus::Succeeded);
    assert_eq!(items[0].result, ItemResult::Succeeded);
    assert_eq!(
        h.railway.mutation_calls(),
        [format!("deploymentRedeploy({})", rid::<String>(101))]
    );
}

#[tokio::test]
async fn desligar_e_religar_com_railway_real_sem_latest() {
    let h = harness().await;
    h.railway.railway_like_latest();
    let p = loja(&h).await;
    let api = instance(&h, p, "staging", "api").await;
    let (status, _) = run(&h, PowerKind::Stop, PowerTarget::Instance(api)).await;
    assert_eq!(status, OperationStatus::Succeeded);
    let (status, items) = run(&h, PowerKind::Start, PowerTarget::Instance(api)).await;
    assert_eq!(status, OperationStatus::Succeeded, "{items:?}");
    assert_eq!(
        h.railway.mutation_calls(),
        [
            format!("deploymentRemove({})", rid::<String>(102)),
            format!("deploymentRedeploy({})", rid::<String>(102)),
        ]
    );
}

#[tokio::test]
async fn sem_nenhum_deployment_no_historico_continua_falhando_com_motivo() {
    let h = harness().await;
    let p = loja(&h).await;
    let worker = instance(&h, p, "production", "worker").await;
    h.railway.set_snapshot(
        10,
        21,
        InstanceSnapshot {
            deleted: false,
            latest: None,
            active: vec![],
        },
    );
    let planned = h
        .power
        .plan(PowerKind::Start, &PowerTarget::Instance(worker))
        .await
        .unwrap();
    assert_eq!(
        planned.plan.entries[0].decision,
        Decision::WillSkip {
            reason: SkipReason::LatestNotStopped { status: None }
        }
    );
}

#[tokio::test]
async fn iniciar_usa_o_ultimo_commit_e_nao_o_latest_deployment_antigo() {
    // Caso real: `latestDeployment` aponta para uma falha antiga marcada como parada;
    // o histórico indica o deploy mais recente que subiu.
    let h = harness().await;
    let p = loja(&h).await;
    let worker = instance(&h, p, "production", "worker").await;
    let old_failure = Deployment {
        id: rid(900),
        status: DeploymentStatus::Failed,
        can_redeploy: true,
        stopped: true,
    };
    h.railway.set_snapshot(
        10,
        21,
        InstanceSnapshot {
            deleted: false,
            latest: Some(old_failure),
            active: vec![],
        },
    );
    h.railway.restart_from(
        10,
        21,
        Deployment {
            id: rid(300),
            status: DeploymentStatus::Removed,
            can_redeploy: true,
            stopped: false,
        },
    );

    let planned = h
        .power
        .plan(PowerKind::Start, &PowerTarget::Instance(worker))
        .await
        .unwrap();
    assert_eq!(
        planned.plan.entries[0].decision,
        Decision::WillStart {
            from_deployment: rid(300)
        }
    );

    let id = h.power.execute(planned.plan.id, "admin").await.unwrap();
    h.power.wait_idle().await;
    let (op, _) = h.power.get(id).await.unwrap();
    assert_eq!(op.status, OperationStatus::Succeeded);
    assert_eq!(
        h.railway.mutation_calls(),
        [format!("deploymentRedeploy({})", rid::<String>(300))]
    );
}

#[tokio::test]
async fn iniciar_em_transicao_nao_consulta_historico_nem_age() {
    let h = harness().await;
    let p = loja(&h).await;
    let worker = instance(&h, p, "production", "worker").await;
    let building = Deployment {
        id: rid(901),
        status: DeploymentStatus::Building,
        can_redeploy: false,
        stopped: false,
    };
    h.railway.set_snapshot(
        10,
        21,
        InstanceSnapshot {
            deleted: false,
            latest: Some(building),
            active: vec![],
        },
    );
    let before = h.railway.calls().len();
    let planned = h
        .power
        .plan(PowerKind::Start, &PowerTarget::Instance(worker))
        .await
        .unwrap();
    assert_eq!(
        planned.plan.entries[0].decision,
        Decision::WillSkip {
            reason: SkipReason::Transitioning
        }
    );
    assert!(
        !h.railway.calls()[before..]
            .iter()
            .any(|c| c.starts_with("restart_source"))
    );
}

#[tokio::test]
async fn execucao_de_agenda_registra_origem_e_conflito_vira_skipped() {
    use domain::ids::ScheduleId;
    use domain::operation::OperationTrigger;
    let h = harness().await;
    let p = loja(&h).await;
    let api = instance(&h, p, "production", "api").await;

    // Uma operação manual ocupa a instância.
    h.railway.mutation_delay(Duration::from_millis(300));
    let manual = h
        .power
        .plan(PowerKind::Stop, &PowerTarget::Instance(api))
        .await
        .unwrap();
    h.power.execute(manual.plan.id, "admin").await.unwrap();

    let schedule = ScheduleId::new();
    let target = PowerTarget::Project {
        project: p,
        environment: None,
        instances: Some(vec![api]),
    };
    let planned = h.power.plan(PowerKind::Stop, &target).await.unwrap();
    let id = h
        .power
        .execute_scheduled(planned.plan.id, schedule, "comercial")
        .await
        .unwrap();
    h.power.wait_idle().await;

    let (op, items) = h.power.get(id).await.unwrap();
    assert_eq!(op.trigger, OperationTrigger::Schedule);
    assert_eq!(op.schedule_id, Some(schedule));
    assert_eq!(op.schedule_name.as_deref(), Some("comercial"));
    assert_eq!(op.requested_by, "agendador");
    assert_eq!(items[0].result, ItemResult::Skipped);
    assert_eq!(
        items[0].error_message.as_deref(),
        Some("operação em andamento")
    );
}
