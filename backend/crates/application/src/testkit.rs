//! `RailwayGateway` falso e programável, para testes dos casos de uso e da API.
//! Disponível com a feature `testkit`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use domain::deployment::{Deployment, DeploymentStatus};
use domain::ids::{
    RailwayDeploymentId, RailwayEnvironmentId, RailwayProjectId, RailwayServiceId,
    RailwayWorkspaceId,
};
use domain::power::StopMechanism;
use domain::state::InstanceSnapshot;

use crate::railway::*;

/// UUID determinístico para testes.
pub fn rid<T: std::str::FromStr>(n: u32) -> T
where
    T::Err: std::fmt::Debug,
{
    format!("00000000-0000-4000-8000-{n:012}").parse().unwrap()
}

#[derive(Debug, Clone)]
struct FakeInstance {
    project: RailwayProjectId,
    service_name: String,
    snapshot: InstanceSnapshot,
    /// Leituras restantes em transição e o snapshot final depois delas.
    pending: Option<(u32, InstanceSnapshot)>,
}

#[derive(Default)]
struct State {
    tokens: HashSet<String>,
    account: Option<AccountInfo>,
    workspaces: HashMap<RailwayWorkspaceId, WorkspaceInfo>,
    projects: Vec<RailwayProjectDetail>,
    instances: HashMap<(RailwayEnvironmentId, RailwayServiceId), FakeInstance>,
    calls: Vec<String>,
    fail_next: HashMap<String, VecDeque<RailwayError>>,
    fail_deployment: HashMap<RailwayDeploymentId, RailwayError>,
    redeploy_outcome: HashMap<RailwayDeploymentId, DeploymentStatus>,
    /// Mutations aceitas cujo efeito nunca se materializa (para testar timeouts).
    stuck: HashSet<RailwayDeploymentId>,
    /// Mutations aplicadas que respondem como "resultado incerto" (timeout após envio).
    uncertain: HashSet<RailwayDeploymentId>,
    unavailable: bool,
    /// Como o Railway real: `latestDeployment` omite deployments `REMOVED`.
    hide_removed_latest: bool,
    /// Resposta de `restart_source` por instância (o "último commit que subiu").
    restart_sources: HashMap<(RailwayEnvironmentId, RailwayServiceId), Deployment>,
    settle_reads: u32,
    mutation_delay: Duration,
    in_flight: usize,
    max_in_flight: usize,
    next_deployment: u32,
    rate_limit: RateLimitStatus,
}

pub struct FakeRailway {
    state: Mutex<State>,
}

impl Default for FakeRailway {
    fn default() -> Self {
        Self::new()
    }
}

fn deployment(id: RailwayDeploymentId, status: DeploymentStatus) -> Deployment {
    Deployment {
        id,
        status,
        can_redeploy: true,
        stopped: false,
    }
}

impl FakeRailway {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                next_deployment: 5000,
                ..Default::default()
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn accept_token(&self, token: &str) -> &Self {
        self.lock().tokens.insert(token.to_owned());
        self
    }

    pub fn with_account(&self, name: &str, email: &str, workspaces: &[(u32, &str)]) -> &Self {
        let workspaces: Vec<_> = workspaces
            .iter()
            .map(|(n, name)| WorkspaceInfo {
                id: rid(*n),
                name: (*name).into(),
            })
            .collect();
        let mut s = self.lock();
        for w in &workspaces {
            s.workspaces.insert(w.id.clone(), w.clone());
        }
        s.account = Some(AccountInfo {
            name: Some(name.into()),
            email: email.into(),
            workspaces,
        });
        self
    }

    pub fn with_workspace(&self, n: u32, name: &str) -> &Self {
        self.lock().workspaces.insert(
            rid(n),
            WorkspaceInfo {
                id: rid(n),
                name: name.into(),
            },
        );
        self
    }

    pub fn add_project(&self, n: u32, name: &str, workspace: Option<u32>) -> &Self {
        self.lock().projects.push(RailwayProjectDetail {
            project: RailwayProject {
                id: rid(n),
                name: name.into(),
                description: None,
                workspace_id: workspace.map(rid),
            },
            environments: vec![],
            services: vec![],
        });
        self
    }

