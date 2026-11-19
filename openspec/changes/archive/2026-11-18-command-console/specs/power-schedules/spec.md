## MODIFIED Requirements

### Requirement: Registro de execuções e origem
Cada evento processado SHALL gerar um registro de execução com agenda, ação, horário previsto, horário real, situação (`executed`, `late`, `skipped`, `missed`, `failed`) e, quando houver, a operação criada. Operações criadas pelo agendador a partir de agendas MUST registrar a origem `schedule` e a agenda que as disparou; operações criadas a partir de ações agendadas pontuais MUST registrar a origem `scheduled_action` e a ação que as disparou. O histórico SHALL permitir filtrar por origem (`manual`, `schedule` ou `scheduled_action`) e SHALL exibir o nome da agenda ou a descrição da ação agendada de origem. A exclusão de uma agenda MUST preservar as operações já criadas por ela.

#### Scenario: Filtro por origem
- **WHEN** o administrador filtra o histórico pela origem `schedule`
- **THEN** apenas itens de operações disparadas por agendas são retornados, com o nome da agenda

#### Scenario: Filtro por ação agendada
- **WHEN** o administrador filtra o histórico pela origem `scheduled_action`
- **THEN** apenas itens de operações disparadas por ações agendadas pontuais são retornados, com a descrição da ação

#### Scenario: Agenda sem token válido
- **WHEN** um evento ocorre sem credencial configurada ou com credencial inválida
- **THEN** a execução é registrada como `failed` com o motivo e nada é enviado ao Railway
