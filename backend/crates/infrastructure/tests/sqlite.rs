//! Repositórios SQLite: migrações, unicidade, cascatas, consumo atômico de planos,
//! conflitos de operação e recuperação após reinício.

use std::sync::Arc;

use application::ports::*;
use chrono::{Duration, Utc};
use domain::catalog::{Environment, Project, Service, ServiceInstance, SyncStatus};
use domain::credential::{CredentialKind, CredentialMetadata, CredentialStatus};
use domain::ids::*;
use domain::operation::{
    InstanceLabel, ItemResult, Operation, OperationItem, OperationScope, OperationStatus,
    OperationTrigger, Plan, PlanEntry,
};
use domain::power::{Decision, PowerKind, SkipReason};
use domain::state::ObservedState;
use domain::user::{Role, User, Username};
use infrastructure::sqlite::*;
use sqlx::SqlitePool;

fn rid<T: std::str::FromStr>(n: u32) -> T
where
    T::Err: std::fmt::Debug,
{
    format!("00000000-0000-4000-8000-{n:012}").parse().unwrap()
}

async fn memory() -> SqlitePool {
    connect("sqlite::memory:").await.unwrap()
}

struct Fixture {
    pool: SqlitePool,
    credential: CredentialId,
    project: Project,
    service: Service,
    prod: Environment,
    staging: Environment,
}

async fn credential(pool: &SqlitePool, label: &str) -> CredentialId {
    let meta = CredentialMetadata::validated(
        CredentialKind::Account,
        None,
        label,
        "tok-0123456789",
        Utc::now(),
    )
    .unwrap();
    let id = meta.id;
    SqliteCredentials::new(pool.clone())
        .replace(&StoredCredential {
            metadata: meta,
            sealed: SealedSecret {
                ciphertext: vec![1, 2, 3],
                nonce: vec![4; 24],
                key_version: 1,
            },
        })
        .await
        .unwrap();
    id
}

async fn fixture(pool: SqlitePool) -> Fixture {
    let credential = credential(&pool, "ana@example.com").await;
    let project = Project::new(credential, rid(1), "loja", None, Utc::now()).unwrap();
    SqliteProjects::new(pool.clone())
        .insert(&project)
        .await
        .unwrap();
    let inv = SqliteInventory::new(pool.clone());
    let service = inv
        .upsert_service(&Service::new(project.id, rid(20), "api").unwrap())
        .await
        .unwrap();
    let prod = inv
        .upsert_environment(&Environment::new(project.id, rid(10), "production", false).unwrap())
        .await
        .unwrap();
    let staging = inv
        .upsert_environment(&Environment::new(project.id, rid(11), "staging", false).unwrap())
        .await
        .unwrap();
    Fixture {
        pool,
        credential,
        project,
        service,
        prod,
        staging,
    }
}

async fn instance(f: &Fixture, env: &Environment) -> ServiceInstance {
    let i = ServiceInstance::new(&f.service, env).unwrap();
    SqliteInventory::new(f.pool.clone())
        .insert_instance(&i)
        .await
        .unwrap();
    i
}

fn label(f: &Fixture, env: &Environment) -> InstanceLabel {
    InstanceLabel {
        project_id: f.project.id,
        project_name: f.project.name.clone(),
        railway_project_id: f.project.railway_project_id.clone(),
        service_name: f.service.name.clone(),
        railway_service_id: f.service.railway_service_id.clone(),
        environment_name: env.name.clone(),
        railway_environment_id: env.railway_environment_id.clone(),
    }
}

async fn plan(f: &Fixture, instances: &[(&ServiceInstance, &Environment)], ttl: Duration) -> Plan {
    let now = Utc::now();
    let entries = instances
        .iter()
        .map(|(i, env)| PlanEntry {
            service_instance_id: i.id,
            label: label(f, env),
            current_state: ObservedState::Running,
            decision: Decision::WillStop {
                deployments: vec![rid(100)],
            },
        })
        .collect();
    let scope = if instances.len() == 1 {
        OperationScope::Instance
    } else {
        OperationScope::Project
    };
    let plan = Plan::new(
        PowerKind::Stop,
        scope,
        entries,
        now - Duration::seconds(1),
        now + ttl,
    )
    .unwrap();
    SqlitePlans::new(f.pool.clone()).save(&plan).await.unwrap();
    plan
}