    pub fn remove_project(&self, n: u32) -> &Self {
        let id: RailwayProjectId = rid(n);
        let mut s = self.lock();
        s.projects.retain(|p| p.project.id != id);
        s.instances.retain(|_, i| i.project != id);
        self
    }

    pub fn add_environment(&self, project: u32, n: u32, name: &str, ephemeral: bool) -> &Self {
        let project: RailwayProjectId = rid(project);
        let mut s = self.lock();
        let p = s
            .projects
            .iter_mut()
            .find(|p| p.project.id == project)
            .expect("projeto");
        p.environments.push(RailwayEnvironment {
            id: rid(n),
            name: name.into(),
            is_ephemeral: ephemeral,
        });
        self
    }

    pub fn add_service(&self, project: u32, n: u32, name: &str) -> &Self {
        let project: RailwayProjectId = rid(project);
        let mut s = self.lock();
        let p = s
            .projects
            .iter_mut()
            .find(|p| p.project.id == project)
            .expect("projeto");
        p.services.push(RailwayService {
            id: rid(n),
            name: name.into(),
        });
        self
    }

    /// Instância `running` com o deployment `deployment_n` ativo.
    pub fn add_running(&self, project: u32, env: u32, service: u32, deployment_n: u32) -> &Self {
        let d = deployment(rid(deployment_n), DeploymentStatus::Success);
        self.add_instance(
            project,
            env,
            service,
            InstanceSnapshot {
                deleted: false,
                latest: Some(d.clone()),
                active: vec![d],
            },
        )
    }

    /// Instância `stopped` com o deployment `deployment_n` removido.
    pub fn add_stopped(&self, project: u32, env: u32, service: u32, deployment_n: u32) -> &Self {
        let d = deployment(rid(deployment_n), DeploymentStatus::Removed);
        self.add_instance(
            project,
            env,
            service,
            InstanceSnapshot {
                deleted: false,
                latest: Some(d),
                active: vec![],
            },
        )
    }

    pub fn add_instance(
        &self,
        project: u32,
        env: u32,
        service: u32,
        snapshot: InstanceSnapshot,
    ) -> &Self {
        let mut s = self.lock();
        let project_id: RailwayProjectId = rid(project);
        let service_id: RailwayServiceId = rid(service);
        let name = s
            .projects
            .iter()
            .find(|p| p.project.id == project_id)
            .and_then(|p| p.services.iter().find(|x| x.id == service_id))
            .map(|x| x.name.clone())
            .unwrap_or_else(|| format!("service-{service}"));
        s.instances.insert(
            (rid(env), service_id),
            FakeInstance {
                project: project_id,
                service_name: name,
                snapshot,
                pending: None,
            },
        );
        self
    }

    pub fn set_snapshot(&self, env: u32, service: u32, snapshot: InstanceSnapshot) -> &Self {
        let key = (rid(env), rid(service));
        let mut s = self.lock();
        let inst = s.instances.get_mut(&key).expect("instância");
        inst.snapshot = snapshot;
        inst.pending = None;
        self
    }

    pub fn remove_instance(&self, env: u32, service: u32) -> &Self {
        self.lock().instances.remove(&(rid(env), rid(service)));
        self
    }

    /// A próxima chamada à operação (nome do método) falha com o erro.
    pub fn fail_next(&self, operation: &str, err: RailwayError) -> &Self {
        self.lock()
            .fail_next
            .entry(operation.into())
            .or_default()
            .push_back(err);
        self
    }

    /// Mutations sobre o deployment sempre falham.
    pub fn fail_deployment(&self, n: u32, err: RailwayError) -> &Self {
        self.lock().fail_deployment.insert(rid(n), err);
        self
    }

    /// Status final do deployment criado ao reimplantar `n`.
    pub fn redeploy_outcome(&self, n: u32, status: DeploymentStatus) -> &Self {
        self.lock().redeploy_outcome.insert(rid(n), status);
        self
    }

    /// Mutation sobre `n` é aceita mas o estado nunca muda.
    pub fn stuck(&self, n: u32) -> &Self {
        self.lock().stuck.insert(rid(n));
        self
    }

