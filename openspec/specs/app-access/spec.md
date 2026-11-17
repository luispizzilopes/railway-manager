# app-access Specification

## Purpose
Garante que apenas o administrador autenticado consiga usar a interface e a API do Railway Manager, já que a aplicação detém um token capaz de desligar infraestrutura.

## Requirements

### Requirement: Autenticação obrigatória
O sistema SHALL exigir autenticação de administrador para todos os endpoints da API, exceto login, logout e health check. A senha de administrador MUST ser configurada pelo ambiente de execução e o sistema MUST recusar iniciar se ela não estiver configurada.

#### Scenario: Requisição sem sessão
- **WHEN** um cliente chama qualquer endpoint protegido sem sessão válida
- **THEN** o sistema responde `401` sem revelar dados de projetos, serviços ou credenciais

#### Scenario: Inicialização sem senha configurada
- **WHEN** o processo inicia sem senha de administrador configurada
- **THEN** o processo encerra com erro explicando a variável ausente, sem expor a API

### Requirement: Sessão segura
O sistema SHALL emitir, após login bem-sucedido, um cookie de sessão `HttpOnly`, `SameSite=Strict` e `Secure` quando servido via HTTPS, com expiração configurável. O logout MUST invalidar a sessão.

#### Scenario: Login válido
- **WHEN** o administrador envia a senha correta
- **THEN** o sistema cria a sessão e o frontend passa a acessar endpoints protegidos

#### Scenario: Senha incorreta
- **WHEN** a senha enviada está incorreta
- **THEN** o sistema responde `401` com mensagem genérica e registra a tentativa sem logar a senha

#### Scenario: Excesso de tentativas
- **WHEN** ocorrem mais tentativas de login falhas do que o limite configurado dentro da janela
- **THEN** o sistema responde `429` até o fim da janela

#### Scenario: Logout
- **WHEN** o administrador faz logout
- **THEN** a sessão deixa de ser aceita em requisições seguintes
