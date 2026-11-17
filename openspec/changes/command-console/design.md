## Context

Motivação e escopo em `proposal.md`; comportamento em `specs/command-console`, `specs/scheduled-actions` e nos deltas de `service-power-control` e `power-schedules`.

Estado relevante do código:

- O frontend (React 19 + React Query + react-router, sem bibliotecas de UI) fala com o backend só por `src/api/client.ts`; todas as ações da UI já existem como chamadas tipadas ali.
- `PowerService` faz plano → execução → verificação. `PowerTarget` tem `Instance`, `Project { environment, instances }` e `Batch { projects, environment_name }`; não há como juntar instâncias de projetos diferentes em um plano só.
- `execute_as` grava a origem (`OperationTrigger::Manual | Schedule`) com `schedule_id`/`schedule_name`; `operations` tem `CHECK (trigger IN ('manual','schedule'))` e `CHECK ((trigger = 'schedule') = (schedule_name IS NOT NULL))`.
- `SchedulerService::tick(now)` roda periodicamente no `server` (`RM_SCHEDULER_TICK_SECS`), com limite de recuperação `RM_SCHEDULE_CATCHUP_SECS` e marcação de runs órfãos na inicialização.
- `PowerKind` é só `start | stop`; a spec proíbe tratar "reiniciar deployment" como iniciar, e o usuário escolheu reinício = desligar + ligar orquestrado no cliente.

## Goals / Non-Goals

**Goals:**
- Um registro único de comandos no frontend que alimenta parser, execução, autocompletar, `help` e o teste de consistência com `docs/console.md`.
- Reaproveitar a API existente; mudanças no backend restritas ao alvo `instances` e às ações agendadas.
- Comandos com efeito sempre passam pelo mesmo plano/confirmação do backend (nada de atalhos que pulem o plano).

**Non-Goals:**
- CLI fora do navegador (binário ou script) — a API continua utilizável por `curl`, mas não faz parte desta change.
- Emulação de terminal (ANSI, pipes, redirecionamento, variáveis, scripts multi-linha além de `;`).
- Reinício atômico no backend ou reinício agendado.
- Ações agendadas recorrentes (isso é a agenda) ou com alvo de estado (`--state` com `--at`).
- Sincronizar histórico de comandos e apelidos entre navegadores.

## Decisions

### 1. Console renderizado em React, sem emulador de terminal

O console é um componente com uma lista de blocos de saída (texto, tabela, plano, progresso, erro, prompt de confirmação) e um `input` de linha única. Os blocos são componentes React, o que dá tabelas reais, cores via tokens existentes, cópia de IDs com um clique e leitura por leitores de tela (`role="log"`, `aria-live="polite"`).

*Alternativa:* `xterm.js`. Rejeitada: dependência pesada, saída ANSI só texto, ruim para tabelas e acessibilidade, e não precisamos de PTY.

### 2. Registro declarativo de comandos (`src/console/`)

```
console/
  lexer.ts        tokens, aspas, `;`, `--opt=valor`
  registry.ts     CommandDef[] — fonte única
  parse.ts        tokens + registry → Invocation | ParseError (com sugestão por distância de edição)
  selectors.ts    seletores → instâncias (pura, testável)
  time.ts         --at / --in / --tz → instante UTC (pura)
  commands/*.ts   handlers por área (power, project, instance, schedule, at, credential, misc)
  output.tsx      blocos de saída
  Console.tsx     componente; ConsoleProvider no Layout para o painel global
```

`CommandDef = { name, aliases (pt-BR), group, summary, usage, args, options[{name, short?, value?, default?, repeatable?, help}], examples[], destructive?, run(ctx, inv) }`. Subcomandos são `CommandDef` filhos. O `ctx` expõe `api`, `queryClient`, `print(block)`, `confirm(texto, palavra?)`, `promptSecret()`, `signal` (abortado por `Ctrl+C`) e `navigate`. O handler devolve `ok | fail`, usado para interromper sequências `;`.

`help` e `<cmd> --help` são gerados do registro. O teste de documentação lê `docs/console.md`, extrai cada seção `### \`<comando>\`` e as opções listadas nela, e compara com o registro nos dois sentidos.

### 3. Seletores resolvidos no cliente sobre a visão geral

