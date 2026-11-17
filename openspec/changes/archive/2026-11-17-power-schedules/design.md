## Context

Motivação e escopo em `proposal.md`; comportamento em `specs/power-schedules/spec.md`.

Estado relevante do código (change `railway-manager`):

- `application::power::PowerService` já faz plano → execução → verificação, com concorrência limitada, índice único de itens ativos (conflitos), escolha do deployment a reaproveitar (`restart_source`) e correção de falhas antigas no estado observado. `execute(plan_id, requested_by)` grava sempre `OperationTrigger::Manual`.
- Escopo `instance` recusa conflito com `409`; escopos `project`/`batch` transformam o item conflitante em `skipped`.
- `operations.trigger` tem `CHECK (trigger IN ('manual'))` no SQLite; `operation_items` referencia `operations` com `ON DELETE CASCADE`.
- O `server` sobe um único processo com Axum; não há tarefas periódicas além dos workers de operação.
- Datas são `TEXT` RFC 3339 em UTC com largura fixa; `Clock` é uma porta.

## Goals / Non-Goals

**Goals:**
- Regras de agenda (ocorrências, sobreposição, próximas execuções, DST) como funções puras no domínio, testáveis sem tempo real.
- Um único caminho de execução para manual e agendado (`PowerService`), sem duplicar regras.
- Exatamente-uma-vez por evento, garantido pelo banco, sobrevivendo a reinícios.

**Non-Goals:**
- Expressões cron livres, feriados, exceções por data, janelas diferentes por dia dentro da mesma agenda (usa-se outra agenda).
- Impor estado continuamente ("força o estado da janela").
- Várias réplicas do servidor executando o agendador.
- Notificações.

## Decisions

### 1. Modelo de agenda: janelas + dias + fuso (não cron)

```
schedules(id, project_id → projects ON DELETE CASCADE, name, enabled, timezone,
          days_mask INTEGER  -- bit 0 = segunda … bit 6 = domingo
          target_kind ('project'|'instances'), environment_id? → environments ON DELETE SET NULL,
          effective_from, paused_reason?, created_at, updated_at)
schedule_windows(schedule_id → schedules CASCADE, position, start_minute, end_minute)   -- 0..1439
schedule_instances(schedule_id → schedules CASCADE, service_instance_id → service_instances CASCADE,
                   PRIMARY KEY (schedule_id, service_instance_id))
schedule_runs(id, schedule_id → schedules CASCADE, schedule_name, action ('start'|'stop'),
              scheduled_for, processed_at, status ('pending'|'executed'|'late'|'skipped'|'missed'|'failed'),
              operation_id?, message?, UNIQUE (schedule_id, scheduled_for, action))
scheduler_state(id = 1, last_evaluated_at)
```

- O usuário pensa em "das 7 às 12"; janelas mapeiam isso diretamente e permitem validar sobreposição. `end_minute < start_minute` = termina no dia seguinte; igual é duração zero (inválido).
- `effective_from` é atualizado ao criar, editar e retomar: eventos com horário ≤ `effective_from` nunca são executados nem recuperados (spec: pausa e edição não recuperam o passado).
- Alvo `project` não grava instâncias: o conjunto é lido no momento do evento (instâncias novas entram, removidas saem). Alvo `instances` usa `schedule_instances`; a cascata remove a instância da agenda e, ao ficar vazia, o caso de uso pausa a agenda com `paused_reason = "sem instâncias no alvo"`.
- **Alternativa**: expressão cron por agenda (`0 7 * * 1-5`) — mais flexível, mas difícil de validar sobreposição, de exibir e de editar; rejeitada para v1.

### 2. Cálculo de ocorrências no domínio, com `chrono-tz`

