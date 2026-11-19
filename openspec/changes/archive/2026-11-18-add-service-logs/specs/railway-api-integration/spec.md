## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Limites nas consultas de logs
As consultas de logs SHALL pedir ao Railway no máximo 1000 linhas por chamada, usar o timeout de requisição configurado e MUST NOT ser repetidas automaticamente em loop contínuo. Falhas SHALL ser classificadas como nas demais consultas (autenticação, não encontrado, rate limit, indisponível) e as mensagens do Railway MUST ser repassadas apenas depois da remoção de dados sensíveis.

#### Scenario: Rate limit em logs
- **WHEN** o Railway responde `429` a uma consulta de logs
- **THEN** o sistema aguarda o `Retry-After` antes de novas chamadas e responde ao cliente com o erro de limite atingido

#### Scenario: Deploy removido
- **WHEN** o Railway informa que o deploy não existe mais
- **THEN** o sistema responde `404` com mensagem clara, sem erro genérico
