# ADR-006: Agendador por varredura com exatamente-uma-vez no banco

- **Status:** aceito
- **Data:** 2026-11-17
- **Relacionado:** `openspec/changes/power-schedules/design.md`, spec `power-schedules`, ADR-004

## Contexto

Agendas ligam e desligam serviços em janelas por dia da semana e fuso. Cada evento precisa
rodar no horário, no máximo uma vez, sobreviver a reinícios e edições, e recuperar de forma
limitada eventos perdidos enquanto o servidor estava fora do ar.

## Decisão

- **Modelo**: janelas (`HH:MM`–`HH:MM`) + dias da semana + fuso IANA, não expressões cron.
  As regras (ocorrências, sobreposição, horário de verão, próximas execuções) são funções
  puras em `domain::schedule`, com `chrono-tz`.
- **Varredura**: um laço a cada `RM_SCHEDULER_TICK_SECS` chama
  `SchedulerService::tick(now)`, que calcula os eventos no intervalo
  `(max(última avaliação, vigência da agenda), now]`. Só o instante mais recente de cada
  agenda executa, e só se estiver dentro de `RM_SCHEDULE_CATCHUP_SECS`; os demais viram
  `missed`. Edição e retomada movem a vigência para "agora".
- **Exatamente-uma-vez**: `schedule_runs` tem `UNIQUE (schedule_id, scheduled_for, action)`.
  O registro dos eventos e o avanço de `last_evaluated_at` acontecem numa transação; um
  evento já registrado é ignorado. Registros `pending` deixados por uma queda viram
  `failed` na inicialização e não são reexecutados.
- **Execução**: cada evento vira um plano e uma operação pelo `PowerService` (escopo
  `project`, origem `schedule`), herdando todas as regras de ADR-004. No mesmo instante,
  iniciar prevalece sobre desligar para a mesma instância.
- **Migração**: `operations` é reconstruída (procedimento oficial do SQLite, com chaves
  estrangeiras desligadas) para aceitar `trigger = 'schedule'`, `schedule_id` e
  `schedule_name`.

## Alternativas consideradas

- **Timer por evento / crate de cron** — exige reprogramar a cada edição e não resolve
  exatamente-uma-vez após reinício nem recuperação limitada.
- **Impor o estado da janela continuamente** — desfaria ações manuais; descartado a
  pedido (o agendador age só nos horários).

## Consequências

- `tick(now)` recebe o horário: os testes simulam dias inteiros sem esperar nem depender
  do relógio pausado do tokio.
- Precisão de até um ciclo (30 s por padrão) em relação ao horário exato.
- Voltar à versão anterior exige restaurar o backup do banco (ver README).