- `domain::schedule::occurrences(schedule, from, to) -> Vec<Event{at: DateTime<Utc>, action, window}>` converte cada (dia selecionado, janela) do fuso local para UTC.
- DST: horário inexistente (adiantamento) → primeiro instante válido depois dele; horário ambíguo (atraso) → a primeira ocorrência. Assim nenhum evento some nem duplica.
- `next_occurrences(schedule, now, n)` alimenta a API e o dashboard.
- Validação (`Schedule::new`) rejeita dias vazios, janelas vazias, duração zero e sobreposição (comparando intervalos num ciclo de 7 dias, o que trata janelas que atravessam a meia-noite e a virada domingo → segunda).
- `chrono-tz` embute a base IANA no binário; nenhuma dependência do fuso do sistema/container.

### 3. Agendador: laço periódico + varredura de intervalo, não timers por evento

Worker (`tokio::spawn` no `server`) a cada `RM_SCHEDULER_TICK_SECS` (30 s) chama `SchedulerService::tick(now)`:

1. Lê `last_evaluated_at` (se ausente, grava `now` e sai — não há passado a recuperar na primeira execução).
2. Para cada agenda ativa, calcula eventos em `(max(last_evaluated_at, effective_from), now]`.
3. Por agenda: o evento mais recente é executado se `now - at ≤ RM_SCHEDULE_CATCHUP_SECS`; os anteriores viram `missed`. Em funcionamento normal só há um evento por janela de tick; o descarte só acontece após indisponibilidade.
4. Resolve conflitos entre agendas no mesmo instante (decisão 5).
5. Em uma transação: insere `schedule_runs` (`pending`) com `UNIQUE (schedule_id, scheduled_for, action)` e avança `last_evaluated_at = now`. Conflito de unicidade = evento já processado → ignora. Isso garante exatamente-uma-vez mesmo com reinício entre passos.
6. Para cada run `pending`: monta o alvo, chama `PowerService::plan` e `execute_as(plan_id, Trigger::Schedule{schedule_id, name})` com escopo `project` (conflitos viram `skipped`, nunca `409`), grava `operation_id` e status `executed`/`late` (`late` quando executado > 2 ticks depois do horário). Falha antes de criar a operação (sem credencial, erro do Railway no plano) → `failed` com mensagem; não há nova tentativa.
7. Na inicialização, runs `pending` sem operação (processo caiu entre 5 e 6) são marcados `failed: interrompido` — coerente com a recusa de reexecução automática do `railway-manager`.

- **Por que varredura** e não um timer por próximo evento: sobrevive a reinícios, a edições e a saltos de relógio sem reprogramação; o custo (cálculo de alguns dias de ocorrências por agenda a cada 30 s) é desprezível.
- **Alternativa**: crate de cron (`tokio-cron-scheduler`) — exige reprogramar jobs a cada edição, não resolve exatamente-uma-vez após reinício nem catch-up limitado; rejeitada.
- `tick(now)` recebe o horário por parâmetro: os testes avançam o relógio sem dormir (evita o problema de tempo pausado com o pool do sqlx visto na change anterior).

### 4. Execução reaproveita `PowerService`

- `PowerService::execute` ganha uma variante com origem (`OperationTrigger::Schedule`) e `schedule_id`/`schedule_name`; o manual continua idêntico.
- `requested_by = "agendador"`; o histórico mostra o nome da agenda copiado no momento (sobrevive à exclusão da agenda).
- Iniciar usa `restart_source` e as mesmas regras de skip; nenhuma regra nova de energia.

### 5. Conflitos

- **Entre agendas no mesmo instante**: no passo 4 do tick, eventos com o mesmo `at` são agrupados por instância; se houver *start* e *stop*, a instância sai do alvo do *stop* e o run de *stop* recebe `message` "conflito com agenda X: iniciar prevalece". Instantes diferentes não são conflito (cada evento age no seu horário).
- **Com operações em andamento**: tratado pelo índice único existente (item `skipped: operação em andamento`).
- **Aviso ao salvar**: a API calcula, para a semana corrente, interseções de janelas com outras agendas ativas que compartilham instâncias e devolve `warnings` (não bloqueia).
- **Janela menor que o tempo de verificação**: se *start* ainda estiver verificando quando o *stop* chegar, o item de *stop* é `skipped` (instância ocupada). A API avisa ao salvar janelas menores que `RM_START_TIMEOUT_SECS`.

