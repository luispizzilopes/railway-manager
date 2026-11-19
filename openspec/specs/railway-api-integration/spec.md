# railway-api-integration Specification

## Purpose
Define o comportamento da integração com a API pública GraphQL do Railway: uso exclusivo de operações existentes e não destrutivas, timeouts, rate limit, classificação de erros e tolerância a indisponibilidade.

## Requirements

### Requirement: Uso restrito a operações verificadas
A integração SHALL usar apenas queries e mutations presentes no schema oficial do Railway e MUST ser verificável contra um snapshot versionado desse schema. O conjunto de mutations permitidas MUST se limitar às necessárias para desligar e iniciar deployments. Mutations que excluam projetos, serviços, ambientes, volumes ou variáveis MUST NOT ser utilizadas. As consultas de logs (`deploymentLogs`, `buildLogs`) e a lista de deploys recentes de uma instância SHALL ser permitidas por serem somente leitura, e MUST ser verificadas contra o snapshot como as demais queries.

#### Scenario: Operação fora da lista permitida
- **WHEN** a base de código contém uma mutation fora da lista permitida
- **THEN** o teste de verificação de operações falha

#### Scenario: Schema do Railway mudou
- **WHEN** o snapshot do schema é atualizado e um campo usado deixou de existir
- **THEN** o build ou os testes falham antes de chegar à produção

#### Scenario: Consulta de logs verificada
- **WHEN** a query de logs usa um argumento ou campo que não existe no snapshot do schema
- **THEN** o build ou os testes falham

### Requirement: Timeouts e falhas de comunicação
Toda chamada ao Railway MUST ter timeout de conexão e de requisição configuráveis. Falhas de rede, timeouts e respostas `5xx` SHALL ser classificadas como "indisponível" e repetidas com backoff exponencial e jitter apenas para consultas; mutations MUST NOT ser repetidas automaticamente quando o resultado for incerto.

#### Scenario: Timeout em consulta
- **WHEN** uma consulta excede o timeout
- **THEN** o sistema tenta novamente até o limite configurado e, persistindo a falha, retorna erro "Railway indisponível"

#### Scenario: Timeout em mutation
- **WHEN** uma mutation de desligar/iniciar excede o timeout
- **THEN** o sistema não reenvia a mutation, marca o item como "resultado incerto" e consulta o estado real antes de concluir

### Requirement: Classificação de erros GraphQL
O sistema SHALL inspecionar o array `errors` de toda resposta, inclusive com HTTP 200, e classificar o erro como autenticação/autorização, não encontrado, validação, rate limit, indisponibilidade ou erro desconhecido. Mensagens de erro do Railway MAY ser repassadas ao usuário somente após remoção de qualquer dado sensível.

#### Scenario: HTTP 200 com erro de permissão
- **WHEN** a API responde 200 contendo `errors` de autorização
- **THEN** o sistema trata como falha de autorização, não como sucesso

#### Scenario: Recurso inexistente
- **WHEN** um projeto, serviço ou deployment não é encontrado
- **THEN** o sistema retorna erro "não encontrado" referente ao recurso Railway informado

### Requirement: Respeito ao rate limit
O sistema SHALL limitar a taxa de requisições ao Railway por limite configurável (requisições por segundo), ler os cabeçalhos `X-RateLimit-Remaining`/`X-RateLimit-Reset` e, ao receber HTTP 429, MUST aguardar o tempo indicado em `Retry-After` antes de novas chamadas.

#### Scenario: HTTP 429
- **WHEN** o Railway responde 429 com `Retry-After: 30`
- **THEN** nenhuma nova requisição é enviada nos próximos 30 segundos e os itens pendentes aguardam em vez de falhar imediatamente

#### Scenario: Cota quase esgotada
- **WHEN** `X-RateLimit-Remaining` chega a zero
- **THEN** o sistema pausa novas requisições até o reset informado e expõe esse estado ao dashboard

### Requirement: Logs sem dados sensíveis
Logs estruturados das chamadas ao Railway SHALL registrar nome da operação, duração, status e identificadores de recursos, e MUST NOT registrar cabeçalhos de autorização, tokens ou corpos de resposta completos.

#### Scenario: Log de chamada
- **WHEN** qualquer chamada ao Railway é executada
- **THEN** o log contém operação, duração e resultado e não contém o token

### Requirement: Limites nas consultas de logs
As consultas de logs SHALL pedir ao Railway no máximo 1000 linhas por chamada, usar o timeout de requisição configurado e MUST NOT ser repetidas automaticamente em loop contínuo. Falhas SHALL ser classificadas como nas demais consultas (autenticação, não encontrado, rate limit, indisponível) e as mensagens do Railway MUST ser repassadas apenas depois da remoção de dados sensíveis.

#### Scenario: Rate limit em logs
- **WHEN** o Railway responde `429` a uma consulta de logs
- **THEN** o sistema aguarda o `Retry-After` antes de novas chamadas e responde ao cliente com o erro de limite atingido

#### Scenario: Deploy removido
- **WHEN** o Railway informa que o deploy não existe mais
- **THEN** o sistema responde `404` com mensagem clara, sem erro genérico
