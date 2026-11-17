## 1. Backend: alvo `instances`

- [x] 1.1 Adicionar `PowerTarget::Instances(Vec<ServiceInstanceId>)` ao `PowerService::plan` (escopo `batch`, duplicatas removidas, conflitos como `skipped`, IDs desconhecidos/não gerenciados → erro de validação com a lista); verificar com testes de aplicação com `FakeRailway` cobrindo duas instâncias de projetos diferentes num plano só, duplicata e ID desconhecido
- [x] 1.2 Aceitar `{"type":"instances","instance_ids":[...]}` em `POST /api/operations/plan` com `400` e `details.unknown`; verificar com teste HTTP dos cenários "Instâncias de projetos diferentes" e "Instância desconhecida no conjunto"

## 2. Backend: domínio e persistência das ações agendadas

- [x] 2.1 Modelar `ScheduledAction`, `ScheduledActionTarget` (`All`/`Projects`/`Instances` + `environment_name`), `ScheduledActionStatus` e a geração do rótulo legível no `domain`; adicionar `OperationTrigger::ScheduledAction` e os campos `scheduled_action_id`/`scheduled_action_label` em `Operation`; verificar com testes unitários de validação (passado, > 30 dias, alvo vazio), de rótulo e roundtrip dos enums
- [x] 2.2 Criar migração com `scheduled_actions`, `scheduled_action_projects`, `scheduled_action_instances` e índice `(status, run_at)`; verificar com teste de migração em banco novo e de cascatas (remover projeto/instância os retira do alvo)
- [x] 2.3 Criar migração `-- no-transaction` que reconstrói `operations` aceitando `trigger = 'scheduled_action'` com as colunas novas e o `CHECK` de rótulo; verificar com teste que aplica a migração sobre banco com operações `manual` e `schedule` e itens, conferindo que nada foi apagado e `PRAGMA foreign_key_check` está limpo
- [x] 2.4 Implementar `ScheduledActionRepository` (criar, obter, listar paginado com filtro e ordenação da spec, reivindicar `pending → processing` condicional, finalizar, cancelar condicional, `processing` órfão → `failed` na inicialização); verificar com testes em SQLite em memória, incluindo reivindicação concorrente (só uma vence) e cancelar não-pendente
- [x] 2.5 Gravar/ler a origem `scheduled_action` nas operações e aceitar `trigger=scheduled_action` no filtro do histórico, com `scheduled_action_label` no DTO; verificar com teste de repositório do filtro

## 3. Backend: casos de uso, agendador e API

- [x] 3.1 `ScheduledActionService`: criar (valida projetos/instâncias gerenciados, calcula rótulo), listar, obter e cancelar; verificar com testes de aplicação dos cenários de criação e cancelamento da spec
- [x] 3.2 `PowerService::execute_scheduled_action` (origem, `requested_by = "agendador"`); verificar com teste que a operação gravada tem origem, ID e rótulo
- [x] 3.3 Estender `SchedulerService::tick` para processar ações vencidas depois das agendas: `missed` acima do limite, resolução do alvo na hora (dinâmico para `all`), `skipped` sem instâncias, `failed` sem credencial, `executed`/`late`; verificar com `FakeRailway` e relógio por parâmetro cobrindo: no horário, projeto importado depois, alvo vazio, sem credencial, volta dentro/fora do limite, sem duplicação após "reinício" e conflito com evento de agenda no mesmo tick
- [x] 3.4 Marcar ações `processing` órfãs como `failed` ao subir o `server`; verificar com teste de inicialização
- [x] 3.5 Rotas `/api/scheduled-actions` (POST, GET lista com `default_timezone`, GET por ID, POST cancel com `409`); verificar com testes HTTP

## 4. Frontend: núcleo do console

- [x] 4.1 Tipos e cliente para alvo `instances`, ações agendadas e `trigger`/`scheduled_action_label` no histórico; verificar com `npm run typecheck`
- [x] 4.2 `lexer.ts` e `parse.ts` com registro declarativo (`registry.ts`), nomes em português, `--opt=valor`, `-y`, aspas, `;`, erros antes de chamar a API e sugestão por distância de edição; verificar com testes unitários (`desligar` = `stop`, `stp` sugere `stop`, opção desconhecida, argumento ausente)
- [x] 4.3 `selectors.ts` (`all`, `proj`, `proj@amb`, `proj/serv`, `proj/serv@amb`, IDs, `*`, `--env`, `--state`, `--except`, união sem repetição, erros com sugestões); verificar com testes de tabela sobre um fixture de dashboard incluindo os cenários da spec
- [x] 4.4 `time.ts` (`HH:MM` hoje/amanhã, `AAAA-MM-DD HH:MM`, `amanhã HH:MM`, `--in 30m|2h|1h30m`, `--tz`, DST, descrição relativa); verificar com testes com relógio fixo em `America/Sao_Paulo` e `America/New_York`
- [x] 4.5 Componente `Console` com blocos de saída (texto, tabela, plano, progresso, erro, confirmação com palavra, prompt mascarado), `role="log"`, cópia de IDs, `--json` global e `clear`; verificar com testes de componente
- [x] 4.6 Histórico de comandos (200, ↑/↓, `Ctrl+R`, tolerante a `localStorage` indisponível, sem linhas de credencial) e autocompletar por `Tab` a partir do registro e do cache; verificar com testes de componente ("Completar projeto" e armazenamento que lança exceção)
- [x] 4.7 `ConsoleProvider` no `Layout`, página `/console`, item de navegação, atalhos `Ctrl+\``/`Ctrl+K`/`Esc`/`Ctrl+C`/`Ctrl+L`, invalidação das chaves do React Query após comandos com efeito; verificar com teste de componente "Abrir pelo atalho" e de `401` voltando ao login