fn operation_for(plan: &Plan) -> (Operation, Vec<OperationItem>) {
    let op = Operation {
        id: OperationId::new(),
        kind: plan.kind,
        scope: plan.scope,
        trigger: OperationTrigger::Manual,
        schedule_id: None,
        schedule_name: None,
        scheduled_action_id: None,
        scheduled_action_label: None,
        requested_by: "admin".into(),
        plan_id: plan.id,
        status: OperationStatus::Pending,
        created_at: Utc::now(),
        started_at: None,
        finished_at: None,
    };
    let items = plan
        .entries
        .iter()
        .map(|e| OperationItem {
            id: OperationItemId::new(),
            operation_id: op.id,
            service_instance_id: Some(e.service_instance_id),
            label: e.label.clone(),
            previous_state: e.current_state,
            desired_state: ObservedState::Stopped,
            final_state: None,
            deployment_id: None,
            result: ItemResult::Pending,
            error_message: None,
            started_at: None,
            finished_at: None,
            duration_ms: None,
        })
        .collect();
    (op, items)
}

async fn consume(f: &Fixture, plan: &Plan) -> ConsumeOutcome {
    let (op, items) = operation_for(plan);
    SqlitePlans::new(f.pool.clone())
        .consume(plan.id, Utc::now(), &op, &items)
        .await
        .unwrap()
}

#[tokio::test]
async fn migracoes_ativam_chaves_estrangeiras() {
    let pool = memory().await;
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fk, 1);
    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN
         ('credentials','projects','environments','services','service_instances',
          'operations','operation_items','operation_plans','sessions')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tables, 9);
}

#[tokio::test]
async fn banco_em_arquivo_novo_recebe_migracoes() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", dir.path().join("novo.db").display());
    let pool = connect(&url).await.unwrap();
    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fk, 1);
}

#[tokio::test]
async fn credencial_substituida_reatribui_projetos_e_remocao_preserva() {
    let f = fixture(memory().await).await;
    let creds = SqliteCredentials::new(f.pool.clone());
    let projects = SqliteProjects::new(f.pool.clone());

    let new = credential(&f.pool, "outro").await;
    let stored = creds.get().await.unwrap().unwrap();
    assert_eq!(stored.metadata.id, new);
    assert_eq!(stored.metadata.label, "outro");
    assert_eq!(
        projects
            .get(f.project.id)
            .await
            .unwrap()
            .unwrap()
            .credential_id,
        Some(new)
    );

    creds
        .set_status(new, CredentialStatus::Invalid, None)
        .await
        .unwrap();
    assert_eq!(
        creds.get().await.unwrap().unwrap().metadata.status,
        CredentialStatus::Invalid
    );

    creds.delete().await.unwrap();
    assert!(creds.get().await.unwrap().is_none());
    let kept = projects.get(f.project.id).await.unwrap().unwrap();
    assert_eq!(kept.credential_id, None);
    assert_ne!(f.credential, new);
}

#[tokio::test]
async fn projeto_duplicado_e_conflito() {
    let f = fixture(memory().await).await;
    let dup = Project::new(f.credential, rid(1), "outra loja", None, Utc::now()).unwrap();
    let err = SqliteProjects::new(f.pool.clone())
        .insert(&dup)
        .await
        .unwrap_err();
    assert!(matches!(err, RepoError::Conflict(_)), "{err:?}");
}

