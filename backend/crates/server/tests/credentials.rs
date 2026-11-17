//! Casos de uso de credencial com Railway falso.

mod common;

use application::credentials::RegisterCredential;
use application::error::AppError;
use application::railway::{RailwayError, RailwayToken};
use common::*;
use domain::credential::{CredentialKind, CredentialStatus};

fn account(token: &str) -> RegisterCredential {
    RegisterCredential {
        kind: CredentialKind::Account,
        workspace_id: None,
        token: RailwayToken::new(token),
    }
}

#[tokio::test]
async fn token_de_conta_valido_e_persistido_com_mascara() {
    let h = harness().await;
    h.railway.with_account("Ana", "ana@example.com", &[]);
    let meta = h
        .credentials
        .register(account(&format!("  {TOKEN} ")))
        .await
        .unwrap();
    assert_eq!(meta.kind, CredentialKind::Account);
    assert_eq!(meta.label, "Ana <ana@example.com>");
    assert_eq!(meta.masked_suffix, "6789");
    assert_eq!(meta.status, CredentialStatus::Valid);
    assert_eq!(h.credentials.active().await.unwrap().token.expose(), TOKEN);
    assert!(!format!("{meta:?}").contains(TOKEN));
}

#[tokio::test]
async fn token_de_workspace_exige_id_e_valida_no_railway() {
    let h = harness().await;
    h.railway.with_workspace(900, "time");
    let missing = RegisterCredential {
        workspace_id: None,
        kind: CredentialKind::Workspace,
        ..account(TOKEN)
    };
    assert!(matches!(
        h.credentials.register(missing).await,
        Err(AppError::Validation(_))
    ));

    let input = RegisterCredential {
        kind: CredentialKind::Workspace,
        workspace_id: Some(rid::<String>(900)),
        token: RailwayToken::new(TOKEN),
    };
    let meta = h.credentials.register(input).await.unwrap();
    assert_eq!(meta.label, "time");
    assert_eq!(meta.workspace_id.unwrap().to_string(), rid::<String>(900));
    assert_eq!(
        h.railway.calls(),
        [format!("workspace({})", rid::<String>(900))]
    );
}

#[tokio::test]
async fn token_invalido_nao_e_persistido() {
    let h = harness().await;
    h.railway.with_account("Ana", "ana@example.com", &[]);
    let err = h
        .credentials
        .register(account("tok-recusado-000000"))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Unprocessable(_)), "{err:?}");
    assert!(h.credentials.current().await.unwrap().is_none());
}

#[tokio::test]
async fn railway_indisponivel_na_validacao_nao_persiste() {
    let h = harness().await;
    h.railway.with_account("Ana", "ana@example.com", &[]);
    h.railway
        .fail_next("me", RailwayError::Unavailable("timeout".into()));
    let err = h.credentials.register(account(TOKEN)).await.unwrap_err();
    assert!(matches!(err, AppError::RailwayUnavailable(_)), "{err:?}");
    assert!(h.credentials.current().await.unwrap().is_none());
}

#[tokio::test]
async fn substituicao_passa_a_usar_o_novo_token() {
    let h = harness().await;
    h.with_account().await;
    let first = h.credentials.current().await.unwrap().unwrap();
    h.railway.accept_token("tok-novo-9999999999");
    let second = h
        .credentials
        .register(account("tok-novo-9999999999"))
        .await
        .unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(
        h.credentials.active().await.unwrap().token.expose(),
        "tok-novo-9999999999"
    );
}

#[tokio::test]
async fn remocao_desativa_a_integracao() {
    let h = harness().await;
    h.with_account().await;
    h.credentials.remove().await.unwrap();
    assert!(h.credentials.current().await.unwrap().is_none());
    assert_eq!(
        h.credentials.active().await.unwrap_err(),
        AppError::IntegrationNotConfigured
    );
}

#[tokio::test]
async fn falha_de_autenticacao_marca_invalida() {
    let h = harness().await;
    h.with_account().await;
    let active = h.credentials.active().await.unwrap();
    let result: Result<(), _> = Err(RailwayError::Unauthorized);
    assert_eq!(
        h.credentials.check(&active, result).await.unwrap_err(),
        AppError::CredentialInvalid
    );
    assert_eq!(
        h.credentials.current().await.unwrap().unwrap().status,
        CredentialStatus::Invalid
    );
    assert_eq!(
        h.credentials.active().await.unwrap_err(),
        AppError::CredentialInvalid
    );
}

#[tokio::test]
async fn chave_mestra_errada_marca_indecifravel_sem_apagar() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", dir.path().join("k.db").display());

    let h = harness_on(
        infrastructure::sqlite::connect(&url).await.unwrap(),
        Some([1; 32]),
    )
    .await;
    h.with_account().await;
    h.pool.close().await;

    for key in [Some([2; 32]), None] {
        let other = harness_on(infrastructure::sqlite::connect(&url).await.unwrap(), key).await;
        let meta = other.credentials.current().await.unwrap().unwrap();
        assert_eq!(meta.status, CredentialStatus::Undecipherable);
        assert_eq!(
            other.credentials.active().await.unwrap_err(),
            AppError::CredentialUndecipherable
        );
        other.pool.close().await;
    }

    // Com a chave certa de volta, o dado preservado volta a funcionar.
    let back = harness_on(
        infrastructure::sqlite::connect(&url).await.unwrap(),
        Some([1; 32]),
    )
    .await;
    assert_eq!(
        back.credentials.current().await.unwrap().unwrap().status,
        CredentialStatus::Valid
    );
    assert_eq!(
        back.credentials.active().await.unwrap().token.expose(),
        TOKEN
    );
    back.pool.close().await;
}
