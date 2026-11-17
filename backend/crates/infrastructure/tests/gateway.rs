//! `RailwayClient` contra um servidor simulado: paginação, mapeamento e "não encontrado".

use std::time::Duration;

use application::railway::{RailwayGateway, RailwayToken};
use domain::deployment::DeploymentStatus;
use domain::ids::{RailwayDeploymentId, RailwayEnvironmentId, RailwayProjectId, RailwayServiceId};
use domain::power::StopMechanism;
use domain::state::{ObservedState, observe};
use infrastructure::railway::{RailwayClient, Transport, TransportConfig};
use serde_json::{Value, json};
use wiremock::matchers::{body_partial_json, body_string_contains, method};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn token() -> RailwayToken {
    RailwayToken::new("tok-teste-0000")
}

fn client(server: &MockServer) -> RailwayClient {
    let mut config = TransportConfig::new(server.uri());
    config.retry_base = Duration::from_millis(1);
    config.rps = 100;
    RailwayClient::new(Transport::new(config).unwrap())
}

async fn on(server: &MockServer, operation: &str, extra: Option<Value>, body: Value) {
    let mut mock = Mock::given(method("POST")).and(body_string_contains(format!(
        "\"operationName\":\"{operation}\""
    )));
    if let Some(extra) = extra {
        mock = mock.and(body_partial_json(extra));
    }
    mock.respond_with(ResponseTemplate::new(200).set_body_json(body))
        .expect(1)
        .mount(server)
        .await;
}

fn page_info(next: Option<&str>) -> Value {
    json!({ "hasNextPage": next.is_some(), "endCursor": next })
}

fn deployment(n: u32, status: &str) -> Value {
    json!({ "id": uuid(n), "status": status, "canRedeploy": true, "deploymentStopped": false })
}

#[tokio::test]
async fn lista_projetos_de_todas_as_paginas_sem_excluidos() {
    let server = MockServer::start().await;
    let project = |n: u32, deleted: bool| {
        json!({ "node": {
            "id": uuid(n), "name": format!("p{n}"), "description": null,
            "workspaceId": uuid(900), "deletedAt": if deleted { json!("2026-01-01T00:00:00Z") } else { json!(null) }
        }})
    };
    on(
        &server,
        "Projects",
        Some(json!({ "variables": { "after": null } })),
        json!({ "data": { "projects": {
            "edges": [project(1, false), project(2, true)], "pageInfo": page_info(Some("c1"))
        }}}),
    )
    .await;
    on(
        &server,
        "Projects",
        Some(json!({ "variables": { "after": "c1" } })),
        json!({ "data": { "projects": { "edges": [project(3, false)], "pageInfo": page_info(None) }}}),
    )
    .await;

    let projects = client(&server).list_projects(&token(), None).await.unwrap();
    let names: Vec<_> = projects.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["p1", "p3"]);
    assert_eq!(
        projects[0].workspace_id.as_ref().unwrap().as_str(),
        uuid(900)
    );
}

#[tokio::test]
async fn projeto_com_ambientes_e_servicos_paginados() {
    let server = MockServer::start().await;
    let id = uuid(1);
    on(
        &server,
        "Project",
        None,
        json!({ "data": { "project": {
            "id": id, "name": "loja", "description": "e-commerce", "workspaceId": null, "deletedAt": null
        }}}),
    )
    .await;
    on(
        &server,
        "ProjectEnvironments",
        Some(json!({ "variables": { "after": null } })),
        json!({ "data": { "project": { "environments": {
            "edges": [{ "node": { "id": uuid(10), "name": "production", "isEphemeral": false, "deletedAt": null }}],
            "pageInfo": page_info(Some("e1"))
        }}}}),
    )
    .await;
    on(
        &server,
        "ProjectEnvironments",
        Some(json!({ "variables": { "after": "e1" } })),
        json!({ "data": { "project": { "environments": {
            "edges": [{ "node": { "id": uuid(11), "name": "pr-42", "isEphemeral": true, "deletedAt": null }}],
            "pageInfo": page_info(None)
        }}}}),
    )
    .await;
    on(
        &server,
        "ProjectServices",
        None,
        json!({ "data": { "project": { "services": {
            "edges": [
                { "node": { "id": uuid(20), "name": "api", "deletedAt": null }},
                { "node": { "id": uuid(21), "name": "velho", "deletedAt": "2026-01-01T00:00:00Z" }}
            ],
            "pageInfo": page_info(None)
        }}}}),
    )
    .await;

    let detail = client(&server)
        .get_project(&token(), &RailwayProjectId::parse(&id).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.project.name, "loja");
    assert_eq!(detail.environments.len(), 2);
    assert!(detail.environments[1].is_ephemeral);
    assert_eq!(detail.services.len(), 1);
    assert_eq!(detail.services[0].name, "api");
}