#[tokio::test]
async fn projeto_atualiza_e_lista() {
    let f = fixture(memory().await).await;
    let repo = SqliteProjects::new(f.pool.clone());
    let mut p = repo.find_by_railway_id(&rid(1)).await.unwrap().unwrap();
    p.edit(Some("Loja"), Some("e-commerce")).unwrap();
    p.sync_status = SyncStatus::Ok;
    p.last_synced_at = Some(Utc::now());
    repo.update(&p).await.unwrap();
    let listed = repo.list().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].shown_name(), "Loja");
    assert_eq!(listed[0].sync_status, SyncStatus::Ok);
}

#[tokio::test]
async fn instancia_unica_por_servico_e_ambiente() {
    let f = fixture(memory().await).await;
    instance(&f, &f.prod).await;
    instance(&f, &f.staging).await;
    let dup = ServiceInstance::new(&f.service, &f.prod).unwrap();
    let err = SqliteInventory::new(f.pool.clone())
        .insert_instance(&dup)
        .await
        .unwrap_err();
    assert!(matches!(err, RepoError::Conflict(_)));
    let views = SqliteInventory::new(f.pool.clone())
        .list_instances(Some(f.project.id))
        .await
        .unwrap();
    assert_eq!(views.len(), 2);
    assert_eq!(views[0].environment.name, "production");
    assert_eq!(views[0].project.name, "loja");
}

#[tokio::test]
async fn instancia_com_ambiente_de_outro_projeto_e_recusada() {
    let f = fixture(memory().await).await;
    let other = Project::new(f.credential, rid(2), "blog", None, Utc::now()).unwrap();
    SqliteProjects::new(f.pool.clone())
        .insert(&other)
        .await
        .unwrap();
    let inv = SqliteInventory::new(f.pool.clone());
    let foreign = inv
        .upsert_environment(&Environment::new(other.id, rid(12), "production", false).unwrap())
        .await
        .unwrap();
    // Contorna a validação do domínio para provar a garantia do banco.
    let mut bad = ServiceInstance::new(&f.service, &f.prod).unwrap();
    bad.environment_id = foreign.id;
    assert!(matches!(
        inv.insert_instance(&bad).await,
        Err(RepoError::Conflict(_))
    ));
}

#[tokio::test]
async fn upsert_atualiza_nome_sem_duplicar() {
    let f = fixture(memory().await).await;
    let inv = SqliteInventory::new(f.pool.clone());
    let renamed = inv
        .upsert_service(&Service::new(f.project.id, rid(20), "api-v2").unwrap())
        .await
        .unwrap();
    assert_eq!(renamed.id, f.service.id);
    assert_eq!(inv.list_services(f.project.id).await.unwrap().len(), 1);
    assert_eq!(
        inv.list_services(f.project.id).await.unwrap()[0].name,
        "api-v2"
    );
}

#[tokio::test]
async fn observacao_e_erro_de_sincronizacao() {
    let f = fixture(memory().await).await;
    let i = instance(&f, &f.prod).await;
    let inv = SqliteInventory::new(f.pool.clone());
    let at = Utc::now();
    inv.record_observation(
        i.id,
        &InstanceObservation {
            state: ObservedState::Running,
            not_found: false,
            latest_deployment_id: Some(rid(100)),
            latest_deployment_status: Some(domain::deployment::DeploymentStatus::Success),
            observed_at: at,
        },
    )
    .await
    .unwrap();
    inv.record_sync_error(&[i.id], "Railway indisponível")
        .await
        .unwrap();
    let view = inv.get_instance(i.id).await.unwrap().unwrap();
    assert_eq!(view.instance.observed_state, ObservedState::Running);
    assert_eq!(
        view.instance.last_sync_error.as_deref(),
        Some("Railway indisponível")
    );
    assert_eq!(
        view.instance.last_observed_at.unwrap().timestamp_millis(),
        at.timestamp_millis()
    );
}

