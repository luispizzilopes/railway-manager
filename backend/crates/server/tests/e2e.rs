//! Ponta a ponta com o cliente GraphQL real contra um Railway simulado (wiremock):
//! desligar um projeto com 3 instâncias (1 já parada), iniciar de volta e conferir
//! as chamadas exatas enviadas, o histórico e os estados finais.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use railway_manager::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;
use wiremock::{Mock, MockServer, Request as MockRequest, Respond, ResponseTemplate, matchers};

const TOKEN: &str = "tok-e2e-0123456789abcdef";

fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

#[derive(Clone)]
struct Dep {
    id: String,
    status: &'static str,
    /// Ordem de criação (vira `createdAt`).
    seq: u32,
    reason: &'static str,
    stopped: bool,
}

/// Railway mínimo: um projeto, um ambiente, três serviços, cada um com histórico.
#[derive(Default)]
struct Sim {
    /// service -> histórico de deployments (qualquer ordem).
    history: HashMap<u32, Vec<Dep>>,
    next: u32,
    /// (operação, variáveis) na ordem recebida.
    log: Vec<(String, Value)>,
}

impl Sim {
    /// Como o Railway: `latestDeployment` é o mais novo que **não** foi removido.
    fn latest(&self, service: u32) -> Option<&Dep> {
        self.history[&service]
            .iter()
            .filter(|d| d.status != "REMOVED")
            .max_by_key(|d| d.seq)
    }

    fn active(&self, service: u32) -> Vec<&Dep> {
        self.history[&service]
            .iter()
            .filter(|d| d.status == "SUCCESS")
            .collect()
    }
}

struct Railway(Arc<Mutex<Sim>>);

fn service_edges() -> Vec<Value> {
    [20, 21, 22]
        .iter()
        .map(
            |n| json!({ "node": { "id": uuid(*n), "name": format!("svc{n}"), "deletedAt": null } }),
        )
        .collect()
}

fn dep_json(d: &Dep) -> Value {
    json!({ "id": d.id, "status": d.status, "canRedeploy": true, "deploymentStopped": d.stopped })
}

fn created_at(seq: u32) -> String {
    format!("2026-11-17T00:{:02}:{:02}.000Z", seq / 60, seq % 60)
}

impl Respond for Railway {
    fn respond(&self, request: &MockRequest) -> ResponseTemplate {
        let auth = request
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok());
        if auth != Some(&format!("Bearer {TOKEN}")) {
            return ResponseTemplate::new(200)
                .set_body_json(json!({ "errors": [{ "message": "Not Authorized" }] }));
        }
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        let op = body["operationName"].as_str().unwrap().to_owned();
        let vars = body["variables"].clone();
        let mut sim = self.0.lock().unwrap();
        sim.log.push((op.clone(), vars.clone()));
        let page = json!({ "hasNextPage": false, "endCursor": null });

        let data = match op.as_str() {
            "Me" => json!({ "me": { "name": "Ana", "email": "ana@example.com",
                                    "workspaces": [{ "id": uuid(900), "name": "pessoal" }] } }),
            "Project" => json!({ "project": { "id": uuid(1), "name": "loja", "description": null,
                                              "workspaceId": uuid(900), "deletedAt": null } }),
            "ProjectEnvironments" => json!({ "project": { "environments": {
                "edges": [{ "node": { "id": uuid(10), "name": "production", "isEphemeral": false, "deletedAt": null } }],
                "pageInfo": page } } }),
            "ProjectServices" => json!({ "project": { "services": {
                "edges": service_edges(),
                "pageInfo": page } } }),
            "EnvironmentInstances" => {
                let edges: Vec<_> = [20, 21, 22]
                    .iter()
                    .map(|n| {
                        json!({ "node": {
                            "serviceId": uuid(*n), "serviceName": format!("svc{n}"), "environmentId": uuid(10),
                            "deletedAt": null,
                            "latestDeployment": sim.latest(*n).map(dep_json),
                            "activeDeployments": sim.active(*n).into_iter().map(dep_json).collect::<Vec<_>>()
                        } })
                    })
                    .collect();
                json!({ "environment": { "id": uuid(10), "deletedAt": null,
                                         "serviceInstances": { "edges": edges, "pageInfo": page } } })
            }
            "Deployments" => {
                let service: u32 = vars["input"]["serviceId"].as_str().unwrap()[24..]
                    .parse()
                    .unwrap();
                let mut list = sim.history[&service].clone();
                list.sort_by_key(|d| std::cmp::Reverse(d.seq));
                let edges: Vec<_> = list
                    .iter()
                    .map(|d| {
                        let mut node = dep_json(d);
                        node["createdAt"] = json!(created_at(d.seq));
                        node["meta"] = json!({ "reason": d.reason });
                        json!({ "node": node })
                    })
                    .collect();
                json!({ "deployments": { "edges": edges } })
            }
            "DeploymentRemove" => {
                let id = vars["id"].as_str().unwrap().to_owned();
                for d in sim.history.values_mut().flatten().filter(|d| d.id == id) {
                    d.status = "REMOVED";
                }
                json!({ "deploymentRemove": true })
            }
            "DeploymentRedeploy" => {
                let id = vars["id"].as_str().unwrap().to_owned();
                sim.next += 1;
                let seq = 1000 + sim.next;
                let new = Dep {
                    id: uuid(5000 + sim.next),
                    status: "SUCCESS",
                    seq,
                    reason: "redeploy",
                    stopped: false,
                };
                let service = *sim
                    .history
                    .iter()
                    .find(|(_, h)| h.iter().any(|d| d.id == id))
                    .expect("deployment")
                    .0;
                sim.history.get_mut(&service).unwrap().push(new.clone());
                json!({ "deploymentRedeploy": { "id": new.id, "status": "INITIALIZING",
                                                "canRedeploy": true, "deploymentStopped": false } })
            }
            other => panic!("operação inesperada: {other}"),
        };
        ResponseTemplate::new(200).set_body_json(json!({ "data": data }))
    }
}

