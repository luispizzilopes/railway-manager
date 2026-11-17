# railway-credentials Specification

## Purpose
Permite cadastrar, validar, substituir e remover o token de acesso à API do Railway, mantendo-o cifrado em repouso e nunca expondo seu valor após o cadastro.

## Requirements

### Requirement: Cadastro e validação de token
O sistema SHALL permitir cadastrar um token Railway do tipo *account* ou *workspace* e MUST validá-lo contra a API antes de persistir. Para token de workspace, o identificador do workspace MUST ser informado. Tokens de projeto (cabeçalho `Project-Access-Token`) SHALL ser rejeitados nesta versão, pois são limitados a um único ambiente e não permitem listar projetos.

#### Scenario: Token de conta válido
- **WHEN** o administrador cadastra um token de conta aceito pela API (consulta `me`)
- **THEN** o sistema persiste o token cifrado e responde com tipo, nome/e-mail ou workspace associado, data de cadastro e os 4 últimos caracteres mascarados

#### Scenario: Token de workspace válido
- **WHEN** o administrador cadastra um token de workspace com o ID do workspace e a consulta `workspace(workspaceId)` é aceita
- **THEN** o sistema persiste o token cifrado com o workspace associado

#### Scenario: Token inválido
- **WHEN** a API do Railway retorna erro de autenticação ou autorização
- **THEN** o sistema não persiste nada e responde `422` com mensagem indicando token inválido ou sem permissão

#### Scenario: Railway indisponível durante validação
- **WHEN** a validação falha por timeout ou erro de rede
- **THEN** o sistema não persiste o token e responde `503` indicando que a validação não pôde ser concluída

### Requirement: Não exposição do token
O token MUST NOT aparecer em nenhuma resposta da API, log, mensagem de erro, registro de auditoria ou payload enviado ao frontend após o cadastro. O token MUST ser armazenado cifrado com chave mestra fornecida pelo ambiente de execução.

#### Scenario: Consulta da credencial
- **WHEN** o frontend consulta a credencial configurada
- **THEN** a resposta contém apenas metadados (tipo, escopo, máscara, datas, último resultado de validação), nunca o valor

#### Scenario: Banco de dados exposto
- **WHEN** alguém lê o arquivo SQLite sem a chave mestra
- **THEN** o token não é recuperável em texto claro

#### Scenario: Chave mestra ausente ou incorreta
- **WHEN** o processo inicia sem chave mestra, ou com uma chave que não decifra o token armazenado
- **THEN** o sistema inicia sem integração ativa, sinaliza a credencial como "indecifrável" e exige novo cadastro, sem apagar automaticamente o dado

### Requirement: Substituição e remoção
O sistema SHALL permitir substituir o token (com nova validação) e removê-lo. Após a remoção, operações que dependem do Railway MUST falhar com erro explícito de "integração não configurada", preservando projetos, serviços e histórico locais.

#### Scenario: Substituição
- **WHEN** o administrador envia um novo token válido
- **THEN** o novo token passa a ser usado em todas as chamadas seguintes e o anterior é descartado

#### Scenario: Remoção
- **WHEN** o administrador remove o token
- **THEN** o valor cifrado é apagado e chamadas ao Railway respondem `409` "integração não configurada"

### Requirement: Revalidação em caso de falha de autenticação
Quando uma chamada ao Railway falhar por autenticação/autorização, o sistema SHALL marcar a credencial como inválida e expor esse estado ao dashboard.

#### Scenario: Token revogado no Railway
- **WHEN** uma sincronização recebe erro de autenticação
- **THEN** a credencial passa a "inválida", a operação falha com essa causa e o dashboard exibe o alerta
