## Purpose

Permite desligar e iniciar instâncias de serviço Railway — individualmente, por projeto ou em lote entre projetos — de forma segura, idempotente, auditável e verificada contra o estado real no Railway.

## ADDED Requirements

### Requirement: Semântica de desligar e iniciar
*Desligar* uma instância SHALL significar interromper todos os seus deployments ativos, sem excluir serviço, volumes, variáveis ou configuração. *Iniciar* uma instância parada SHALL significar criar um novo deployment a partir do deployment parado mais recente, reutilizando a mesma imagem já construída. Reiniciar um deployment em execução MUST NOT ser tratado como iniciar. Se nenhum deployment anterior puder ser reaproveitado (por exemplo, imagem fora da política de retenção), o início MUST falhar com o motivo explícito, sem disparar um novo build automaticamente.

#### Scenario: Desligar instância em execução
- **WHEN** o administrador desliga uma instância `running`
- **THEN** todos os deployments ativos dela são interrompidos e os volumes anexados permanecem intactos

#### Scenario: Iniciar instância parada
- **WHEN** o administrador inicia uma instância `stopped` cujo último deployment pode ser reaproveitado
- **THEN** um novo deployment é criado com a imagem anterior, sem rebuild

#### Scenario: Nada reaproveitável
- **WHEN** a instância está parada e nenhum deployment anterior pode ser reaproveitado
- **THEN** o item falha com "sem deployment reaproveitável — é necessário um novo deploy pelo Railway" e nada é disparado

### Requirement: Idempotência e pré-condições
Antes de agir, o sistema MUST consultar o estado atual no Railway. Instâncias já no estado desejado SHALL ser marcadas como `skipped` sem chamar mutations. Instâncias em `transitioning` ou `awaiting_approval` SHALL ser `skipped` com o motivo. Instâncias `sleeping` SHALL ser consideradas ligadas: iniciar é `skipped` e desligar interrompe o deployment.

#### Scenario: Já desligada
- **WHEN** o desligamento é solicitado para uma instância já `stopped`
- **THEN** o item é `skipped` com motivo "já está no estado desejado" e nenhuma mutation é enviada

#### Scenario: Em transição
- **WHEN** a instância está `DEPLOYING`
- **THEN** o item é `skipped` com motivo "em transição" e nenhuma mutation é enviada

#### Scenario: Estado desatualizado na tela
- **WHEN** a tela mostrava `running` mas o Railway informa `stopped` no momento da execução
- **THEN** o sistema usa o estado do Railway e marca o item como `skipped`

### Requirement: Escopos de operação
O sistema SHALL suportar operações sobre (a) uma instância, (b) instâncias selecionadas de um projeto ou todas as instâncias gerenciadas do projeto, opcionalmente filtradas por ambiente, e (c) instâncias de vários projetos selecionados. O resultado MUST ser reportado individualmente por instância.

#### Scenario: Todas as instâncias de um projeto
- **WHEN** o administrador desliga o projeto `loja` no ambiente `staging`
- **THEN** todas as instâncias gerenciadas de `loja` em `staging` são processadas e cada uma tem resultado próprio

#### Scenario: Lote multi-projeto
- **WHEN** o administrador seleciona os projetos `loja` e `blog` e escolhe iniciar
- **THEN** as instâncias gerenciadas de ambos são processadas e o resultado é agrupado por projeto

### Requirement: Plano e confirmação
Operações sobre mais de uma instância MUST ser precedidas de um plano que liste cada instância afetada, seu estado atual e a ação prevista (`will_stop`, `will_start`, `will_skip` com motivo). A execução MUST referenciar um plano confirmado e não expirado; um plano SHALL ser executável uma única vez.

#### Scenario: Execução sem plano
- **WHEN** uma operação em lote é enviada sem referência a um plano confirmado
- **THEN** o sistema responde `400` e nada é executado

#### Scenario: Plano expirado
- **WHEN** o plano é confirmado após o prazo de validade
- **THEN** o sistema responde `410` e exige um novo plano

#### Scenario: Plano reutilizado
- **WHEN** o mesmo plano é enviado para execução pela segunda vez
- **THEN** o sistema responde `409` e retorna a operação já criada

### Requirement: Isolamento de falhas
Falha em uma instância MUST NOT interromper o processamento das demais. Ao final, a operação SHALL ter resultado agregado `succeeded`, `partially_failed` ou `failed`.

#### Scenario: Uma falha em cinco
- **WHEN** uma das cinco instâncias retorna erro do Railway
- **THEN** as outras quatro são processadas normalmente e a operação termina `partially_failed`

### Requirement: Concorrência e conflitos
O processamento SHALL respeitar um limite global configurável de instâncias processadas simultaneamente. Uma instância MUST NOT participar de duas operações ativas ao mesmo tempo; o item conflitante SHALL ser `skipped` com motivo "operação em andamento", e uma operação individual conflitante SHALL ser recusada com `409`.

#### Scenario: Dois cliques seguidos
- **WHEN** duas solicitações de desligar a mesma instância chegam quase ao mesmo tempo
- **THEN** apenas uma é executada e a outra recebe `409`

#### Scenario: Limite de concorrência
- **WHEN** um lote tem 20 instâncias e o limite é 3
- **THEN** no máximo 3 instâncias são processadas simultaneamente

### Requirement: Execução assíncrona e verificação
A execução SHALL ocorrer em segundo plano, retornando imediatamente o identificador da operação. Após enviar a mutation, o sistema MUST consultar o Railway periodicamente até observar o estado desejado ou atingir o timeout configurado. Cada item SHALL terminar como `succeeded` (estado confirmado), `failed`, `skipped` ou `timed_out` (aceito pelo Railway, mas não confirmado no prazo). O estado observado da instância MUST ser atualizado a partir dessa leitura.

#### Scenario: Confirmação de início
- **WHEN** o novo deployment chega a `SUCCESS`
- **THEN** o item é `succeeded` e a instância passa a `running`

#### Scenario: Deployment falhou ao subir
- **WHEN** o novo deployment termina `FAILED` ou `CRASHED`
- **THEN** o item é `failed` com o status observado

#### Scenario: Sem confirmação no prazo
- **WHEN** o estado desejado não é observado até o timeout
- **THEN** o item é `timed_out` e a instância fica com o último estado lido

#### Scenario: Acompanhamento em andamento
- **WHEN** o frontend consulta uma operação em execução
- **THEN** recebe o progresso por item (pendente, executando, verificando, final)

### Requirement: Recuperação após reinício
Se o processo reiniciar durante uma operação, os itens não finalizados SHALL ser marcados como `interrupted` na inicialização, liberando os bloqueios, e a operação MUST NOT ser reexecutada automaticamente.

#### Scenario: Reinício no meio do lote
- **WHEN** o servidor reinicia com itens em execução
- **THEN** esses itens ficam `interrupted`, a operação é finalizada e as instâncias podem receber novas operações
