//! Repositório de ações agendadas em SQLite em memória.

use application::ports::{RepoError, ScheduledActionRepository};
use chrono::{DateTime, Duration, Utc};
use domain::ids::{ProjectId, ServiceInstanceId};
use domain::power::PowerKind;
use domain::scheduled_action::{
    ActionTarget, ScheduledAction, ScheduledActionSpec, ScheduledActionStatus,
};
use infrastructure::sqlite::{SqliteScheduledActions, connect};
use sqlx::SqlitePool;

const P1: &str = "00000000-0000-4000-8000-000000000001";
const I1: &str = "00000000-0000-4000-8000-000000000011";

async fn pool() -> SqlitePool {
    let pool = connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "INSERT INTO projects (id, railway_project_id, name, created_at, sync_status)
             VALUES ('{P1}', 'rp1', 'loja', '2026-11-16T10:00:00.000Z', 'ok');
         INSERT INTO environments (id, project_id, railway_environment_id, name, is_ephemeral)
             VALUES ('e1', '{P1}', 're1', 'production', 0);
         INSERT INTO services (id, project_id, railway_service_id, name) VALUES ('s1', '{P1}', 'rs1', 'api');
         INSERT INTO service_instances (id, project_id, service_id, environment_id)
             VALUES ('{I1}', '{P1}', 's1', 'e1');"
    )))
    .execute(&pool)
    .await
    .unwrap();
    pool
}

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-17T14:48:00Z")
        .unwrap()
        .to_utc()
}

fn action(minutes: i64, target: ActionTarget) -> ScheduledAction {
    let spec = ScheduledActionSpec {
        kind: PowerKind::Stop,
        run_at: now() + Duration::minutes(minutes),
        target,
        note: Some("fim do dia".into()),
    };
    ScheduledAction::new(spec, "rótulo".into(), now())
}

fn all() -> ActionTarget {
    ActionTarget::All {
        environment_name: Some("production".into()),
    }
}

#[tokio::test]
async fn grava_e_le_os_tres_alvos() {
    let repo = SqliteScheduledActions::new(pool().await);
    let p: ProjectId = P1.parse().unwrap();
    let i: ServiceInstanceId = I1.parse().unwrap();
    let a = action(60, all());
    let b = action(
        30,
        ActionTarget::Projects {
            project_ids: vec![p],
            environment_name: None,
        },
    );
    let c = action(
        90,
        ActionTarget::Instances {
            instance_ids: vec![i],
        },
    );
    for x in [&a, &b, &c] {
        repo.insert(x).await.unwrap();
    }
    for x in [&a, &b, &c] {
        assert_eq!(repo.get(x.id).await.unwrap().as_ref(), Some(x));
    }
}

#[tokio::test]
async fn lista_pendentes_primeiro_e_filtra() {
    let repo = SqliteScheduledActions::new(pool().await);
    let later = action(120, all());
    let soon = action(10, all());
    let done = action(5, all());
    for x in [&later, &soon, &done] {
        repo.insert(x).await.unwrap();
    }
    assert!(repo.claim(done.id).await.unwrap());
    let mut finished = done.clone();
    finished.status = ScheduledActionStatus::Executed;
    finished.processed_at = Some(now());
    repo.finish(&finished).await.unwrap();

    let page = repo.list(None, 1, 50).await.unwrap();
    let order: Vec<_> = page.items.iter().map(|a| a.id).collect();
    assert_eq!(order, [soon.id, later.id, done.id]);
    let pending = repo
        .list(Some(ScheduledActionStatus::Pending), 1, 50)
        .await
        .unwrap();
    assert_eq!(pending.total, 2);
}

#[tokio::test]
async fn devidas_e_reivindicacao_unica() {
    let repo = SqliteScheduledActions::new(pool().await);
    let due = action(1, all());
    let future = action(60, all());
    repo.insert(&due).await.unwrap();
    repo.insert(&future).await.unwrap();

    let found = repo.due(now() + Duration::minutes(2)).await.unwrap();
    assert_eq!(found.iter().map(|a| a.id).collect::<Vec<_>>(), [due.id]);

    let (first, second) = tokio::join!(repo.claim(due.id), repo.claim(due.id));
    assert_eq!(
        [first.unwrap(), second.unwrap()]
            .iter()
            .filter(|c| **c)
            .count(),
        1,
        "só um ciclo vence"
    );
    assert!(
        repo.due(now() + Duration::minutes(2))
            .await
            .unwrap()
            .is_empty()
    );

    assert_eq!(
        repo.fail_processing("interrompida", now()).await.unwrap(),
        1
    );
    let failed = repo.get(due.id).await.unwrap().unwrap();
    assert_eq!(failed.status, ScheduledActionStatus::Failed);
    assert_eq!(failed.message.as_deref(), Some("interrompida"));
}

#[tokio::test]
async fn cancelar_so_pendente() {
    let repo = SqliteScheduledActions::new(pool().await);
    let a = action(60, all());
    repo.insert(&a).await.unwrap();
    let cancelled = repo.cancel(a.id, now()).await.unwrap().unwrap();
    assert_eq!(cancelled.status, ScheduledActionStatus::Cancelled);
    assert_eq!(
        repo.cancel(a.id, now()).await.unwrap(),
        Err(ScheduledActionStatus::Cancelled)
    );
    assert!(!repo.claim(a.id).await.unwrap(), "cancelada não executa");
    assert!(matches!(
        repo.cancel(domain::ids::ScheduledActionId::new(), now())
            .await,
        Err(RepoError::NotFound)
    ));
}

#[tokio::test]
async fn remover_projeto_e_instancia_os_retira_do_alvo() {
    let pool = pool().await;
    let repo = SqliteScheduledActions::new(pool.clone());
    let p: ProjectId = P1.parse().unwrap();
    let i: ServiceInstanceId = I1.parse().unwrap();
    let by_project = action(
        60,
        ActionTarget::Projects {
            project_ids: vec![p],
            environment_name: None,
        },
    );
    let by_instance = action(
        60,
        ActionTarget::Instances {
            instance_ids: vec![i],
        },
    );
    repo.insert(&by_project).await.unwrap();
    repo.insert(&by_instance).await.unwrap();
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(P1)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        repo.get(by_project.id).await.unwrap().unwrap().target,
        ActionTarget::Projects {
            project_ids: vec![],
            environment_name: None
        }
    );
    assert_eq!(
        repo.get(by_instance.id).await.unwrap().unwrap().target,
        ActionTarget::Instances {
            instance_ids: vec![]
        }
    );
}
