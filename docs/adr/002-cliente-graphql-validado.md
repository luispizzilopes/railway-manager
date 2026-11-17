# ADR-002: Cliente GraphQL validado em compilação, com lista fechada de operações

- **Status:** aceito
- **Data:** 2026-11-16
- **Relacionado:** `design.md` (Decisão 2), spec `railway-api-integration`

## Contexto

O `railway.sh` monta queries por concatenação de strings: um campo renomeado ou
inexistente só aparece como erro em produção. A documentação pública do Railway
também diverge do schema real (ex.: `DeploymentStatusInput.successfulOnly` não
existe). Precisamos que cada query/mutation usada seja comprovadamente válida e
que o conjunto de mutations seja restrito às necessárias para desligar e iniciar.

## Decisão

- Snapshot do schema obtido por introspecção em
  `backend/crates/infrastructure/graphql/railway.schema.json`, regenerado por
  `scripts/update-railway-schema.sh` (saída normalizada, diffs revisáveis).
- Um arquivo `.graphql` por operação em `backend/crates/infrastructure/graphql/`
  e `#[derive(GraphQLQuery)]` (`graphql_client`) em `src/railway/ops.rs`. Campos ou
  argumentos inexistentes fazem o **build falhar**; `build.rs` força a recompilação
  quando qualquer arquivo de `graphql/` muda.
- Operações: queries `Me`, `Workspace`, `Projects`, `Project`, `ProjectEnvironments`,
  `ProjectServices`, `EnvironmentInstances`, `ServiceInstance`, `Deployments`,
  `Deployment`; mutations `DeploymentRemove`, `DeploymentStop`, `DeploymentRedeploy`.
- A porta `RailwayGateway` expõe apenas métodos específicos; não há execução genérica
  de query.
- Um teste de guarda (`tests/allowed_mutations.rs`) falha se algum `.graphql` declarar
  mutation fora de `{deploymentRemove, deploymentStop, deploymentRedeploy}`.
- Escalar `DateTime` mapeado para `String` (só usamos presença de `deletedAt`).

## Verificação manual (registrada em 2026-11-16)

1. Acrescentar `campoInventado` à seleção de `graphql/deployment.graphql`.
2. `cargo build -p infrastructure` falha com:
   `Failed to generate GraphQLQuery impl: No field named campoInventado on Deployment`.
3. Reverter o arquivo: o build volta a passar.

Ao atualizar o snapshot, o mesmo mecanismo acusa campos que deixaram de existir.

## Alternativas consideradas

- **`cynic`** — também valida contra o schema, com API mais elaborada; sem ganho aqui.
- **Strings + `serde_json`** — sem validação (modelo atual do `railway.sh`). Rejeitada.

## Consequências

- Mudanças do schema do Railway viram erro de build após atualizar o snapshot,
  não erro em produção.
- Cada `.graphql` repete o fragmento `DeploymentFields`; `graphql_client` gera tipos
  por operação, mapeados para o domínio em `src/railway/client.rs`.
