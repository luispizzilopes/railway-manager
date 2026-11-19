# app-access Specification

## Purpose
Garante que apenas o administrador autenticado consiga usar a interface e a API do Railway Manager, já que a aplicação detém um token capaz de desligar infraestrutura.

## Requirements

### Requirement: Autenticação obrigatória
O sistema SHALL exigir autenticação para todos os endpoints da API, exceto login, logout e health check. O usuário master MUST ser configurado pelo ambiente de execução (nome e senha) e o sistema MUST recusar iniciar se o nome ou a senha não estiverem configurados. Os demais usuários são cadastrados no banco de dados conforme a capability `user-management`.

#### Scenario: Requisição sem sessão
- **WHEN** um cliente chama qualquer endpoint protegido sem sessão válida
- **THEN** o sistema responde `401` sem revelar dados de projetos, serviços ou credenciais

#### Scenario: Inicialização sem senha configurada
- **WHEN** o processo inicia sem senha do master configurada
- **THEN** o processo encerra com erro explicando a variável ausente, sem expor a API

#### Scenario: Inicialização sem nome do master
- **WHEN** o processo inicia sem `RM_ADMIN_USERNAME` configurada ou com valor vazio
- **THEN** o processo encerra com erro explicando a variável ausente, sem expor a API

### Requirement: Sessão segura
O sistema SHALL emitir, após login bem-sucedido com nome de usuário e senha, um cookie de sessão `HttpOnly`, `SameSite=Strict` e `Secure` quando servido via HTTPS, com expiração configurável, associado ao usuário que fez login. O login MUST aceitar tanto o master (comparando com nome e senha do ambiente) quanto usuários ativos do banco, e a mensagem de erro MUST ser genérica e idêntica para usuário inexistente, inativo ou senha incorreta. O logout MUST invalidar a sessão.

#### Scenario: Login válido
- **WHEN** o cliente envia o nome e a senha do master definidos no ambiente
- **THEN** o sistema cria a sessão com todas as permissões e o frontend passa a acessar endpoints protegidos

#### Scenario: Login de usuário comum
- **WHEN** um usuário ativo cadastrado envia nome e senha corretos
- **THEN** o sistema cria a sessão com o papel desse usuário

#### Scenario: Senha incorreta
- **WHEN** o nome não existe, o usuário está inativo ou a senha está incorreta
- **THEN** o sistema responde `401` com a mesma mensagem genérica nos três casos e registra a tentativa sem logar a senha

#### Scenario: Excesso de tentativas
- **WHEN** ocorrem mais tentativas de login falhas para um mesmo nome de usuário do que o limite configurado dentro da janela
- **THEN** o sistema responde `429` para novas tentativas desse nome até o fim da janela

#### Scenario: Consulta da sessão
- **WHEN** um cliente autenticado consulta `GET /api/session`
- **THEN** a resposta informa o nome de usuário e o papel (`master`, `admin`, `operator` ou `viewer`)

#### Scenario: Logout
- **WHEN** o usuário faz logout
- **THEN** a sessão deixa de ser aceita em requisições seguintes
