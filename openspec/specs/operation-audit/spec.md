# operation-audit Specification

## Purpose
Mantém um histórico persistente e consultável de todas as operações de controle de serviços, para auditoria e diagnóstico.

## Requirements

### Requirement: Registro de operações
O sistema SHALL registrar cada operação (escopo, tipo `start`/`stop`, solicitante, criação, início, fim, resultado agregado) e cada item (projeto, serviço, ambiente, IDs Railway, estado anterior conhecido, estado desejado, estado final observado, deployment envolvido, resultado, mensagem de erro, duração). O registro MUST ser persistido antes de qualquer mutation ser enviada e atualizado a cada transição.

#### Scenario: Operação concluída
- **WHEN** uma operação termina
- **THEN** existe um registro por instância com estado anterior, desejado, final, resultado e duração

#### Scenario: Falha ao persistir
- **WHEN** o registro inicial do item não pode ser gravado
- **THEN** a mutation do item não é enviada e o item falha

### Requirement: Preservação do histórico
O histórico MUST manter nome e IDs Railway copiados no momento da operação, permanecendo consultável mesmo após o projeto ou serviço ser removido do gerenciamento. O histórico MUST NOT conter tokens ou credenciais.

#### Scenario: Projeto removido
- **WHEN** um projeto é removido do gerenciamento
- **THEN** suas operações continuam aparecendo no histórico com os nomes da época

### Requirement: Consulta filtrada
O sistema SHALL permitir consultar o histórico com paginação e filtros combináveis por projeto, serviço, ambiente, tipo de operação, resultado e período, ordenado do mais recente para o mais antigo.

#### Scenario: Filtro combinado
- **WHEN** o administrador filtra por projeto `loja`, tipo `stop`, resultado `failed` na última semana
- **THEN** são retornados apenas os itens que satisfazem todos os filtros

#### Scenario: Período inválido
- **WHEN** a data inicial é posterior à final
- **THEN** o sistema responde `400`
