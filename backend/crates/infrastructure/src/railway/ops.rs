//! Operações GraphQL do Railway, geradas em tempo de compilação por `graphql_client`
//! a partir de `graphql/*.graphql` e validadas contra `graphql/railway.schema.json`.
//! Um campo ou argumento inexistente no schema faz o build falhar (ADR-002).

#![allow(clippy::all, non_camel_case_types)]

use graphql_client::GraphQLQuery;

/// Escalar `DateTime` do Railway (ISO 8601); só verificamos presença.
pub type DateTime = String;

/// Escalar `DeploymentMeta` (JSON livre: `reason`, `commitHash`, …).
pub type DeploymentMeta = serde_json::Value;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/me.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct Me;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/workspace.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct Workspace;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/projects.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct Projects;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/project.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct Project;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/project_environments.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct ProjectEnvironments;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/project_services.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct ProjectServices;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/environment_instances.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct EnvironmentInstances;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/service_instance.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct ServiceInstance;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/deployments.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct Deployments;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/deployment.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct Deployment;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/deployment_remove.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct DeploymentRemove;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/deployment_stop.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct DeploymentStop;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/railway.schema.json",
    query_path = "graphql/deployment_redeploy.graphql",
    response_derives = "Debug, Clone",
    variables_derives = "Debug, Clone"
)]
pub struct DeploymentRedeploy;
