# dashboard Specification

## Purpose
Oferece uma visão geral da infraestrutura gerenciada, com indicadores, estados por serviço, frescor dos dados e ações rápidas por projeto.

## Requirements

### Requirement: Indicadores
O dashboard SHALL exibir total de projetos gerenciados, total de instâncias monitoradas e contagens de instâncias `running` (incluindo `sleeping`, sinalizado à parte), `stopped`, `failed` e demais estados, além das últimas operações realizadas.

#### Scenario: Contagens
- **WHEN** existem 2 projetos com 5 instâncias, sendo 3 `running`, 1 `stopped` e 1 `failed`
- **THEN** o dashboard mostra 2 projetos, 5 serviços, 3 ativos, 1 interrompido e 1 com falha

### Requirement: Listagem de projetos e estados
O dashboard SHALL listar os projetos com suas instâncias agrupadas por ambiente, mostrando estado, frescor e horário da última leitura de cada uma. Dados `stale` ou `unavailable` MUST ser visualmente distintos de dados `fresh`.

#### Scenario: Dado desatualizado
- **WHEN** a última leitura de uma instância é mais antiga que o limite de frescor
- **THEN** a instância exibe o estado com indicação "desatualizado" e o horário da leitura

#### Scenario: Railway indisponível
- **WHEN** a atualização falha por indisponibilidade do Railway
- **THEN** o dashboard continua exibindo os últimos dados conhecidos com aviso de indisponibilidade

### Requirement: Atualização de estados
O dashboard SHALL permitir atualizar os estados sob demanda e SHALL atualizá-los automaticamente em intervalo configurável enquanto aberto, respeitando o rate limit.

#### Scenario: Atualização manual
- **WHEN** o administrador aciona "atualizar"
- **THEN** os estados são relidos do Railway e o horário de leitura é atualizado

### Requirement: Ações rápidas
Cada projeto SHALL oferecer ações "iniciar todos" e "desligar todos", e cada instância ações individuais. Ações sobre múltiplas instâncias MUST abrir a confirmação com o plano antes de executar.

#### Scenario: Desligar todos
- **WHEN** o administrador aciona "desligar todos" em um projeto
- **THEN** é exibida a lista das instâncias afetadas e ignoradas, e nada é executado até a confirmação

### Requirement: Alertas de integração
O dashboard SHALL exibir alerta quando não houver credencial configurada, quando a credencial estiver inválida ou quando o rate limit estiver esgotado.

#### Scenario: Sem credencial
- **WHEN** nenhuma credencial está configurada
- **THEN** o dashboard orienta a cadastrar o token e desabilita as ações
