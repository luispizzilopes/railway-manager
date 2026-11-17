# project-management Specification

## Purpose
Permite manter localmente um conjunto de projetos Railway gerenciados — por cadastro manual ou importação a partir da conta — sem jamais criar ou excluir projetos no Railway.

## Requirements

### Requirement: Dados do projeto gerenciado
Cada projeto gerenciado SHALL possuir identificador interno, Railway Project ID único, nome, descrição opcional, data de cadastro, data da última sincronização e estado da sincronização (`never`, `ok`, `failed`, `not_found`).

#### Scenario: Projeto recém cadastrado
- **WHEN** um projeto é cadastrado
- **THEN** ele possui identificador interno, data de cadastro e estado de sincronização `never` até a primeira sincronização

### Requirement: Cadastro manual
O sistema SHALL permitir cadastrar um projeto informando seu Railway Project ID. O ID MUST ser validado quanto ao formato e confirmado na API; nome e descrição são obtidos do Railway, podendo o nome local ser sobrescrito.

#### Scenario: ID válido e acessível
- **WHEN** o administrador informa um Railway Project ID acessível pelo token
- **THEN** o projeto é cadastrado com o nome retornado pelo Railway e sincronizado

#### Scenario: ID duplicado
- **WHEN** o Railway Project ID já está cadastrado
- **THEN** o sistema responde `409` sem criar duplicata

#### Scenario: ID inacessível
- **WHEN** o Railway não encontra o projeto ou o token não tem acesso
- **THEN** o sistema responde com erro e não cadastra

### Requirement: Descoberta e importação
O sistema SHALL listar os projetos acessíveis pelo token (todas as páginas), indicando quais já são gerenciados, e permitir importar um ou vários de uma vez. Projetos excluídos no Railway MUST NOT ser listados.

#### Scenario: Listagem com token de conta
- **WHEN** o administrador abre a descoberta com token de conta
- **THEN** são exibidos os projetos de todos os workspaces do usuário, agrupados por workspace

#### Scenario: Importação múltipla
- **WHEN** o administrador seleciona três projetos e confirma a importação
- **THEN** os três são cadastrados; os já existentes são ignorados e reportados como tal

### Requirement: Edição local
O sistema SHALL permitir editar nome de exibição e descrição locais sem alterar nada no Railway. O Railway Project ID MUST NOT ser editável.

#### Scenario: Edição de descrição
- **WHEN** o administrador altera a descrição
- **THEN** apenas o registro local muda e nenhuma mutation é enviada ao Railway

### Requirement: Remoção do gerenciamento
O sistema SHALL permitir remover um projeto do gerenciamento, apagando ambientes, serviços e instâncias locais associados, mas preservando o histórico de operações. A remoção MUST NOT executar qualquer ação no Railway e MUST ser recusada enquanto houver operação em andamento no projeto.

#### Scenario: Remoção simples
- **WHEN** o administrador confirma a remoção de um projeto sem operações em andamento
- **THEN** o projeto some da lista local, o projeto continua intacto no Railway e o histórico permanece consultável

#### Scenario: Remoção com operação em andamento
- **WHEN** existe operação em andamento envolvendo o projeto
- **THEN** o sistema responde `409` e não remove

### Requirement: Sincronização
O sistema SHALL sincronizar um projeto sob demanda, atualizando nome, descrição, ambientes, serviços e estado das instâncias gerenciadas, e registrando data e resultado da sincronização.

#### Scenario: Sincronização bem-sucedida
- **WHEN** a sincronização conclui
- **THEN** `last_synced_at` é atualizado e o estado vira `ok`

#### Scenario: Projeto excluído no Railway
- **WHEN** o Railway informa que o projeto não existe mais
- **THEN** o estado vira `not_found`, os dados locais são mantidos e o dashboard sinaliza o problema