A resolução usa `GET /api/dashboard` (projetos → ambientes → instâncias com IDs e nomes), o mesmo dado da tela inicial, guardado no cache do React Query (`['dashboard']`). Antes de qualquer comando com efeito, o console refaz a consulta para não usar IDs velhos; o autocompletar usa o cache. Gramática:

```
seletor  := 'all' | proj [ '/' serv ] [ '@' amb ]
proj, serv, amb := nome | id | padrão com '*'
```

Correspondência sem diferenciar maiúsculas, por nome de exibição, nome Railway ou UUID. Sem curinga, nenhuma correspondência exata → erro com sugestões (prefixo e distância de edição). Depois: união → `--env` → `--state` → `--except`.

*Alternativa:* resolver seletores no backend. Rejeitada por ora: exigiria uma linguagem na API só para o console; o dashboard já tem tudo.

### 4. Novo alvo `instances` em `POST /api/operations/plan`

`{"type":"instances","instance_ids":[...]}` → `PowerTarget::Instances(Vec<ServiceInstanceId>)`, com escopo gravado `batch` (sem mudar o `CHECK` de `scope`), duplicatas removidas e IDs desconhecidos → `400` com `details.unknown`. Conflitos viram `skipped` como no lote. O console usa **sempre** esse alvo para execução imediata — um caminho só, e o plano mostra exatamente o que foi resolvido. A UI continua usando os alvos existentes.

### 5. Reinício orquestrado no cliente

```
restart sel  →  plan(stop, instances)  → confirmação única (aviso de indisponibilidade)
             →  execute → acompanha até o fim
             →  ids = itens succeeded  → plan(start, instances ids) → execute → acompanha
             →  resumo por instância
```

Entre as etapas, o console grava em `localStorage` `{ stopOperationId, instanceIds, startedAt }` e remove ao disparar a segunda etapa. Ao montar, se houver registro, consulta a operação de desligar e mostra o aviso de reinício interrompido com `start <ids> -y` pronto para executar (as instâncias são passadas por ID, que o seletor aceita). Sem `localStorage`, o aviso não existe — registrado como risco.

*Alternativa:* `deploymentRestart` no backend. Descartada pelo usuário; fica como evolução futura se o reinício pelo cliente se mostrar frágil.

### 6. Ações agendadas pontuais no backend

Modelo:

```
scheduled_actions(id, kind ('start'|'stop'), run_at, target_kind ('all'|'projects'|'instances'),
                  environment_name?, note?, status, message?, operation_id?, created_at, processed_at?)
  status ∈ pending | processing | executed | late | skipped | missed | failed | cancelled
scheduled_action_projects(action_id → CASCADE, project_id → projects CASCADE)
scheduled_action_instances(action_id → CASCADE, service_instance_id → service_instances CASCADE)
INDEX (status, run_at)
```

`processing` é interno (não aparece na spec): o `tick` reivindica cada ação com `UPDATE … SET status='processing' WHERE id=? AND status='pending'`; só quem afetou uma linha executa — isso, mais a marcação de `processing` órfão como `failed` ("interrompida por reinício") na inicialização, garante no máximo uma vez. Cancelar usa o mesmo `WHERE status='pending'`; zero linhas → `409` com a situação atual.

No `tick`, depois dos eventos das agendas: para cada ação `pending` com `run_at <= now`, se `now - run_at > catchup` → `missed`; senão resolve o alvo (todos os projetos gerenciados / projetos selecionados, filtrados por `environment_name`, ou as instâncias selecionadas ainda gerenciadas), vazio → `skipped`; sem credencial válida → `failed`; caso contrário `PowerService::plan` com alvo `instances` e `execute_scheduled_action(plan, action_id, label)`. `late` usa o mesmo critério de atraso das agendas. A descrição legível (`label`) é calculada na criação e gravada ("todos os projetos · production", "loja, blog", "3 instâncias").

API:

```
POST /api/scheduled-actions            { kind, run_at, target, note? } → 201 view
GET  /api/scheduled-actions?status=&page=&per_page=  → Page + default_timezone
GET  /api/scheduled-actions/:id
POST /api/scheduled-actions/:id/cancel → view | 409
target := {type:"all", environment_name?} | {type:"projects", project_ids, environment_name?}
        | {type:"instances", instance_ids}
```

