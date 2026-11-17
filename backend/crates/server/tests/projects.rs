//! Casos de uso de projetos com Railway falso.

mod common;

use application::error::AppError;
use application::railway::RailwayError;
use common::*;
use domain::catalog::SyncStatus;
use domain::state::ObservedState;

#[tokio::test]
async fn descoberta_lista_todos_os_workspaces_e_marca_gerenciados() {
    let h = harness().await;
    h.with_account().await;
    h.railway
        .with_account("Ana", "ana@example.com", &[(900, "pessoal"), (901, "time")])
        .add_project(1, "loja", Some(900))
        .add_project(2, "blog", Some(901))
        .add_project(3, "api", Some(901));
    h.projects.register(&rid::<String>(2), None).await.unwrap();

    let groups = h.projects.discover().await.unwrap();
    let summary: Vec<_> = groups
        .iter()
        .map(|g| {
            let name = g.workspace.as_ref().unwrap().name.clone();
            let projects: Vec<_> = g
                .projects
                .iter()
                .map(|p| (p.project.name.clone(), p.managed))
                .collect();
            (name, projects)
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("pessoal".to_string(), vec![("loja".to_string(), false)]),
            (
                "time".to_string(),
                vec![("api".to_string(), false), ("blog".to_string(), true)]
            ),
        ]
    );
}

#[tokio::test]
async fn cadastro_manual_valida_e_sincroniza() {
    let h = harness().await;
    h.with_account().await;
    h.seed_loja();
    let p = h
        .projects
        .register(&rid::<String>(1), Some("Loja (prod)"))
        .await
        .unwrap();
    assert_eq!(p.name, "loja");
    assert_eq!(p.shown_name(), "Loja (prod)");
    assert_eq!(p.sync_status, SyncStatus::Ok);
    assert!(p.last_synced_at.is_some());
}

#[tokio::test]
async fn cadastro_duplicado_e_conflito_e_inacessivel_falha() {
    let h = harness().await;
    h.with_account().await;
    h.seed_loja();
    h.projects.register(&rid::<String>(1), None).await.unwrap();
    assert!(matches!(
        h.projects.register(&rid::<String>(1), None).await,
        Err(AppError::Conflict(_))
    ));
    assert!(matches!(
        h.projects.register(&rid::<String>(99), None).await,
        Err(AppError::Unprocessable(_))
    ));
    assert!(matches!(
        h.projects.register("nao-e-uuid", None).await,
        Err(AppError::Validation(_))
    ));
    assert_eq!(h.projects.list().await.unwrap().len(), 1);
}

#[tokio::test]
async fn cadastro_sem_credencial_falha_explicitamente() {
    let h = harness().await;
    h.seed_loja();
    assert_eq!(
        h.projects
            .register(&rid::<String>(1), None)
            .await
            .unwrap_err(),
        AppError::IntegrationNotConfigured
    );
}

#[tokio::test]
async fn importacao_multipla_reporta_existentes() {
    let h = harness().await;
    h.with_account().await;
    h.railway
        .add_project(1, "loja", Some(900))
        .add_project(2, "blog", Some(900))
        .add_project(3, "api", Some(900));
    h.projects.register(&rid::<String>(1), None).await.unwrap();

    let ids: Vec<String> = [1, 2, 3, 99].iter().map(|n| rid(*n)).collect();
    let report = h.projects.import(&ids).await.unwrap();
    let imported: Vec<_> = report.imported.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(imported, ["blog", "api"]);
    assert_eq!(report.already_managed, [rid::<String>(1)]);
    assert_eq!(report.failed.len(), 1);
    assert_eq!(h.projects.list().await.unwrap().len(), 3);
}

#[tokio::test]
async fn edicao_local_nao_chama_o_railway() {
    let h = harness().await;
    h.with_account().await;
    h.seed_loja();
    let p = h.projects.register(&rid::<String>(1), None).await.unwrap();
    let before = h.railway.calls().len();
    let edited = h
        .projects
        .edit(p.id, Some("Loja"), Some("e-commerce"))
        .await
        .unwrap();
    assert_eq!(edited.description.as_deref(), Some("e-commerce"));
    assert_eq!(edited.railway_project_id, p.railway_project_id);
    assert_eq!(h.railway.calls().len(), before);
}

#[tokio::test]
async fn remocao_nao_toca_o_railway() {
    let h = harness().await;
    h.with_account().await;
    h.seed_loja();
    let p = h.projects.register(&rid::<String>(1), None).await.unwrap();
    let before = h.railway.calls().len();
    h.projects.remove(p.id).await.unwrap();
    assert!(h.projects.list().await.unwrap().is_empty());
    assert_eq!(h.railway.calls().len(), before);
    assert!(matches!(
        h.projects.remove(p.id).await,
        Err(AppError::NotFound(_))
    ));
}

#[tokio::test]
async fn sincronizacao_ok_falha_e_nao_encontrado() {
    let h = harness().await;
    h.with_account().await;
    h.seed_loja();
    let p = h.projects.register(&rid::<String>(1), None).await.unwrap();
    h.inventory
        .import(
            p.id,
            &[application::inventory::InstanceRef {
                environment_id: rid(10),
                service_id: rid(20),
            }],
        )
        .await
        .unwrap();

    let (synced, report) = h.projects.sync(p.id).await.unwrap();
    assert_eq!(synced.sync_status, SyncStatus::Ok);
    assert_eq!(report.refreshed, 1);

    h.railway
        .fail_next("get_project", RailwayError::Unavailable("x".into()));
    assert!(matches!(
        h.projects.sync(p.id).await,
        Err(AppError::RailwayUnavailable(_))
    ));
    assert_eq!(
        h.projects.get(p.id).await.unwrap().sync_status,
        SyncStatus::Failed
    );
    let view = &h.inventory.local_instances(Some(p.id)).await.unwrap()[0];
    assert!(view.instance.last_sync_error.is_some());
    assert_eq!(view.instance.observed_state, ObservedState::Running);

    h.railway.remove_project(1);
    let (gone, _) = h.projects.sync(p.id).await.unwrap();
    assert_eq!(gone.sync_status, SyncStatus::NotFound);
    assert_eq!(
        h.inventory.local_instances(Some(p.id)).await.unwrap().len(),
        1
    );
}