#[tokio::test]
async fn projeto_inexistente_e_none() {
    let server = MockServer::start().await;
    on(
        &server,
        "Project",
        None,
        json!({ "data": null, "errors": [{ "message": "Project not found" }] }),
    )
    .await;
    let got = client(&server)
        .get_project(&token(), &RailwayProjectId::parse(&uuid(1)).unwrap())
        .await;
    assert_eq!(got, Ok(None));
}

#[tokio::test]
async fn instancias_do_ambiente_mapeiam_estado() {
    let server = MockServer::start().await;
    let instance = |service: u32, latest: Value, active: Value| {
        json!({ "node": {
            "serviceId": uuid(service), "serviceName": format!("s{service}"),
            "environmentId": uuid(10), "deletedAt": null,
            "latestDeployment": latest, "activeDeployments": active
        }})
    };
    on(
        &server,
        "EnvironmentInstances",
        None,
        json!({ "data": { "environment": {
            "id": uuid(10), "deletedAt": null,
            "serviceInstances": {
                "edges": [
                    instance(20, deployment(1, "SUCCESS"), json!([deployment(1, "SUCCESS")])),
                    instance(21, deployment(2, "REMOVED"), json!([])),
                    instance(22, json!(null), json!([]))
                ],
                "pageInfo": page_info(None)
            }
        }}}),
    )
    .await;

    let instances = client(&server)
        .list_service_instances(&token(), &RailwayEnvironmentId::parse(&uuid(10)).unwrap())
        .await
        .unwrap()
        .unwrap();
    let states: Vec<_> = instances
        .iter()
        .map(|i| observe(Some(&i.snapshot)).state)
        .collect();
    assert_eq!(
        states,
        [
            ObservedState::Running,
            ObservedState::Stopped,
            ObservedState::Stopped
        ]
    );
    assert_eq!(
        instances[0].snapshot.active[0].status,
        DeploymentStatus::Success
    );
    assert_eq!(instances[1].service_name, "s21");
}

#[tokio::test]
async fn instancia_inexistente_e_none() {
    let server = MockServer::start().await;
    on(
        &server,
        "ServiceInstance",
        None,
        json!({ "data": null, "errors": [{ "message": "ServiceInstance not found" }] }),
    )
    .await;
    let got = client(&server)
        .get_service_instance(
            &token(),
            &RailwayEnvironmentId::parse(&uuid(10)).unwrap(),
            &RailwayServiceId::parse(&uuid(20)).unwrap(),
        )
        .await;
    assert_eq!(got, Ok(None));
}

#[tokio::test]
async fn mutations_de_energia() {
    let server = MockServer::start().await;
    on(
        &server,
        "DeploymentRemove",
        None,
        json!({ "data": { "deploymentRemove": true } }),
    )
    .await;
    on(
        &server,
        "DeploymentStop",
        None,
        json!({ "data": { "deploymentStop": true } }),
    )
    .await;
    on(
        &server,
        "DeploymentRedeploy",
        Some(json!({ "query": "mutation DeploymentRedeploy($id: String!) {\n  deploymentRedeploy(id: $id, usePreviousImageTag: true) {\n    ...DeploymentFields\n  }\n}\n\nfragment DeploymentFields on Deployment {\n  id\n  status\n  canRedeploy\n  deploymentStopped\n}\n" })),
        json!({ "data": { "deploymentRedeploy": deployment(5, "INITIALIZING") } }),
    )
    .await;

    let c = client(&server);
    let id = RailwayDeploymentId::parse(&uuid(1)).unwrap();
    c.stop_deployment(&token(), &id, StopMechanism::Remove)
        .await
        .unwrap();
    c.stop_deployment(&token(), &id, StopMechanism::Stop)
        .await
        .unwrap();
    let new = c.redeploy_deployment(&token(), &id).await.unwrap();
    assert_eq!(new.id.as_str(), uuid(5));
    assert_eq!(new.status, DeploymentStatus::Initializing);
}

