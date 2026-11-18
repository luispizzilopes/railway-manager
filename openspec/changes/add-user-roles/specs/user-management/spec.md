## Purpose

Permite que o usuário master cadastre pessoas com papéis específicos e define o que cada papel pode fazer, para uso seguro em equipe e auditoria de quem executou cada ação.

## ADDED Requirements

### Requirement: Cadastro de usuários comuns
O sistema SHALL permitir que o usuário master crie, liste, edite (papel e estado ativo/inativo), redefina a senha e remova usuários comuns. Cada usuário MUST ter nome de usuário único (sem diferenciar maiúsculas de minúsculas), senha e exatamente um papel entre `viewer`, `operator` e `admin`. Somente o master MAY acessar essas operações.

#### Scenario: Criação de usuário
- **WHEN** o master cria o usuário `maria` com papel `operator` e uma senha válida
- **THEN** o usuário passa a constar na listagem e consegue fazer login

#### Scenario: Nome duplicado
- **WHEN** o master tenta criar um usuário cujo nome já existe, ignorando maiúsculas e minúsculas
- **THEN** o sistema responde `409` e não cria o usuário

#### Scenario: Nome igual ao do master
- **WHEN** o master tenta criar um usuário com o mesmo nome do usuário master
- **THEN** o sistema responde `409` e não cria o usuário

#### Scenario: Senha fraca ou papel inválido
- **WHEN** a senha tem menos de 8 caracteres ou o papel não é um dos permitidos
- **THEN** o sistema responde `400` e não grava nada

#### Scenario: Usuário sem permissão de gestão
- **WHEN** um usuário `admin` chama qualquer operação de gestão de usuários
- **THEN** o sistema responde `403`

### Requirement: Senhas protegidas
O sistema MUST armazenar a senha de cada usuário comum apenas como hash argon2 com salt, nunca em texto claro, e MUST NOT devolver hash ou senha em nenhuma resposta da API nem registrá-los em logs.

#### Scenario: Listagem de usuários
- **WHEN** o master lista os usuários
- **THEN** a resposta contém nome, papel, estado e datas, sem qualquer campo de senha ou hash

### Requirement: Matriz de permissões por papel
O sistema SHALL aplicar no backend, em toda rota protegida, as permissões abaixo; cada papel inclui as permissões do anterior, e o master tem todas:
- `viewer`: somente consultas (dashboard, projetos, serviços, agendas, histórico e logs).
- `operator`: além de `viewer`, planejar e executar operações de ligar/desligar, atualizar o dashboard, sincronizar projetos, pausar e retomar agendas, criar e cancelar ações agendadas pontuais.
- `admin`: além de `operator`, criar, editar e remover projetos, instâncias, serviços e agendas, e gerenciar o token da Railway.
- master: além de `admin`, gerenciar usuários.

Quando o papel não basta, o sistema MUST responder `403` sem executar a ação.

#### Scenario: Viewer tenta desligar serviço
- **WHEN** um `viewer` chama `POST /api/operations`
- **THEN** o sistema responde `403` e nenhuma operação é criada

#### Scenario: Operator tenta alterar token
- **WHEN** um `operator` tenta cadastrar ou trocar o token da Railway
- **THEN** o sistema responde `403`

#### Scenario: Admin gerencia projetos
- **WHEN** um `admin` cria um projeto
- **THEN** o sistema aceita a requisição

### Requirement: Efeito imediato de mudanças
Alterar o papel, desativar, redefinir a senha ou remover um usuário MUST ter efeito nas requisições seguintes: papel novo vale de imediato e as sessões de um usuário desativado, removido ou com senha redefinida MUST deixar de ser aceitas.

#### Scenario: Usuário desativado
- **WHEN** o master desativa um usuário que está logado
- **THEN** a próxima requisição desse usuário responde `401` e novos logins são recusados

#### Scenario: Rebaixamento de papel
- **WHEN** o master muda um usuário de `operator` para `viewer`
- **THEN** a próxima tentativa dele de executar uma operação responde `403`
