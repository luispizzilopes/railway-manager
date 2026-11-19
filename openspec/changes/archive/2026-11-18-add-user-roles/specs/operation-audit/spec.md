## MODIFIED Requirements

### Requirement: Registro de operações
O sistema SHALL registrar cada operação (escopo, tipo `start`/`stop`, solicitante, criação, início, fim, resultado agregado) e cada item (projeto, serviço, ambiente, IDs Railway, estado anterior conhecido, estado desejado, estado final observado, deployment envolvido, resultado, mensagem de erro, duração). O solicitante de uma operação manual MUST ser o nome do usuário autenticado que a executou, copiado no momento da operação. O registro MUST ser persistido antes de qualquer mutation ser enviada e atualizado a cada transição.

#### Scenario: Operação concluída
- **WHEN** uma operação termina
- **THEN** existe um registro por instância com estado anterior, desejado, final, resultado e duração

#### Scenario: Falha ao persistir
- **WHEN** o registro inicial do item não pode ser gravado
- **THEN** a mutation do item não é enviada e o item falha

#### Scenario: Solicitante identificado
- **WHEN** o usuário `maria` executa uma operação de desligar
- **THEN** o histórico mostra `maria` como solicitante, mesmo que o usuário seja removido depois