## 5. Frontend: comandos

- [x] 5.1 `start`/`stop`: plano com alvo `instances`, tabela e totais, confirmação, `--dry-run`, `-y`, "nada a executar", plano expirado, palavra `tudo` para `all`, acompanhamento com `--no-wait` e `Ctrl+C` sem cancelar, código de falha para `failed`/`partially_failed`; verificar com testes de comando com API simulada cobrindo os cenários das specs "Ligar e desligar…" e "Ligar e desligar tudo"
- [x] 5.2 `restart`: duas etapas, confirmação única com aviso, só religa `succeeded`, resumo por instância, registro em `localStorage` e aviso de reinício interrompido ao montar, recusa de `--at`/`--in`; verificar com testes dos quatro cenários da spec
- [x] 5.3 `start`/`stop --at|--in|--tz` e `at list|show|cancel [--all]`: mapeamento do alvo (dinâmico/projetos/instâncias fixas), recusa de `--state`, confirmação com instante e contagem; verificar com testes dos cenários "Desligar tudo às 18h", "Horário já passou" e "Cancelar"
- [x] 5.4 `status`, `refresh`, `ops`, `op <id>`, `history` (todos os filtros da tela, incluindo origem) e `open`; verificar com testes de comando
- [x] 5.5 `project list|discover|import [--all]|add|show|edit|sync|rm`, `instance list|discover|import|add|rm`, `service rm` com confirmação de remoção; verificar com testes de comando ("Importar todos os projetos descobertos", "Remoção pede confirmação")
- [x] 5.6 `schedule list|show|create|edit|pause|resume|rm|runs` com `--days` (`seg-sex`, `seg,qua,sex`, `todos`, `fds`), `--window` repetível, `--tz`, `--instances`, exibindo próximas execuções, avisos e `details.conflicts`; verificar com testes ("Criar agenda recorrente", "Agenda inválida")
- [x] 5.7 `credential show|set|rm` com prompt mascarado e recusa de token na linha, `logout`, `alias`/`unalias` (sem sobrepor comandos), `help`/`ajuda` e `<cmd> --help` gerados do registro; verificar com testes ("Token como argumento", "Apelido para fim de expediente", "Ajuda de um comando")

## 6. Frontend: UI das ações agendadas e histórico

- [x] 6.1 Seção "Ações agendadas" na página de Agendas com pendentes (tipo, alvo, instante, observação) e botão de cancelar; verificar com teste de componente do cenário da spec
- [x] 6.2 Origem "Ação agendada" no filtro e na lista do Histórico, com o rótulo da ação; verificar com teste de componente

## 7. Documentação e verificação final

- [x] 7.1 Escrever `docs/console.md` (sintaxe, seletores, todos os comandos e opções com padrões, confirmação, `stop all`/`start all`, reinício e seus limites, agendamento, apelidos, atalhos, saída `--json`, receitas como "desligar tudo no fim do dia" e "religar tudo de manhã"); verificar lendo o documento contra o registro
- [x] 7.2 Teste de consistência bidirecional registro × `docs/console.md` (comandos e opções); verificar que passa e que falha ao remover um comando da doc
- [x] 7.3 Atualizar README (console, ações agendadas, backup antes de atualizar) e escrever ADR-007 (console no cliente, reinício orquestrado, ações agendadas pontuais); verificar presença e links em `docs/adr/README.md`
- [x] 7.4 Executar `scripts/check.sh` (backend e frontend); verificar que tudo passa
- [ ] 7.5 Validação manual com projeto descartável: `stop all --dry-run`, `stop all`, `start all`, `restart` de uma instância, `stop <proj> --in 2m` observando a execução e o histórico com origem `scheduled_action`, e recarregar a página no meio de um `restart` para ver o aviso; registrar o resultado