    /// Mutation sobre `n` é aplicada, mas a resposta se perde (timeout).
    pub fn uncertain(&self, n: u32) -> &Self {
        self.lock().uncertain.insert(rid(n));
        self
    }

    /// Reproduz o Railway: instância desligada vem sem `latestDeployment`; o último
    /// deployment só aparece em `last_deployment` (consulta `deployments`).
    pub fn railway_like_latest(&self) -> &Self {
        self.lock().hide_removed_latest = true;
        self
    }

    /// Define o deployment que o histórico indica como último commit que subiu.
    pub fn restart_from(&self, env: u32, service: u32, deployment: Deployment) -> &Self {
        self.lock()
            .restart_sources
            .insert((rid(env), rid(service)), deployment);
        self
    }

    pub fn set_unavailable(&self, unavailable: bool) -> &Self {
        self.lock().unavailable = unavailable;
        self
    }

    /// Leituras em `transitioning` antes de o efeito de uma mutation aparecer.
    pub fn settle_after(&self, reads: u32) -> &Self {
        self.lock().settle_reads = reads;
        self
    }

    pub fn mutation_delay(&self, delay: Duration) -> &Self {
        self.lock().mutation_delay = delay;
        self
    }

    pub fn set_rate_limit(&self, status: RateLimitStatus) -> &Self {
        self.lock().rate_limit = status;
        self
    }

    pub fn calls(&self) -> Vec<String> {
        self.lock().calls.clone()
    }

    pub fn mutation_calls(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|c| c.starts_with("deployment"))
            .collect()
    }

    pub fn max_in_flight(&self) -> usize {
        self.lock().max_in_flight
    }

    pub fn snapshot(&self, env: u32, service: u32) -> Option<InstanceSnapshot> {
        self.lock()
            .instances
            .get(&(rid(env), rid(service)))
            .map(|i| i.snapshot.clone())
    }

    fn enter(&self, call: String, token: &RailwayToken) -> RailwayResult<()> {
        let mut s = self.lock();
        let name = call.split('(').next().unwrap_or_default().to_owned();
        s.calls.push(call);
        if let Some(err) = s.fail_next.get_mut(&name).and_then(VecDeque::pop_front) {
            return Err(err);
        }
        if s.unavailable {
            return Err(RailwayError::Unavailable("simulado".into()));
        }
        if !s.tokens.contains(token.expose()) {
            return Err(RailwayError::Unauthorized);
        }
        Ok(())
    }

    async fn mutate<T>(
        &self,
        call: String,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
        apply: impl FnOnce(&mut State) -> RailwayResult<T>,
    ) -> RailwayResult<T> {
        self.enter(call, token)?;
        let delay = {
            let mut s = self.lock();
            s.in_flight += 1;
            s.max_in_flight = s.max_in_flight.max(s.in_flight);
            s.mutation_delay
        };
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let mut s = self.lock();
        s.in_flight -= 1;
        if let Some(err) = s.fail_deployment.get(id) {
            return Err(err.clone());
        }
        let uncertain = s.uncertain.contains(id);
        let result = apply(&mut s);
        if uncertain && result.is_ok() {
            let name = s.calls.last().cloned().unwrap_or_default();
            return Err(RailwayError::Uncertain(name));
        }
        result
    }
}

fn find_by_deployment<'a>(
    s: &'a mut State,
    id: &RailwayDeploymentId,
) -> Option<(
    &'a (RailwayEnvironmentId, RailwayServiceId),
    &'a mut FakeInstance,
)> {
    s.instances.iter_mut().find(|(_, i)| {
        i.snapshot.latest.as_ref().is_some_and(|d| &d.id == id)
            || i.snapshot.active.iter().any(|d| &d.id == id)
            || i.pending
                .as_ref()
                .is_some_and(|(_, f)| f.latest.as_ref().is_some_and(|d| &d.id == id))
    })
}

fn transitioning(base: &InstanceSnapshot, status: DeploymentStatus) -> InstanceSnapshot {
    let mut snap = base.clone();
    if let Some(latest) = snap.latest.as_mut() {
        latest.status = status;
    }
    snap.active
        .retain(|d| d.status != DeploymentStatus::Success);
    snap
}

