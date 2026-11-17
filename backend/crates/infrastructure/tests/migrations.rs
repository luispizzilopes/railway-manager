//! Migrações sobre um banco com dados: a reconstrução de `operations` não pode
//! perder operações nem itens do histórico.

use std::str::FromStr;

use infrastructure::sqlite::{MIGRATOR, connect};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

const INIT: i64 = 20261116000001;

async fn pool_at(path: &std::path::Path) -> SqlitePool {
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
        .unwrap()
        .create_if_missing(true)
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap()
}

async fn count(pool: &SqlitePool, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn reconstrucao_de_operations_preserva_o_historico() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("antigo.db");
    let pool = pool_at(&path).await;
    MIGRATOR.run_to(INIT, &pool).await.unwrap();

    // Dados no formato da versão anterior.
    sqlx::raw_sql(
        "INSERT INTO projects (id, railway_project_id, name, created_at, sync_status)
             VALUES ('p1', 'rp1', 'loja', '2026-11-16T10:00:00.000Z', 'ok');
         INSERT INTO environments (id, project_id, railway_environment_id, name, is_ephemeral)
             VALUES ('e1', 'p1', 're1', 'production', 0);
         INSERT INTO services (id, project_id, railway_service_id, name) VALUES ('s1', 'p1', 'rs1', 'api');
         INSERT INTO service_instances (id, project_id, service_id, environment_id) VALUES ('i1', 'p1', 's1', 'e1');
         INSERT INTO operation_plans (id, payload_json, created_at, expires_at, consumed_at)
             VALUES ('plan1', '{}', '2026-11-16T10:00:00.000Z', '2026-11-16T10:05:00.000Z', '2026-11-16T10:01:00.000Z');
         INSERT INTO operations (id, kind, scope, trigger, requested_by, plan_id, status, created_at)
             VALUES ('op1', 'stop', 'project', 'manual', 'admin', 'plan1', 'succeeded', '2026-11-16T10:01:00.000Z');
         INSERT INTO operation_items (id, operation_id, service_instance_id, project_id, project_name,
             railway_project_id, service_name, railway_service_id, environment_name, railway_environment_id,
             previous_state, desired_state, result)
             VALUES ('it1', 'op1', 'i1', 'p1', 'loja', 'rp1', 'api', 'rs1', 'production', 're1',
                     'running', 'stopped', 'succeeded');",
    )
    .execute(&pool)
    .await
    .unwrap();

    MIGRATOR.run(&pool).await.unwrap();

    assert_eq!(count(&pool, "operations").await, 1);
    assert_eq!(count(&pool, "operation_items").await, 1);
    let trigger: String = sqlx::query_scalar("SELECT trigger FROM operations WHERE id = 'op1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(trigger, "manual");
    let violations: Vec<(String,)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(violations.is_empty(), "{violations:?}");
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fk, 1);

    // A nova origem é aceita só com o nome da agenda.
    sqlx::raw_sql(
        "INSERT INTO operation_plans (id, payload_json, created_at, expires_at)
             VALUES ('plan2', '{}', '2026-11-17T10:00:00.000Z', '2026-11-17T10:05:00.000Z');
         INSERT INTO operations (id, kind, scope, trigger, schedule_id, schedule_name, requested_by,
                                 plan_id, status, created_at)
             VALUES ('op2', 'start', 'project', 'schedule', 'sch1', 'comercial', 'agendador',
                     'plan2', 'pending', '2026-11-17T10:00:00.000Z');",
    )
    .execute(&pool)
    .await
    .unwrap();
    let missing_name = sqlx::raw_sql(
        "INSERT INTO operation_plans (id, payload_json, created_at, expires_at)
             VALUES ('plan3', '{}', '2026-11-17T10:00:00.000Z', '2026-11-17T10:05:00.000Z');
         INSERT INTO operations (id, kind, scope, trigger, requested_by, plan_id, status, created_at)
             VALUES ('op3', 'start', 'project', 'schedule', 'agendador', 'plan3', 'pending',
                     '2026-11-17T10:00:00.000Z');",
    )
    .execute(&pool)
    .await;
    assert!(missing_name.is_err());

    // A cascata de itens continua valendo depois da reconstrução.
    sqlx::query("DELETE FROM operations WHERE id = 'op1'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count(&pool, "operation_items").await, 0);
    pool.close().await;

    // Reabrir pelo caminho normal não reaplica nada.
    let reopened = connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    assert_eq!(count(&reopened, "operations").await, 1);
}

#[tokio::test]
async fn tabelas_de_agenda_e_cascatas() {
    let pool = connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO projects (id, railway_project_id, name, created_at, sync_status)
             VALUES ('p1', 'rp1', 'loja', '2026-11-16T10:00:00.000Z', 'ok');
         INSERT INTO environments (id, project_id, railway_environment_id, name, is_ephemeral)
             VALUES ('e1', 'p1', 're1', 'production', 0);
         INSERT INTO services (id, project_id, railway_service_id, name) VALUES ('s1', 'p1', 'rs1', 'api');
         INSERT INTO service_instances (id, project_id, service_id, environment_id) VALUES ('i1', 'p1', 's1', 'e1');
         INSERT INTO schedules (id, project_id, name, timezone, days_mask, target_kind, effective_from,
                                created_at, updated_at)
             VALUES ('sc1', 'p1', 'comercial', 'America/Sao_Paulo', 31, 'instances',
                     '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z');
         INSERT INTO schedule_windows (schedule_id, position, start_minute, end_minute) VALUES ('sc1', 0, 420, 720);
         INSERT INTO schedule_instances (schedule_id, service_instance_id) VALUES ('sc1', 'i1');
         INSERT INTO schedule_runs (id, schedule_id, schedule_name, action, scheduled_for, processed_at, status)
             VALUES ('r1', 'sc1', 'comercial', 'start', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:05.000Z', 'executed');",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Mesmo evento duas vezes é recusado.
    let duplicate = sqlx::query(
        "INSERT INTO schedule_runs (id, schedule_id, schedule_name, action, scheduled_for, processed_at, status)
             VALUES ('r2', 'sc1', 'comercial', 'start', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:06.000Z', 'executed')",
    )
    .execute(&pool)
    .await;
    assert!(duplicate.is_err());

    // Remover a instância a tira da agenda; remover o projeto apaga a agenda.
    sqlx::query("DELETE FROM service_instances WHERE id = 'i1'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count(&pool, "schedule_instances").await, 0);
    assert_eq!(count(&pool, "schedules").await, 1);
    sqlx::query("DELETE FROM projects WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    for table in ["schedules", "schedule_windows", "schedule_runs"] {
        assert_eq!(count(&pool, table).await, 0, "{table}");
    }
}

/// Versão com as agendas, antes das ações agendadas (change command-console).
const SCHEDULES: i64 = 20261117000002;

#[tokio::test]
async fn reconstrucao_aceita_origem_scheduled_action_sem_perder_historico() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agendas.db");
    let pool = pool_at(&path).await;
    MIGRATOR.run_to(SCHEDULES, &pool).await.unwrap();

    sqlx::raw_sql(
        "INSERT INTO projects (id, railway_project_id, name, created_at, sync_status)
             VALUES ('p1', 'rp1', 'loja', '2026-11-16T10:00:00.000Z', 'ok');
         INSERT INTO operation_plans (id, payload_json, created_at, expires_at)
             VALUES ('plan1', '{}', '2026-11-16T10:00:00.000Z', '2026-11-16T10:05:00.000Z'),
                    ('plan2', '{}', '2026-11-17T10:00:00.000Z', '2026-11-17T10:05:00.000Z');
         INSERT INTO operations (id, kind, scope, trigger, requested_by, plan_id, status, created_at)
             VALUES ('op1', 'stop', 'project', 'manual', 'admin', 'plan1', 'succeeded', '2026-11-16T10:01:00.000Z');
         INSERT INTO operations (id, kind, scope, trigger, schedule_id, schedule_name, requested_by,
                                 plan_id, status, created_at)
             VALUES ('op2', 'start', 'project', 'schedule', 'sch1', 'comercial', 'agendador',
                     'plan2', 'succeeded', '2026-11-17T10:00:00.000Z');
         INSERT INTO operation_items (id, operation_id, project_id, project_name,
             railway_project_id, service_name, railway_service_id, environment_name, railway_environment_id,
             previous_state, desired_state, result)
             VALUES ('it1', 'op1', 'p1', 'loja', 'rp1', 'api', 'rs1', 'production', 're1',
                     'running', 'stopped', 'succeeded'),
                    ('it2', 'op2', 'p1', 'loja', 'rp1', 'api', 'rs1', 'production', 're1',
                     'stopped', 'running', 'succeeded');",
    )
    .execute(&pool)
    .await
    .unwrap();

    MIGRATOR.run(&pool).await.unwrap();

    assert_eq!(count(&pool, "operations").await, 2);
    assert_eq!(count(&pool, "operation_items").await, 2);
    let name: String = sqlx::query_scalar("SELECT schedule_name FROM operations WHERE id = 'op2'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "comercial");
    let violations: Vec<(String,)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(violations.is_empty(), "{violations:?}");

    sqlx::raw_sql(
        "INSERT INTO operation_plans (id, payload_json, created_at, expires_at)
             VALUES ('plan3', '{}', '2026-11-17T18:00:00.000Z', '2026-11-17T18:05:00.000Z');
         INSERT INTO operations (id, kind, scope, trigger, scheduled_action_id, scheduled_action_label,
                                 requested_by, plan_id, status, created_at)
             VALUES ('op3', 'stop', 'batch', 'scheduled_action', 'a1', 'todos os projetos',
                     'agendador', 'plan3', 'pending', '2026-11-17T18:00:00.000Z');",
    )
    .execute(&pool)
    .await
    .unwrap();
    let missing_label = sqlx::raw_sql(
        "INSERT INTO operation_plans (id, payload_json, created_at, expires_at)
             VALUES ('plan4', '{}', '2026-11-17T18:00:00.000Z', '2026-11-17T18:05:00.000Z');
         INSERT INTO operations (id, kind, scope, trigger, requested_by, plan_id, status, created_at)
             VALUES ('op4', 'stop', 'batch', 'scheduled_action', 'agendador', 'plan4', 'pending',
                     '2026-11-17T18:00:00.000Z');",
    )
    .execute(&pool)
    .await;
    assert!(missing_label.is_err());

    sqlx::query("DELETE FROM operations WHERE id = 'op1'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count(&pool, "operation_items").await, 1, "cascata mantida");
}

#[tokio::test]
async fn tabelas_de_acoes_agendadas_e_cascatas() {
    let pool = connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO projects (id, railway_project_id, name, created_at, sync_status)
             VALUES ('p1', 'rp1', 'loja', '2026-11-16T10:00:00.000Z', 'ok');
         INSERT INTO environments (id, project_id, railway_environment_id, name, is_ephemeral)
             VALUES ('e1', 'p1', 're1', 'production', 0);
         INSERT INTO services (id, project_id, railway_service_id, name) VALUES ('s1', 'p1', 'rs1', 'api');
         INSERT INTO service_instances (id, project_id, service_id, environment_id) VALUES ('i1', 'p1', 's1', 'e1');
         INSERT INTO scheduled_actions (id, kind, run_at, target_kind, label, status, created_at)
             VALUES ('a1', 'stop', '2026-11-17T21:00:00.000Z', 'projects', 'loja', 'pending',
                     '2026-11-17T14:00:00.000Z'),
                    ('a2', 'start', '2026-11-18T10:00:00.000Z', 'instances', 'loja/api@production',
                     'pending', '2026-11-17T14:00:00.000Z');
         INSERT INTO scheduled_action_projects (action_id, project_id) VALUES ('a1', 'p1');
         INSERT INTO scheduled_action_instances (action_id, service_instance_id) VALUES ('a2', 'i1');",
    )
    .execute(&pool)
    .await
    .unwrap();

    let env_on_instances = sqlx::query(
        "INSERT INTO scheduled_actions (id, kind, run_at, target_kind, environment_name, label, status, created_at)
             VALUES ('a3', 'stop', '2026-11-17T21:00:00.000Z', 'instances', 'production', 'x', 'pending',
                     '2026-11-17T14:00:00.000Z')",
    )
    .execute(&pool)
    .await;
    assert!(env_on_instances.is_err());

    sqlx::query("DELETE FROM service_instances WHERE id = 'i1'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count(&pool, "scheduled_action_instances").await, 0);
    sqlx::query("DELETE FROM projects WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count(&pool, "scheduled_action_projects").await, 0);
    assert_eq!(
        count(&pool, "scheduled_actions").await,
        2,
        "as ações ficam (o alvo vazio vira `skipped` na execução)"
    );
}
