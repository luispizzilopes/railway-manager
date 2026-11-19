## MODIFIED Requirements

### Requirement: Escopos de operação
O sistema SHALL suportar operações sobre (a) uma instância, (b) instâncias selecionadas de um projeto ou todas as instâncias gerenciadas do projeto, opcionalmente filtradas por ambiente, (c) instâncias de vários projetos selecionados, opcionalmente filtradas por nome de ambiente, e (d) um conjunto arbitrário de instâncias gerenciadas de um ou mais projetos, em uma única operação. No escopo (d), instâncias repetidas MUST ser consideradas uma única vez e instâncias inexistentes ou não gerenciadas MUST fazer o plano ser recusado com `400`, listando-as. O resultado MUST ser reportado individualmente por instância.

#### Scenario: Todas as instâncias de um projeto
- **WHEN** o administrador desliga o projeto `loja` no ambiente `staging`
- **THEN** todas as instâncias gerenciadas de `loja` em `staging` são processadas e cada uma tem resultado próprio

#### Scenario: Lote multi-projeto
- **WHEN** o administrador seleciona os projetos `loja` e `blog` e escolhe iniciar
- **THEN** as instâncias gerenciadas de ambos são processadas e o resultado é agrupado por projeto

#### Scenario: Instâncias de projetos diferentes
- **WHEN** o administrador desliga as instâncias `loja/api@production` e `blog/worker@production` em uma única solicitação
- **THEN** é gerado um único plano e uma única operação com as duas instâncias, cada uma com resultado próprio

#### Scenario: Instância desconhecida no conjunto
- **WHEN** o conjunto de instâncias inclui um identificador que não é de uma instância gerenciada
- **THEN** o sistema responde `400` listando o identificador e nenhum plano é criado