#[async_trait]
impl RailwayGateway for FakeRailway {
    async fn me(&self, token: &RailwayToken) -> RailwayResult<AccountInfo> {
        self.enter("me".into(), token)?;
        self.lock()
            .account
            .clone()
            .ok_or(RailwayError::Unauthorized)
    }

    async fn workspace(
        &self,
        token: &RailwayToken,
        id: &RailwayWorkspaceId,
    ) -> RailwayResult<WorkspaceInfo> {
        self.enter(format!("workspace({id})"), token)?;
        self.lock()
            .workspaces
            .get(id)
            .cloned()
            .ok_or_else(|| RailwayError::NotFound(format!("workspace {id}")))
    }

    async fn list_projects(
        &self,
        token: &RailwayToken,
        workspace: Option<&RailwayWorkspaceId>,
    ) -> RailwayResult<Vec<RailwayProject>> {
        let label = workspace.map(ToString::to_string).unwrap_or_default();
        self.enter(format!("list_projects({label})"), token)?;
        Ok(self
            .lock()
            .projects
            .iter()
            .map(|p| p.project.clone())
            .filter(|p| workspace.is_none() || p.workspace_id.as_ref() == workspace)
            .collect())
    }

    async fn get_project(
        &self,
        token: &RailwayToken,
        id: &RailwayProjectId,
    ) -> RailwayResult<Option<RailwayProjectDetail>> {
        self.enter(format!("get_project({id})"), token)?;
        Ok(self
            .lock()
            .projects
            .iter()
            .find(|p| &p.project.id == id)
            .cloned())
    }

    async fn list_service_instances(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
    ) -> RailwayResult<Option<Vec<RailwayServiceInstance>>> {
        self.enter(format!("list_service_instances({environment})"), token)?;
        let mut s = self.lock();
        let hide_removed = s.hide_removed_latest;
        let exists = s
            .projects
            .iter()
            .any(|p| p.environments.iter().any(|e| &e.id == environment));
        if !exists {
            return Ok(None);
        }
        let mut out: Vec<_> = s
            .instances
            .iter_mut()
            .filter(|((env, _), _)| env == environment)
            .map(|((env, service), inst)| read_instance(env, service, inst))
            .map(|i| hide(i, hide_removed))
            .collect();
        out.sort_by(|a, b| a.service_id.cmp(&b.service_id));
        Ok(Some(out))
    }

    async fn get_service_instance(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
        service: &RailwayServiceId,
    ) -> RailwayResult<Option<RailwayServiceInstance>> {
        self.enter(
            format!("get_service_instance({environment},{service})"),
            token,
        )?;
        let mut s = self.lock();
        Ok(s.instances
            .get_mut(&(environment.clone(), service.clone()))
            .map(|inst| read_instance(environment, service, inst)))
    }

    async fn restart_source(
        &self,
        token: &RailwayToken,
        environment: &RailwayEnvironmentId,
        service: &RailwayServiceId,
    ) -> RailwayResult<Option<Deployment>> {
        self.enter(format!("restart_source({environment},{service})"), token)?;
        let s = self.lock();
        let key = (environment.clone(), service.clone());
        if let Some(source) = s.restart_sources.get(&key) {
            return Ok(Some(source.clone()));
        }
        Ok(s.instances
            .get(&key)
            .and_then(|i| i.snapshot.latest.clone()))
    }

