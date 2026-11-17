# ADR-003: Mecanismo de desligamento (`deploymentRemove` × `deploymentStop`)

- **Status:** proposto — aguardando o spike em conta real (tarefa 2.6)
- **Data:** 2026-11-16
- **Relacionado:** `design.md` (Decisão 1), spec `service-power-control`

## Contexto

Desligar precisa interromper todos os deployments ativos sem apagar serviço, volumes,
variáveis ou configuração, e precisa ser reversível por "iniciar" reaproveitando a
mesma imagem. Duas mutations existem no schema:

- `deploymentRemove(id)` — documentada como "remove the deployment and stop any
  further project usage"; já usada em produção pelo `railway.sh`. Status `REMOVING` →
  `REMOVED`. Religar com `deploymentRedeploy(id, usePreviousImageTag: true)` funciona no
  fluxo atual do template.
- `deploymentStop(id)` — documentada apenas como "Stop a running deployment". Não está
  documentado qual status resulta, o valor de `deploymentStopped`/`canRedeploy` depois,
  nem se `deploymentRedeploy` volta a mesma imagem.

## Decisão (provisória)

Padrão `StopMechanism::Remove`. A escolha fica em `RM_STOP_MECHANISM` (`remove`|`stop`)
e só afeta o adaptador e a regra de "deployment parado" do domínio (`REMOVED` ou
`deploymentStopped = true`).

## Protocolo do spike (a executar)

Em um projeto descartável, com um serviço simples **e** um serviço com volume:

1. Deployment `SUCCESS`; anotar `id`, `canRedeploy`, `deploymentStopped`.
2. `deploymentStop(id)`: medir o status ao longo do tempo até estabilizar, `activeDeployments`,
   `deploymentStopped`, `canRedeploy` e o tempo até estabilizar.
3. `deploymentRedeploy(id, usePreviousImageTag: true)`: confirmar novo deployment
   `SUCCESS` com a mesma imagem (sem build) e o volume com os dados anteriores.
4. Repetir 1–3 com `deploymentRemove`.
5. Registrar os tempos típicos (para calibrar `RM_STOP_TIMEOUT_SECS`,
   `RM_START_TIMEOUT_SECS` e o polling).

## Resultado

_A preencher com as medições._

## Consequências

- Até o spike, `stop` é opt-in e deve ser tratado como experimental.
- Se `deploymentStop` se mostrar equivalente e preservar melhor o histórico, o padrão
  pode mudar sem alterar specs nem outras camadas.