#[tokio::test]
async fn me_mapeia_workspaces() {
    let server = MockServer::start().await;
    on(
        &server,
        "Me",
        None,
        json!({ "data": { "me": {
            "name": "Ana", "email": "ana@example.com",
            "workspaces": [{ "id": uuid(900), "name": "pessoal" }]
        }}}),
    )
    .await;
    let me = client(&server).me(&token()).await.unwrap();
    assert_eq!(me.email, "ana@example.com");
    assert_eq!(me.workspaces[0].name, "pessoal");
}

#[tokio::test]
async fn origem_do_reinicio_pelo_historico_com_data_e_motivo() {
    let server = MockServer::start().await;
    let node = |n: u32, status: &str, created: &str, reason: &str| {
        json!({ "node": {
            "id": uuid(n), "status": status, "canRedeploy": true, "deploymentStopped": false,
            "createdAt": created, "meta": { "reason": reason, "commitHash": format!("c{n}") }
        }})
    };
    on(
        &server,
        "Deployments",
        Some(json!({ "variables": { "first": 50, "input": { "environmentId": uuid(10), "serviceId": uuid(20) } } })),
        json!({ "data": { "deployments": { "edges": [
            node(5, "REMOVED", "2026-11-17T02:01:23.877Z", "redeploy"),
            node(4, "FAILED", "2026-11-17T01:57:07.560Z", "redeploy"),
            // Fora de ordem de propósito: o mais recente pela data deve vencer.
            node(2, "REMOVED", "2026-11-16T11:53:46.492Z", "deploy"),
            node(3, "REMOVED", "2026-11-17T01:35:39.900Z", "deploy"),
            node(1, "FAILED", "2026-11-17T03:00:00.000Z", "deploy")
        ]}}}),
    )
    .await;
    let chosen = client(&server)
        .restart_source(
            &token(),
            &RailwayEnvironmentId::parse(&uuid(10)).unwrap(),
            &RailwayServiceId::parse(&uuid(20)).unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(chosen.id.as_str(), uuid(3));
    assert_eq!(chosen.status, DeploymentStatus::Removed);
}

async fn instance_with_failure_on_top(server: &MockServer, history: Value) -> ObservedState {
    on(
        server,
        "EnvironmentInstances",
        None,
        json!({ "data": { "environment": {
            "id": uuid(10), "deletedAt": null,
            "serviceInstances": {
                "edges": [{ "node": {
                    "serviceId": uuid(20), "serviceName": "web", "environmentId": uuid(10), "deletedAt": null,
                    "latestDeployment": { "id": uuid(90), "status": "FAILED", "canRedeploy": true, "deploymentStopped": true },
                    "activeDeployments": []
                }}],
                "pageInfo": page_info(None)
            }
        }}}),
    )
    .await;
    on(
        server,
        "Deployments",
        None,
        json!({ "data": { "deployments": { "edges": history } } }),
    )
    .await;
    let instances = client(server)
        .list_service_instances(&token(), &RailwayEnvironmentId::parse(&uuid(10)).unwrap())
        .await
        .unwrap()
        .unwrap();
    observe(Some(&instances[0].snapshot)).state
}

fn hist(n: u32, status: &str, created: &str) -> Value {
    json!({ "node": {
        "id": uuid(n), "status": status, "canRedeploy": true, "deploymentStopped": true,
        "createdAt": created, "meta": { "reason": "deploy" }
    }})
}

#[tokio::test]
async fn falha_antiga_sob_deploy_desligado_aparece_desligada() {
    let server = MockServer::start().await;
    let state = instance_with_failure_on_top(
        &server,
        json!([
            hist(91, "REMOVED", "2026-11-17T02:01:23.877Z"),
            hist(90, "FAILED", "2026-03-01T10:00:00.000Z")
        ]),
    )
    .await;
    assert_eq!(state, ObservedState::Stopped);
}

#[tokio::test]
async fn falha_que_e_o_deploy_mais_recente_continua_com_falha() {
    let server = MockServer::start().await;
    let state = instance_with_failure_on_top(
        &server,
        json!([
            hist(90, "FAILED", "2026-11-17T03:00:00.000Z"),
            hist(91, "REMOVED", "2026-11-17T02:01:23.877Z")
        ]),
    )
    .await;
    assert_eq!(state, ObservedState::Failed);
}
