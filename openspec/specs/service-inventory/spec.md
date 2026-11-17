# service-inventory Specification

## Purpose
Mantém o inventário local de ambientes, serviços e instâncias de serviço (um serviço em um ambiente) de cada projeto gerenciado, com o estado observado no Railway e sem duplicidades.

## Requirements

### Requirement: Modelo de inventário
Para cada projeto, o sistema SHALL manter ambientes (Railway Environment ID, nome, efêmero ou não), serviços (Railway Service ID, nome) e instâncias de serviço (par serviço × ambiente) com estado observado, ID e status do deployment mais recente e data da última sincronização. Uma instância MUST ser única por par serviço × ambiente, e todo serviço e ambiente MUST pertencer ao mesmo projeto da instância.

#### Scenario: Serviço em dois ambientes
- **WHEN** o serviço `api` existe em `production` e `staging`
- **THEN** o sistema mantém um serviço e duas instâncias, cada uma com seu próprio estado

#### Scenario: Associação duplicada
- **WHEN** tenta-se associar novamente o mesmo serviço ao mesmo ambiente
- **THEN** o sistema responde `409` sem criar duplicata

### Requirement: Consulta e importação a partir do Railway
O sistema SHALL listar os ambientes de um projeto e as instâncias de serviço de cada ambiente diretamente no Railway, indicando quais já são gerenciadas, e permitir importar instâncias seletivamente. Ambientes efêmeros (PR) SHALL ser exibidos separadamente e não importados por padrão.

#### Scenario: Importação seletiva
- **WHEN** o administrador seleciona duas instâncias de `production` e confirma
- **THEN** ambiente, serviços e instâncias são cadastrados localmente e seus estados são sincronizados

### Requirement: Associação manual
O sistema SHALL permitir associar uma instância informando Railway Service ID e Railway Environment ID. Ambos MUST ser validados no Railway e pertencer ao projeto.

#### Scenario: Serviço de outro projeto
- **WHEN** o Service ID informado pertence a outro projeto
- **THEN** o sistema responde `422` e não associa

### Requirement: Remoção de associação local
O sistema SHALL permitir remover instâncias ou serviços do gerenciamento sem afetar o Railway, preservando o histórico, e MUST recusar a remoção durante operação em andamento sobre o item.

#### Scenario: Remoção de instância
- **WHEN** o administrador remove a instância `api@staging`
- **THEN** apenas o vínculo local é apagado e o serviço continua rodando no Railway

### Requirement: Estado observado
O sistema SHALL derivar o estado observado de cada instância a partir dos deployments do Railway, usando os valores: `running`, `stopped`, `sleeping`, `transitioning`, `failed`, `awaiting_approval`, `unknown`. Cada estado MUST vir acompanhado de seu frescor: `fresh` (sincronizado dentro do limite configurado), `stale` (mais antigo) ou `unavailable` (última tentativa falhou).

#### Scenario: Deployment ativo com sucesso
- **WHEN** a instância possui deployment ativo com status `SUCCESS`
- **THEN** o estado é `running`

#### Scenario: Nenhum deployment ativo
- **WHEN** o deployment mais recente está `REMOVED` (ou parado) e não há deployment ativo
- **THEN** o estado é `stopped`

#### Scenario: Serverless dormindo
- **WHEN** o deployment ativo está `SLEEPING`
- **THEN** o estado é `sleeping`

#### Scenario: Em transição
- **WHEN** o deployment mais recente está em `QUEUED`, `WAITING`, `INITIALIZING`, `BUILDING`, `DEPLOYING` ou `REMOVING`
- **THEN** o estado é `transitioning`

#### Scenario: Falha
- **WHEN** o deployment mais recente está `FAILED` ou `CRASHED` e não há outro ativo
- **THEN** o estado é `failed`

#### Scenario: Consulta falhou
- **WHEN** a sincronização da instância falha
- **THEN** o último estado conhecido é mantido com frescor `unavailable` e o horário da última leitura bem-sucedida

#### Scenario: Instância removida no Railway
- **WHEN** o Railway não retorna mais o serviço ou a instância
- **THEN** o estado é `unknown` com indicação "não encontrado no Railway" e a instância não é elegível para operações