No console, `start/stop … --at` mapeia: só `all` (com `--env` opcional) → `all` (dinâmico); só seletores de projeto inteiro → `projects`; qualquer outra coisa (serviço, curinga de serviço, `--except`) → `instances` fixas. A confirmação diz se o alvo é dinâmico ou fixo. `--state` com `--at` é recusado.

*Alternativa:* reaproveitar `schedules` com uma "agenda de um evento". Rejeitada: agendas são por projeto, recorrentes e com janelas; forçar um evento único complicaria validação, próximas execuções e a tela.

### 7. Origem `scheduled_action` nas operações

Migração `-- no-transaction` reconstruindo `operations` (mesmo procedimento da migração `20261117000002`) para: `trigger IN ('manual','schedule','scheduled_action')`, colunas `scheduled_action_id` e `scheduled_action_label`, e `CHECK ((trigger = 'scheduled_action') = (scheduled_action_label IS NOT NULL))`, mantendo o `CHECK` existente de `schedule_name`. `requested_by = "agendador"`. O histórico ganha `scheduled_action_label` no DTO e aceita `trigger=scheduled_action`.

### 8. Instante de `--at` no cliente

`time.ts` converte `HH:MM`, `AAAA-MM-DD HH:MM`, `amanhã HH:MM` e `--in 1h30m` para UTC usando `Intl.DateTimeFormat` com o fuso de `--tz` ou o `default_timezone` devolvido por `GET /api/scheduled-actions` (o mesmo fuso das agendas). Horário inexistente por DST → primeiro instante válido, como nas agendas. O backend só valida `run_at` (futuro e ≤ 30 dias).

### 9. Dados sensíveis

`credential set <tipo> [--workspace id]` abre um prompt com `input type="password"`; o valor vai direto para `api.saveCredential` e não passa pelo histórico nem pela saída. O lexer recusa `credential set` com mais argumentos posicionais do que o tipo e não grava a linha no histórico.

### 10. Atalhos e integração com a UI

`ConsoleProvider` no `Layout` mantém o painel (gaveta inferior, redimensionável) e o estado do console, compartilhado com a página `/console` para que a saída sobreviva à navegação. `Ctrl+\`` e `Ctrl+K` alternam o painel (`preventDefault`); `Esc` fecha; `Ctrl+C` sem texto selecionado interrompe o comando em andamento; `Ctrl+L` limpa. Depois de cada comando com efeito, o console invalida as mesmas chaves do React Query que a UI usa (`dashboard`, `projects`, `schedules`, `history`, `scheduled-actions`), para que as telas abertas reflitam a mudança.

## Risks / Trade-offs

- [Fechar a aba no meio de `restart` deixa serviços desligados] → aviso explícito na confirmação, registro em `localStorage` e aviso com o comando pronto ao reabrir; histórico mostra as duas operações.
- [`stop all` acidental] → confirmação digitando `tudo` quando sem `-y`; plano sempre exibido; apelidos não substituem comandos.
- [Resolução no cliente com dados desatualizados] → refetch do dashboard antes de comandos com efeito; o backend lê o estado real no plano e recusa IDs desconhecidos.
- [Ação `all` dinâmica pega projetos que o usuário não esperava] → confirmação diz "dinâmico — inclui projetos importados depois"; `at list` mostra o alvo; cancelável até o horário.
- [Ação agendada e evento de agenda no mesmo tick sobre a mesma instância] → ações processadas depois das agendas; o bloqueio de itens ativos transforma o conflito em `skipped` com "operação em andamento", visível no histórico.
- [Documentação divergir do código] → teste de consistência bidirecional registro × `docs/console.md` no `npm test`.
- [Atalho `Ctrl+K` conflitar com o navegador] → `Ctrl+\`` como principal; ambos documentados.

## Migration Plan

1. Backup do SQLite (como na change anterior); a migração de `operations` é uma reconstrução de tabela.
2. Deploy único de backend + frontend; os enums novos são aditivos e a UI atual não muda de comportamento.
3. Rollback: voltar a imagem anterior exige restaurar o backup se já houver operações com `trigger = 'scheduled_action'` (o `CHECK` antigo as recusaria); sem isso, a tabela nova é compatível com o código anterior, que ignora as colunas extras.
