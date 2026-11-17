# ADR-004: Fluxo plano → execução → verificação

- **Status:** aceito
- **Data:** 2026-11-16
- **Relacionado:** `design.md` (Decisões 6 e 7), spec `service-power-control`, `operation-audit`

## Contexto

Desligar/iniciar infraestrutura precisa ser previsível (o que será feito, exatamente),
imune a cliques duplos, auditável e tolerante a falhas parciais. Mutations do Railway não
são seguramente re-executáveis quando o resultado é incerto.

## Decisão

1. **Plano persistido.** `POST /api/operations/plan` lê o estado atual (uma consulta
   por ambiente), decide `will_stop | will_start | will_skip(motivo)` por instância com
   a função pura `domain::power::decide` e grava `operation_plans` com validade
   (`RM_PLAN_TTL_SECS`, padrão 5 min).
2. **Consumo atômico.** `POST /api/operations { plan_id }` roda numa transação
   `BEGIN IMMEDIATE`: verifica o plano (inexistente → 400, expirado → 410, já usado →
   409 com o `operation_id` existente), marca como consumido e cria `operations` +
   `operation_items`. Itens ignorados já nascem finalizados (`skipped`, ou `failed`
   quando o pedido é inviável — ex.: sem deployment reaproveitável).
3. **Bloqueio de conflito no banco.** Índice único parcial em
   `operation_items(service_instance_id) WHERE result IN ('pending','running','verifying')`.
   Em lote, o item conflitante vira `skipped: operação em andamento`; em operação
   individual a transação é desfeita e a resposta é 409. Remoção de projeto, serviço ou
   instância consulta o mesmo critério.
4. **Execução em segundo plano.** `tokio::spawn` com `Semaphore(RM_MAX_CONCURRENCY)`.
   Por item: grava `running` (sem isso a mutation não é enviada) → relê o estado
   (pré-condição; a tela pode estar desatualizada) → mutation → `verifying` → polling.
   Erros ficam no item; os demais seguem. HTTP 429 numa mutation significa "não
   aplicado": aguarda `Retry-After` e reenvia (até 3 vezes). Timeout numa mutation é
   "resultado incerto": **não** reenvia e decide pelo estado real lido no polling.
5. **Verificação.** Polling agrupado por ambiente (leituras compartilhadas entre itens
   do mesmo ambiente), intervalo com backoff até `RM_POLL_MAX_INTERVAL_SECS`, prazo
   `RM_START_TIMEOUT_SECS`/`RM_STOP_TIMEOUT_SECS`. Resultado `succeeded`, `failed`
   (ex.: novo deployment `CRASHED`) ou `timed_out`. Cada leitura atualiza o estado
   observado da instância.
6. **Reinício.** Na inicialização, itens ativos viram `interrupted`, as operações são
   finalizadas com o agregado e nada é reexecutado.

## Alternativas consideradas

- **Confirmação só no frontend** — a lista exibida poderia divergir da executada, e
  cliques duplos executariam duas vezes.
- **Fila durável com retomada** — exigiria reexecutar mutations após reinício, o que
  não é seguro; `interrupted` + sincronização é mais honesto.
- **Lock em memória** — não sobrevive a corridas entre requisições nem a reinícios;
  o índice no SQLite é a fonte da verdade.

## Consequências

- O caso de uso `PowerService::execute` é o ponto de entrada que o agendador futuro
  usará (gravando `trigger = schedule`).
- Premissa de processo único (SQLite); várias réplicas exigiriam outro banco.
- Testes: `server/tests/power.rs` (plano, concorrência medida, falha isolada, incerteza,
  rate limit, timeout, polling agrupado) e `server/tests/e2e.rs` (cliente GraphQL real
  contra Railway simulado).
