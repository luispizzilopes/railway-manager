# ADR-007: Console de comandos no cliente e ações agendadas pontuais

- **Status:** aceito
- **Data:** 2026-11-17
- **Relacionado:** change `command-console` (`design.md`), specs `command-console`,
  `scheduled-actions`, `service-power-control`, `power-schedules`; ADR-004, ADR-006

## Contexto

Ligar e desligar pela interface exige navegar e selecionar projetos e instâncias. O pedido
é um console que faça tudo o que a interface faz, com recursos extras: desligar ou ligar
tudo de uma vez, reiniciar, agendar desligamentos pontuais, curingas e exclusões. As
restrições são as de sempre: toda ação passa pelo plano do servidor (ADR-004), o agendador
é por varredura com exatamente-uma-vez no banco (ADR-006), e o projeto não usa bibliotecas
de UI.

## Decisão

1. **Console renderizado em React, no cliente.** É um registro declarativo de comandos
   (`frontend/src/features/console/commands`), a fonte única para o parser, a execução, o autocompletar,
   o `help` e a referência em `docs/console.md`. Um teste compara o registro e o documento
   nos dois sentidos.
2. **Seletores resolvidos no cliente** sobre `GET /api/dashboard`, relida antes de cada
   comando com efeito. A execução imediata usa sempre o novo alvo `instances` de
   `POST /api/operations/plan`, que gera uma operação só para instâncias de vários projetos
   (escopo `batch`, IDs desconhecidos → `400` com `details.unknown`).
3. **Reinício orquestrado no cliente**: um plano e uma operação de desligar e, depois que
   ela termina, um plano e uma operação de iniciar para os itens `succeeded`. Entre as
   etapas, um registro em `localStorage` permite avisar sobre o reinício interrompido ao
   reabrir.
4. **Ações agendadas pontuais no backend** (`scheduled_actions`, `/api/scheduled-actions`):
   tipo, instante e alvo (`all` dinâmico, `projects` ou `instances`) resolvido na hora.
   O mesmo `SchedulerService::tick` as processa depois dos eventos das agendas. Cada ação
   é reivindicada com `UPDATE … WHERE status = 'pending'` (no máximo uma vez), e uma
   reivindicação órfã vira `failed` ao subir. O limite de recuperação é o mesmo das agendas.
   As operações registram a origem `scheduled_action`.

## Alternativas consideradas

- **xterm.js / emulador de terminal**: dependência pesada, saída só em texto ANSI, ruim
  para tabelas e para leitores de tela. Não precisamos de PTY.
- **CLI fora do navegador**: exigiria autenticação e distribuição próprias. A API continua
  utilizável por `curl`, mas o pedido era um console no frontend.
- **Seletores no backend**: criaria uma linguagem na API só para o console. A visão geral
  já tem os dados necessários.
- **`deploymentRestart` no backend**: reinício atômico e agendável, mas exigiria liberar
  uma nova mutation e um novo tipo de operação. Descartado nesta versão por decisão do
  usuário, e possível como evolução.
- **Ação pontual como "agenda de um evento"**: agendas são por projeto, recorrentes e com
  janelas. Forçar um evento único complicaria a validação, as próximas execuções e a tela.

## Consequências

- `stop all`/`start all` viram uma operação única, com confirmação reforçada (digitar `tudo`).
- Fechar a aba no meio de um `restart` deixa instâncias desligadas. Isso é mitigado pelo
  aviso e pelo comando pronto ao reabrir, e as duas operações ficam visíveis no histórico.
- Uma ação `all` dinâmica pode incluir projetos importados depois da criação. A
  confirmação e o `at list` deixam isso explícito, e a ação é cancelável até o horário.
- A migração reconstrói `operations` mais uma vez. Voltar de versão depois de uma ação
  agendada executada exige restaurar o backup.
- Verificação: testes de domínio, repositório, agendador e HTTP no backend; testes de
  parser, seletores, tempo, comandos, componente e documentação no frontend.