async fn call(
    router: &axum::Router,
    cookie: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::COOKIE, cookie);
    if method != "GET" {
        req = req.header(header::CONTENT_TYPE, "application/json");
    }
    let body = body
        .map(|b| Body::from(b.to_string()))
        .unwrap_or_else(Body::empty);
    let response = router
        .clone()
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn desligar_e_iniciar_projeto_contra_railway_simulado() {
    let sim = Arc::new(Mutex::new(Sim::default()));
    {
        let mut s = sim.lock().unwrap();
        let dep = |n, status, seq, stopped| Dep {
            id: uuid(n),
            status,
            seq,
            reason: "deploy",
            stopped,
        };
        s.history.insert(20, vec![dep(100, "SUCCESS", 10, false)]);
        // Rodando, com uma falha antiga por baixo: depois de desligar, `latestDeployment`
        // passa a apontar para ela (98) e o desligamento ainda precisa ser confirmado.
        s.history.insert(
            21,
            vec![dep(98, "FAILED", 2, true), dep(101, "SUCCESS", 11, false)],
        );
        // Desligado, com uma falha antiga ainda "não removida" por baixo do último deploy:
        // `latestDeployment` aponta para a falha (99); iniciar deve usar o 102.
        s.history.insert(
            22,
            vec![dep(99, "FAILED", 1, true), dep(102, "REMOVED", 12, false)],
        );
    }
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .respond_with(Railway(sim.clone()))
        .mount(&server)
        .await;

    let vars: HashMap<&str, String> = [
        ("RM_ADMIN_PASSWORD", "admin".to_string()),
        (
            "RM_MASTER_KEY",
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".to_string(),
        ),
        ("RM_RAILWAY_API_URL", server.uri()),
        ("RM_RAILWAY_RPS", "50".to_string()),
        ("RM_POLL_INTERVAL_SECS", "1".to_string()),
        ("RM_POLL_MAX_INTERVAL_SECS", "1".to_string()),
    ]
    .into_iter()
    .collect();
    let config = Config::from_lookup(|k| vars.get(k).cloned()).unwrap();
    let pool = infrastructure::sqlite::connect("sqlite::memory:")
        .await
        .unwrap();
    let railway = Arc::new(railway_manager::railway_client(&config).unwrap());
    let router = api::router(railway_manager::build_state(&config, pool, railway), None);

    // Login.
    let login = Request::builder()
        .method("POST")
        .uri("/api/session")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "password": "admin" }).to_string()))
        .unwrap();
    let response = router.clone().oneshot(login).await.unwrap();
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    // Token, projeto e as três instâncias.
    let (s, _) = call(
        &router,
        &cookie,
        "PUT",
        "/api/credential",
        Some(json!({ "kind": "account", "token": TOKEN })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, created) = call(
        &router,
        &cookie,
        "POST",
        "/api/projects",
        Some(json!({ "railway_project_id": uuid(1) })),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    let project = created["project"]["id"].as_str().unwrap().to_owned();
    let instances: Vec<_> = [20, 21, 22]
        .iter()
        .map(|n| json!({ "environment_id": uuid(10), "service_id": uuid(*n) }))
        .collect();
    let (s, _) = call(
        &router,
        &cookie,
        "POST",
        &format!("/api/projects/{project}/instances/import"),
        Some(json!({ "instances": instances })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    // Desligado com falha antiga por baixo: aparece desligado, não "com falha".
    let (_, dash) = call(&router, &cookie, "GET", "/api/dashboard", None).await;
    let svc22 = dash["projects"][0]["environments"][0]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["service_name"] == "svc22")
        .unwrap()
        .clone();
    assert_eq!(svc22["state"], "stopped");

    let mark = sim.lock().unwrap().log.len();
    let operate = |kind: &'static str| {
        let router = router.clone();
        let cookie = cookie.clone();
        let project = project.clone();
        async move {
            let target =
                json!({ "kind": kind, "target": { "type": "project", "project_id": project } });
            let (_, plan) = call(
                &router,
                &cookie,
                "POST",
                "/api/operations/plan",
                Some(target),
            )
            .await;
            let (s, accepted) = call(
                &router,
                &cookie,
                "POST",
                "/api/operations",
                Some(json!({ "plan_id": plan["plan_id"] })),
            )
            .await;
            assert_eq!(s, StatusCode::ACCEPTED);
            let id = accepted["operation_id"].as_str().unwrap().to_owned();
            for _ in 0..100 {
                let (_, op) = call(
                    &router,
                    &cookie,
                    "GET",
                    &format!("/api/operations/{id}"),
                    None,
                )
                .await;
                if op["done"] == json!(true) {
                    return op;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("operação {kind} não terminou");
        }
    };

    // Desligar: 2 removes; a instância já parada é ignorada.
    let stop = operate("stop").await;
    assert_eq!(stop["operation"]["status"], "succeeded");
    let results: Vec<_> = stop["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["label"]["service_name"].as_str().unwrap(),
                i["result"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        results,
        [
            ("svc20", "succeeded"),
            ("svc21", "succeeded"),
            ("svc22", "skipped")
        ]
    );
    let mutations = |from: usize| -> Vec<(String, String)> {
        let mut m: Vec<_> = sim.lock().unwrap().log[from..]
            .iter()
            .filter(|(op, _)| op == "DeploymentRemove" || op == "DeploymentRedeploy")
            .map(|(op, v)| (op.clone(), v["id"].as_str().unwrap().to_owned()))
            .collect();
        m.sort();
        m
    };
    assert_eq!(
        mutations(mark),
        [
            ("DeploymentRemove".into(), uuid(100)),
            ("DeploymentRemove".into(), uuid(101))
        ]
    );

    // Iniciar de volta: redeploy de cada deployment parado, com a imagem anterior.
    let mark = sim.lock().unwrap().log.len();
    let start = operate("start").await;
    assert_eq!(start["operation"]["status"], "succeeded");
    assert!(
        start["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["result"] == "succeeded" && i["final_state"] == "running")
    );
    assert_eq!(
        mutations(mark),
        [
            ("DeploymentRedeploy".into(), uuid(100)),
            ("DeploymentRedeploy".into(), uuid(101)),
            ("DeploymentRedeploy".into(), uuid(102)),
        ]
    );
    let only_allowed = sim.lock().unwrap().log.iter().all(|(op, _)| {
        !op.starts_with("Deployment")
            || matches!(
                op.as_str(),
                "DeploymentRemove" | "DeploymentRedeploy" | "Deployments"
            )
    });
    assert!(only_allowed);

    // Histórico: 6 itens (3 por operação), mais recente primeiro.
    let (_, history) = call(&router, &cookie, "GET", "/api/history", None).await;
    assert_eq!(history["total"], 6);
    assert_eq!(history["items"][0]["kind"], "start");
    let (_, stops) = call(
        &router,
        &cookie,
        "GET",
        "/api/history?kind=stop&result=skipped",
        None,
    )
    .await;
    assert_eq!(stops["total"], 1);
    assert_eq!(stops["items"][0]["item"]["label"]["service_name"], "svc22");

    // Estados finais.
    let (_, dash) = call(&router, &cookie, "GET", "/api/dashboard", None).await;
    assert_eq!(dash["indicators"]["running"], 3);
    assert_eq!(dash["indicators"]["stopped"], 0);
    let states: Vec<_> = dash["projects"][0]["environments"][0]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["running", "running", "running"]);
}
