//! Casos de uso de inventário com Railway falso.

mod common;

use application::error::AppError;
use application::inventory::InstanceRef;
use application::railway::RailwayError;
use common::*;
use domain::state::ObservedState;

fn pair(env: u32, service: u32) -> InstanceRef {
    InstanceRef {
        environment_id: rid(env),
        service_id: rid(service),
    }
}

async fn loja(h: &Harness) -> domain::ids::ProjectId {
    h.with_account().await;
    h.seed_loja();
    h.projects
        .register(&rid::<String>(1), None)
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn descoberta_por_ambiente_com_efemeros_por_ultimo() {
    let h = harness().await;
    let p = loja(&h).await;
    h.inventory.import(p, &[pair(10, 20)]).await.unwrap();

    let envs = h.inventory.discover(p).await.unwrap();
    let names: Vec<_> = envs
        .iter()
        .map(|e| (e.environment.name.as_str(), e.environment.is_ephemeral))
        .collect();
    assert_eq!(
        names,
        [("production", false), ("staging", false), ("pr-7", true)]
    );
    let prod: Vec<_> = envs[0]
        .instances
        .iter()
        .map(|i| (i.service_name.as_str(), i.state, i.managed))
        .collect();
    assert_eq!(
        prod,
        [
            ("api", ObservedState::Running, true),
            ("worker", ObservedState::Stopped, false)
        ]
    );
}

#[tokio::test]
async fn importacao_seletiva_cadastra_e_sincroniza() {
    let h = harness().await;
    let p = loja(&h).await;
    let report = h
        .inventory
        .import(p, &[pair(10, 20), pair(10, 21)])
        .await
        .unwrap();
    assert_eq!(report.imported.len(), 2);

    let views = h.inventory.local_instances(Some(p)).await.unwrap();
    let states: Vec<_> = views
        .iter()
        .map(|v| (v.service.name.as_str(), v.instance.observed_state))
        .collect();
    assert_eq!(
        states,
        [
            ("api", ObservedState::Running),
            ("worker", ObservedState::Stopped)
        ]
    );
    assert!(views.iter().all(|v| v.instance.last_observed_at.is_some()));
    // Uma leitura por ambiente.
    let reads = h
        .railway
        .calls()
        .iter()
        .filter(|c| c.starts_with("list_service_instances"))
        .count();
    assert_eq!(reads, 1);
}

#[tokio::test]
async fn servico_em_dois_ambientes_vira_duas_instancias() {
    let h = harness().await;
    let p = loja(&h).await;
    h.inventory
        .import(p, &[pair(10, 20), pair(11, 20)])
        .await
        .unwrap();
    let views = h.inventory.local_instances(Some(p)).await.unwrap();
    assert_eq!(views.len(), 2);
    assert_eq!(views[0].service.id, views[1].service.id);
}

#[tokio::test]
async fn associacao_duplicada_e_de_outro_projeto() {
    let h = harness().await;
    let p = loja(&h).await;
    h.railway
        .add_project(2, "blog", Some(900))
        .add_environment(2, 30, "production", false)
        .add_service(2, 40, "web");

    h.inventory.associate(p, &pair(10, 20)).await.unwrap();
    assert!(matches!(
        h.inventory.associate(p, &pair(10, 20)).await,
        Err(AppError::Conflict(_))
    ));
    assert!(matches!(
        h.inventory.associate(p, &pair(10, 40)).await,
        Err(AppError::Unprocessable(_))
    ));
    assert!(matches!(
        h.inventory.associate(p, &pair(30, 20)).await,
        Err(AppError::Unprocessable(_))
    ));
    assert!(matches!(
        h.inventory.associate(p, &pair(10, 0)).await,
        Err(AppError::Unprocessable(_))
    ));
}

#[tokio::test]
async fn remocao_de_associacao_nao_toca_o_railway() {
    let h = harness().await;
    let p = loja(&h).await;
    h.inventory.import(p, &[pair(11, 20)]).await.unwrap();
    let view = h
        .inventory
        .local_instances(Some(p))
        .await
        .unwrap()
        .remove(0);
    let before = h.railway.calls().len();
    h.inventory.remove_instance(view.instance.id).await.unwrap();
    assert!(
        h.inventory
            .local_instances(Some(p))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(h.railway.calls().len(), before);
    assert!(h.railway.snapshot(11, 20).unwrap().active.len() == 1);
    h.inventory.remove_service(view.service.id).await.unwrap();
}

#[tokio::test]
async fn sincronizacao_agrupa_por_ambiente_e_trata_falhas() {
    let h = harness().await;
    let p = loja(&h).await;
    h.inventory
        .import(p, &[pair(10, 20), pair(10, 21), pair(11, 20)])
        .await
        .unwrap();

    let before = h.railway.calls().len();
    let report = h.inventory.refresh(Some(p)).await.unwrap();
    assert_eq!(report.refreshed, 3);
    assert_eq!(
        h.railway.calls().len() - before,
        2,
        "uma chamada por ambiente"
    );

    // Indisponível em um ambiente: estado mantido, frescor indisponível.
    h.railway.fail_next(
        "list_service_instances",
        RailwayError::Unavailable("x".into()),
    );
    let report = h.inventory.refresh(Some(p)).await.unwrap();
    assert_eq!((report.refreshed, report.failed), (1, 2));
    let failed: Vec<_> = h
        .inventory
        .local_instances(Some(p))
        .await
        .unwrap()
        .into_iter()
        .filter(|v| v.instance.last_sync_error.is_some())
        .collect();
    assert_eq!(failed.len(), 2);
    assert!(failed.iter().all(|v| v.environment.name == "production"));
    assert_eq!(failed[0].instance.observed_state, ObservedState::Running);

    // Instância sumiu no Railway: unknown + não encontrada.
    h.railway.remove_instance(11, 20);
    let report = h.inventory.refresh(Some(p)).await.unwrap();
    assert_eq!(report.not_found, 1);
    let gone = h
        .inventory
        .local_instances(Some(p))
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.environment.name == "staging")
        .unwrap();
    assert_eq!(gone.instance.observed_state, ObservedState::Unknown);
    assert!(gone.instance.not_found);
    assert!(!gone.instance.is_operable());
}

#[tokio::test]
async fn token_revogado_durante_sincronizacao_marca_credencial() {
    let h = harness().await;
    let p = loja(&h).await;
    h.inventory.import(p, &[pair(10, 20)]).await.unwrap();
    h.railway
        .fail_next("list_service_instances", RailwayError::Unauthorized);
    assert_eq!(
        h.inventory.refresh(Some(p)).await.unwrap_err(),
        AppError::CredentialInvalid
    );
    let meta = h.credentials.current().await.unwrap().unwrap();
    assert_eq!(meta.status, domain::credential::CredentialStatus::Invalid);
}