### 6. Migração do SQLite (reconstrução de `operations`)

- SQLite não altera `CHECK`. A migração usa `-- no-transaction` (sqlx) e o procedimento oficial: `PRAGMA foreign_keys=OFF` → `BEGIN` → cria `operations_new` com `trigger IN ('manual','schedule')`, `schedule_id` e `schedule_name` → copia → `DROP operations` → `RENAME operations_new` → recria índices → `PRAGMA foreign_key_check` → `COMMIT` → `PRAGMA foreign_keys=ON`.
- Com FKs desligadas, o `DROP` não dispara o `CASCADE` em `operation_items` (o histórico é preservado). Um teste de migração cria dados na versão anterior e confere itens e operações depois.
- **Alternativa**: guardar a origem em coluna nova sem `CHECK` e manter `trigger = 'manual'` — evita a reconstrução, mas mente no dado; rejeitada.

### 7. API e interface

- `GET/POST /api/schedules`, `GET/PUT/DELETE /api/schedules/{id}`, `POST /api/schedules/{id}/pause|resume`, `GET /api/schedules/{id}/runs` (paginado). Respostas incluem `next_runs` (5) e `warnings`. Erros de validação `400` com `details.conflicts`.
- `GET /api/history?trigger=manual|schedule`; entradas com `schedule_name`.
- `GET /api/dashboard`: `next_action` por projeto (`{action, at, schedule_name}`).
- Frontend: item "Agendas" na navegação; lista (projeto, alvo, dias, janelas, próxima execução, ativa/pausada); editor em modal (projeto, alvo, ambiente/instâncias, fuso, dias como botões, lista de janelas com `input type=time`, adicionar/remover); detalhe com próximas e últimas execuções; filtro "Origem" no histórico; linha "Próxima: Desligar às 18:00 · Agenda X" no card do projeto.

## Risks / Trade-offs

- [Rate limit em horários de pico: muitas agendas no mesmo minuto] → o limitador existente enfileira as chamadas; 429 pausa e reenvia mutations; o editor mostra quantas instâncias cada evento afeta.
- [Relógio do servidor errado ou ajustado para trás] → `last_evaluated_at` só avança; ajuste para trás não reexecuta (unicidade); para frente, o catch-up limita o efeito.
- [Processo cai entre gravar o run e criar a operação] → run fica `pending` e vira `failed: interrompido` no início; sem reexecução (evita ações em dobro).
- [Migração de `operations` falhar no meio] → tudo dentro de uma transação explícita; falha faz rollback e o servidor não sobe (mensagem clara); backup do `.db` recomendado no README antes de atualizar.
- [DST em fusos com horário de verão] → regras explícitas na decisão 2 e testes de tabela para gap e overlap.
- [Agendador em mais de uma réplica executaria eventos em dobro] → a unicidade em `schedule_runs` já impede execução dupla no mesmo banco; múltiplas réplicas com SQLite continuam fora de escopo.

## Migration Plan

1. Atualizar o binário; na inicialização, as migrações criam as tabelas de agenda e reconstroem `operations` preservando o histórico.
2. O agendador começa sem passado (`last_evaluated_at = now` na primeira vez): nada é recuperado do período anterior à atualização.
3. Rollback: voltar ao binário anterior exige restaurar o backup do `.db` (a versão anterior não reconhece `trigger = 'schedule'`); documentado no README.

## Open Questions

- Lista de fusos exibida no editor: todos os da base IANA ou uma lista curta com os mais comuns + busca — decisão de interface, não afeta API nem regras.
