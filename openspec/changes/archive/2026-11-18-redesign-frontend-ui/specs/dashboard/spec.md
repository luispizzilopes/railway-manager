## ADDED Requirements

### Requirement: Problemas em primeiro lugar
O dashboard SHALL destacar no topo, antes da listagem completa, os serviços que exigem atenção (com falha, aguardando aprovação, desatualizados ou indisponíveis), com acesso direto à ação cabível.

#### Scenario: Há falhas
- **WHEN** existem serviços com falha
- **THEN** o topo do dashboard lista esses serviços com seu estado e uma ação para tratá-los

#### Scenario: Tudo saudável
- **WHEN** nenhum serviço exige atenção
- **THEN** o topo exibe uma confirmação discreta de que não há pendências, sem ocupar espaço de destaque

### Requirement: Busca e filtros da listagem
O dashboard SHALL permitir buscar serviços por nome e filtrar por estado, projeto e ambiente, e SHALL lembrar os filtros durante a sessão de navegação.

#### Scenario: Filtrar por estado
- **WHEN** o administrador filtra por "Com falha"
- **THEN** a listagem mostra apenas os serviços com falha, informando quantos resultados correspondem

#### Scenario: Nenhum resultado
- **WHEN** nenhum serviço corresponde aos filtros
- **THEN** a listagem informa que nada foi encontrado e oferece limpar os filtros

### Requirement: Resumo de saúde
O dashboard SHALL exibir um resumo compacto com a proporção de serviços por estado, em texto e em barra segmentada, acompanhado das contagens, sem substituir os indicadores existentes.

#### Scenario: Proporção por estado
- **WHEN** existem 10 serviços, sendo 8 ativos, 1 desligado e 1 com falha
- **THEN** o resumo mostra 8, 1 e 1 com seus rótulos e a barra reflete as proporções