    async fn get_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
    ) -> RailwayResult<Option<Deployment>> {
        self.enter(format!("get_deployment({id})"), token)?;
        let mut s = self.lock();
        Ok(find_by_deployment(&mut s, id).and_then(|(_, i)| {
            i.snapshot
                .latest
                .iter()
                .chain(i.snapshot.active.iter())
                .find(|d| &d.id == id)
                .cloned()
        }))
    }

    async fn stop_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
        mechanism: StopMechanism,
    ) -> RailwayResult<()> {
        let op = match mechanism {
            StopMechanism::Remove => "deploymentRemove",
            StopMechanism::Stop => "deploymentStop",
        };
        self.mutate(format!("{op}({id})"), token, id, |s| {
            let stuck = s.stuck.contains(id);
            let settle = s.settle_reads;
            let (_, inst) = find_by_deployment(s, id)
                .ok_or_else(|| RailwayError::NotFound(format!("deployment {id}")))?;
            if stuck {
                return Ok(());
            }
            let mut stopped = inst.snapshot.clone();
            stopped.active.retain(|d| &d.id != id);
            if let Some(latest) = stopped.latest.as_mut().filter(|d| &d.id == id) {
                match mechanism {
                    StopMechanism::Remove => latest.status = DeploymentStatus::Removed,
                    StopMechanism::Stop => latest.stopped = true,
                }
            }
            if settle == 0 {
                inst.snapshot = stopped;
            } else {
                inst.snapshot = transitioning(&inst.snapshot, DeploymentStatus::Removing);
                inst.pending = Some((settle - 1, stopped));
            }
            Ok(())
        })
        .await
    }

    async fn redeploy_deployment(
        &self,
        token: &RailwayToken,
        id: &RailwayDeploymentId,
    ) -> RailwayResult<Deployment> {
        self.mutate(format!("deploymentRedeploy({id})"), token, id, |s| {
            s.next_deployment += 1;
            let new_id: RailwayDeploymentId = rid(s.next_deployment);
            let outcome = s
                .redeploy_outcome
                .get(id)
                .copied()
                .unwrap_or(DeploymentStatus::Success);
            let stuck = s.stuck.contains(id);
            let settle = s.settle_reads;
            // Também aceita o deployment indicado pelo histórico (`restart_from`).
            let from_history = s
                .restart_sources
                .iter()
                .find(|(_, d)| &d.id == id)
                .map(|(key, _)| key.clone());
            let inst = match from_history {
                Some(key) => s.instances.get_mut(&key),
                None => find_by_deployment(s, id).map(|(_, inst)| inst),
            }
            .ok_or_else(|| RailwayError::NotFound(format!("deployment {id}")))?;
            let created = deployment(new_id.clone(), DeploymentStatus::Initializing);
            if stuck {
                inst.snapshot.latest = Some(created.clone());
                return Ok(created);
            }
            let final_deployment = deployment(new_id, outcome);
            let final_snapshot = InstanceSnapshot {
                deleted: false,
                latest: Some(final_deployment.clone()),
                active: if outcome == DeploymentStatus::Success {
                    vec![final_deployment]
                } else {
                    vec![]
                },
            };
            if settle == 0 {
                inst.snapshot = final_snapshot;
            } else {
                inst.snapshot = InstanceSnapshot {
                    deleted: false,
                    latest: Some(created.clone()),
                    active: vec![],
                };
                inst.pending = Some((settle - 1, final_snapshot));
            }
            Ok(created)
        })
        .await
    }

    fn rate_limit_status(&self) -> RateLimitStatus {
        self.lock().rate_limit.clone()
    }
}

fn hide(mut instance: RailwayServiceInstance, hide_removed: bool) -> RailwayServiceInstance {
    if hide_removed
        && instance
            .snapshot
            .latest
            .as_ref()
            .is_some_and(|d| d.status == DeploymentStatus::Removed)
    {
        instance.snapshot.latest = None;
    }
    instance
}

fn read_instance(
    env: &RailwayEnvironmentId,
    service: &RailwayServiceId,
    inst: &mut FakeInstance,
) -> RailwayServiceInstance {
    if let Some((left, final_snapshot)) = inst.pending.take() {
        if left == 0 {
            inst.snapshot = final_snapshot;
        } else {
            inst.pending = Some((left - 1, final_snapshot));
        }
    }
    RailwayServiceInstance {
        service_id: service.clone(),
        service_name: inst.service_name.clone(),
        environment_id: env.clone(),
        snapshot: inst.snapshot.clone(),
    }
}

/// Relógio controlado pelo teste.
pub struct ManualClock(Mutex<chrono::DateTime<chrono::Utc>>);

impl ManualClock {
    pub fn at(now: chrono::DateTime<chrono::Utc>) -> Self {
        Self(Mutex::new(now))
    }

    pub fn set(&self, now: chrono::DateTime<chrono::Utc>) {
        *self.0.lock().unwrap() = now;
    }
}

impl crate::ports::Clock for ManualClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        *self.0.lock().unwrap()
    }
}