#[tokio::test]
async fn remocao_de_projeto_cascateia_e_preserva_historico() {
    let f = fixture(memory().await).await;
    let i = instance(&f, &f.prod).await;
    let p = plan(&f, &[(&i, &f.prod)], Duration::minutes(5)).await;
    let ConsumeOutcome::Created { operation_id, .. } = consume(&f, &p).await else {
        panic!()
    };

    // Com item ativo, a remoção é recusada.
    let projects = SqliteProjects::new(f.pool.clone());
    assert!(matches!(
        projects.delete(f.project.id).await,
        Err(RepoError::Conflict(_))
    ));
    let inv = SqliteInventory::new(f.pool.clone());
    assert!(matches!(
        inv.delete_instance(i.id).await,
        Err(RepoError::Conflict(_))
    ));
    assert!(matches!(
        inv.delete_service(f.service.id).await,
        Err(RepoError::Conflict(_))
    ));

    let ops = SqliteOperations::new(f.pool.clone());
    let (_, mut items) = ops.get(operation_id).await.unwrap().unwrap();
    items[0].advance(ItemResult::Skipped, Utc::now()).unwrap();
    ops.update_item(&items[0]).await.unwrap();

    projects.delete(f.project.id).await.unwrap();
    assert!(projects.get(f.project.id).await.unwrap().is_none());
    assert!(
        inv.list_environments(f.project.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(inv.list_instances(None).await.unwrap().is_empty());

    let (_, items) = ops.get(operation_id).await.unwrap().unwrap();
    assert_eq!(items[0].service_instance_id, None);
    assert_eq!(items[0].label.project_name, "loja");
}

#[tokio::test]
async fn plano_consumido_uma_vez_expirado_e_inexistente() {
    let f = fixture(memory().await).await;
    let i = instance(&f, &f.prod).await;
    let p = plan(&f, &[(&i, &f.prod)], Duration::minutes(5)).await;
    assert_eq!(
        SqlitePlans::new(f.pool.clone())
            .get(p.id)
            .await
            .unwrap()
            .unwrap(),
        p
    );

    let ConsumeOutcome::Created {
        operation_id,
        conflicts,
    } = consume(&f, &p).await
    else {
        panic!()
    };
    assert!(conflicts.is_empty());
    assert_eq!(
        consume(&f, &p).await,
        ConsumeOutcome::AlreadyConsumed {
            operation_id: Some(operation_id)
        }
    );

    let other = instance(&f, &f.staging).await;
    let expired = plan(&f, &[(&other, &f.staging)], Duration::milliseconds(1)).await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    assert_eq!(consume(&f, &expired).await, ConsumeOutcome::Expired);

    let ghost = Plan {
        id: PlanId::new(),
        ..p.clone()
    };
    assert_eq!(consume(&f, &ghost).await, ConsumeOutcome::NotFound);
}

#[tokio::test]
async fn conflito_em_lote_vira_skipped_e_individual_e_recusado() {
    let f = fixture(memory().await).await;
    let prod = instance(&f, &f.prod).await;
    let staging = instance(&f, &f.staging).await;

    let first = plan(&f, &[(&prod, &f.prod)], Duration::minutes(5)).await;
    assert!(matches!(
        consume(&f, &first).await,
        ConsumeOutcome::Created { .. }
    ));

    // Individual sobre a mesma instância: recusado, plano segue disponível.
    let single = plan(&f, &[(&prod, &f.prod)], Duration::minutes(5)).await;
    assert_eq!(consume(&f, &single).await, ConsumeOutcome::Conflict);
    let consumed: Option<String> =
        sqlx::query_scalar("SELECT consumed_at FROM operation_plans WHERE id = ?")
            .bind(single.id.to_string())
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(consumed.is_none());

    // Lote: a instância ocupada vira skipped, a outra segue pendente.
    let batch = plan(
        &f,
        &[(&prod, &f.prod), (&staging, &f.staging)],
        Duration::minutes(5),
    )
    .await;
    let ConsumeOutcome::Created {
        operation_id,
        conflicts,
    } = consume(&f, &batch).await
    else {
        panic!()
    };
    assert_eq!(conflicts, vec![prod.id]);
    let (_, items) = SqliteOperations::new(f.pool.clone())
        .get(operation_id)
        .await
        .unwrap()
        .unwrap();
    let by_env: Vec<_> = items
        .iter()
        .map(|i| (i.label.environment_name.as_str(), i.result))
        .collect();
    assert_eq!(
        by_env,
        [
            ("production", ItemResult::Skipped),
            ("staging", ItemResult::Pending)
        ]
    );
    assert_eq!(
        items[0].error_message.as_deref(),
        Some(SkipReason::OperationInProgress.message().as_str())
    );
}

#[tokio::test]
async fn consumo_concorrente_tem_um_unico_vencedor() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", dir.path().join("concorrente.db").display());
    let f = Arc::new(fixture(connect(&url).await.unwrap()).await);
    let i = instance(&f, &f.prod).await;
    let p = plan(&f, &[(&i, &f.prod)], Duration::minutes(5)).await;

    let tasks: Vec<_> = (0..8)
        .map(|_| {
            let f = f.clone();
            let p = p.clone();
            tokio::spawn(async move { consume(&f, &p).await })
        })
        .collect();
    let mut created = 0;
    let mut reused = 0;
    for task in tasks {
        match task.await.unwrap() {
            ConsumeOutcome::Created { .. } => created += 1,
            ConsumeOutcome::AlreadyConsumed {
                operation_id: Some(_),
            } => reused += 1,
            other => panic!("inesperado: {other:?}"),
        }
    }
    assert_eq!((created, reused), (1, 7));
    let ops: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operations")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(ops, 1);
}

#[tokio::test]
async fn reinicio_interrompe_itens_e_libera_bloqueio() {
    let f = fixture(memory().await).await;
    let i = instance(&f, &f.prod).await;
    let p = plan(&f, &[(&i, &f.prod)], Duration::minutes(5)).await;
    let ConsumeOutcome::Created { operation_id, .. } = consume(&f, &p).await else {
        panic!()
    };
    let ops = SqliteOperations::new(f.pool.clone());
    assert_eq!(ops.active_instance_ids().await.unwrap(), vec![i.id]);

    assert_eq!(ops.interrupt_unfinished(Utc::now()).await.unwrap(), 1);
    let (op, items) = ops.get(operation_id).await.unwrap().unwrap();
    assert_eq!(items[0].result, ItemResult::Interrupted);
    assert_eq!(op.status, OperationStatus::Failed);
    assert!(op.finished_at.is_some());
    assert!(ops.active_instance_ids().await.unwrap().is_empty());

    // O índice de conflito foi liberado: nova operação sobre a mesma instância é aceita.
    let again = plan(&f, &[(&i, &f.prod)], Duration::minutes(5)).await;
    assert!(matches!(
        consume(&f, &again).await,
        ConsumeOutcome::Created { .. }
    ));
}

#[tokio::test]
async fn historico_filtra_e_pagina() {
    let f = fixture(memory().await).await;
    let prod = instance(&f, &f.prod).await;
    let staging = instance(&f, &f.staging).await;
    let ops = SqliteOperations::new(f.pool.clone());

    for _ in 0..3 {
        let p = plan(
            &f,
            &[(&prod, &f.prod), (&staging, &f.staging)],
            Duration::minutes(5),
        )
        .await;
        let ConsumeOutcome::Created { operation_id, .. } = consume(&f, &p).await else {
            panic!()
        };
        let (_, items) = ops.get(operation_id).await.unwrap().unwrap();
        for mut item in items {
            let failed = item.label.environment_name == "staging";
            item.advance(ItemResult::Running, Utc::now()).unwrap();
            item.advance(
                if failed {
                    ItemResult::Failed
                } else {
                    ItemResult::Skipped
                },
                Utc::now(),
            )
            .unwrap();
            ops.update_item(&item).await.unwrap();
        }
    }

    let all = ops.history(&HistoryFilter::default(), 1, 4).await.unwrap();
    assert_eq!((all.total, all.items.len()), (6, 4));
    let page2 = ops.history(&HistoryFilter::default(), 2, 4).await.unwrap();
    assert_eq!(page2.items.len(), 2);

    let filter = HistoryFilter {
        railway_project_id: Some(rid(1)),
        kind: Some(PowerKind::Stop),
        result: Some(ItemResult::Failed),
        from: Some(Utc::now() - Duration::days(7)),
        to: Some(Utc::now() + Duration::minutes(1)),
        ..Default::default()
    };
    let failed = ops.history(&filter, 1, 50).await.unwrap();
    assert_eq!(failed.total, 3);
    assert!(
        failed
            .items
            .iter()
            .all(|e| e.item.label.environment_name == "staging")
    );

    let none = HistoryFilter {
        kind: Some(PowerKind::Start),
        ..Default::default()
    };
    assert_eq!(ops.history(&none, 1, 50).await.unwrap().total, 0);
    let env = HistoryFilter {
        environment_name: Some("PRODUCTION".into()),
        ..Default::default()
    };
    assert_eq!(ops.history(&env, 1, 50).await.unwrap().total, 3);

    assert_eq!(ops.recent(2).await.unwrap().len(), 2);
}

#[tokio::test]
async fn sessoes_expiram_e_sao_removidas() {
    let pool = memory().await;
    let sessions = SqliteSessions::new(pool);
    let now = Utc::now();
    sessions
        .create("h1", None, now, now + Duration::hours(1))
        .await
        .unwrap();
    sessions
        .create(
            "h2",
            None,
            now - Duration::hours(2),
            now - Duration::hours(1),
        )
        .await
        .unwrap();
    assert_eq!(
        sessions.resolve("h1", now).await.unwrap(),
        Some(SessionOwner::Master)
    );
    assert_eq!(sessions.resolve("h2", now).await.unwrap(), None);
    assert_eq!(sessions.purge_expired(now).await.unwrap(), 1);
    sessions.delete("h1").await.unwrap();
    assert_eq!(sessions.resolve("h1", now).await.unwrap(), None);
}

fn new_user(name: &str, role: Role) -> User {
    let now = Utc::now();
    User {
        id: UserId::new(),
        username: Username::parse(name).unwrap(),
        role,
        is_active: true,
        created_at: now,
        updated_at: now,
    }
}

#[tokio::test]
async fn usuarios_nome_unico_sem_diferenciar_caixa() {
    let users = SqliteUsers::new(memory().await);
    users
        .insert(&new_user("Maria", Role::Operator), "hash-1")
        .await
        .unwrap();
    let err = users
        .insert(&new_user("MARIA", Role::Viewer), "hash-2")
        .await
        .unwrap_err();
    assert!(matches!(err, RepoError::Conflict(_)));

    let found = users.find_credentials("maria").await.unwrap().unwrap();
    assert_eq!(found.user.username.as_str(), "Maria");
    assert_eq!(found.password_hash, "hash-1");
    assert!(users.find_credentials("joao").await.unwrap().is_none());
    assert_eq!(users.list().await.unwrap().len(), 1);
}

#[tokio::test]
async fn papel_master_nao_pode_ser_gravado() {
    let pool = memory().await;
    let result = sqlx::query(
        "INSERT INTO users (id, username, username_key, password_hash, role, created_at, updated_at)
         VALUES ('x', 'root', 'root', 'h', 'master', 't', 't')",
    )
    .execute(&pool)
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn usuario_atualiza_e_remove() {
    let pool = memory().await;
    let users = SqliteUsers::new(pool.clone());
    let user = new_user("ana", Role::Operator);
    users.insert(&user, "h").await.unwrap();
    let now = Utc::now();
    users
        .update(user.id, Role::Viewer, false, now)
        .await
        .unwrap();
    users.set_password_hash(user.id, "h2", now).await.unwrap();
    let got = users.get(user.id).await.unwrap().unwrap();
    assert_eq!(got.role, Role::Viewer);
    assert!(!got.is_active);
    assert_eq!(
        users
            .find_credentials("ana")
            .await
            .unwrap()
            .unwrap()
            .password_hash,
        "h2"
    );
    users.delete(user.id).await.unwrap();
    assert!(users.get(user.id).await.unwrap().is_none());
    assert_eq!(
        users.delete(user.id).await.unwrap_err(),
        RepoError::NotFound
    );
}

#[tokio::test]
async fn sessao_segue_o_estado_do_usuario() {
    let pool = memory().await;
    let users = SqliteUsers::new(pool.clone());
    let sessions = SqliteSessions::new(pool);
    let user = new_user("ana", Role::Operator);
    users.insert(&user, "h").await.unwrap();
    let now = Utc::now();
    sessions
        .create("s1", Some(user.id), now, now + Duration::hours(1))
        .await
        .unwrap();
    let operator = SessionOwner::User {
        username: "ana".into(),
        role: Role::Operator,
    };
    assert_eq!(sessions.resolve("s1", now).await.unwrap(), Some(operator));

    // Rebaixar vale na hora.
    users
        .update(user.id, Role::Viewer, true, now)
        .await
        .unwrap();
    assert_eq!(
        sessions.resolve("s1", now).await.unwrap(),
        Some(SessionOwner::User {
            username: "ana".into(),
            role: Role::Viewer
        })
    );
    // Desativar derruba a sessão.
    users
        .update(user.id, Role::Viewer, false, now)
        .await
        .unwrap();
    assert_eq!(sessions.resolve("s1", now).await.unwrap(), None);
    // Remover apaga as sessões em cascata.
    users
        .update(user.id, Role::Viewer, true, now)
        .await
        .unwrap();
    users.delete(user.id).await.unwrap();
    assert_eq!(sessions.resolve("s1", now).await.unwrap(), None);
}

#[tokio::test]
async fn nova_senha_encerra_as_sessoes_do_usuario() {
    let pool = memory().await;
    let users = SqliteUsers::new(pool.clone());
    let sessions = SqliteSessions::new(pool);
    let user = new_user("ana", Role::Admin);
    users.insert(&user, "h").await.unwrap();
    let now = Utc::now();
    sessions
        .create("s1", Some(user.id), now, now + Duration::hours(1))
        .await
        .unwrap();
    sessions
        .create("m", None, now, now + Duration::hours(1))
        .await
        .unwrap();
    sessions.delete_for_user(user.id).await.unwrap();
    assert_eq!(sessions.resolve("s1", now).await.unwrap(), None);
    assert!(sessions.resolve("m", now).await.unwrap().is_some());
}

#[tokio::test]
async fn token_nao_aparece_em_claro_no_arquivo_do_banco() {
    use application::railway::RailwayToken;
    use infrastructure::crypto::XChaChaCipher;

    const SECRET: &str = "tok-que-nao-pode-vazar-0123456789";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cofre.db");
    let pool = connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();

    let cipher = XChaChaCipher::new(Some(&[42; 32]));
    let meta =
        CredentialMetadata::validated(CredentialKind::Account, None, "eu", SECRET, Utc::now())
            .unwrap();
    let sealed = cipher.seal(meta.id, &RailwayToken::new(SECRET)).unwrap();
    let repo = SqliteCredentials::new(pool.clone());
    repo.replace(&StoredCredential {
        metadata: meta.clone(),
        sealed,
    })
    .await
    .unwrap();

    let stored = repo.get().await.unwrap().unwrap();
    assert_eq!(
        cipher.open(meta.id, &stored.sealed).unwrap().expose(),
        SECRET
    );

    // Força o conteúdo do WAL para o arquivo principal e lê todos os arquivos do banco.
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        let needle = SECRET.as_bytes();
        assert!(
            !bytes.windows(needle.len()).any(|w| w == needle),
            "token em claro no banco"
        );
    }
}
