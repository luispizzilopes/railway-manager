# scheduled-actions Specification

## Purpose
Permite marcar uma ação única de ligar ou desligar para um instante futuro — por exemplo, desligar todos os projetos às 18:00 de hoje — executada automaticamente pelo agendador com as mesmas regras e a mesma auditoria das operações manuais, e cancelável enquanto estiver pendente.

## Requirements

### Requirement: Criação de ação agendada
O sistema SHALL permitir criar uma ação agendada com tipo (`start` ou `stop`), instante de execução (RFC 3339), alvo e uma observação opcional. O alvo SHALL ser um de: (a) todos os projetos gerenciados, (b) projetos selecionados, ou (c) instâncias selecionadas de qualquer projeto; nos alvos (a) e (b), opcionalmente restritos a um nome de ambiente. O sistema MUST recusar com `400` ações com tipo inválido, instante no passado ou a mais de 30 dias no futuro, alvo vazio, ou projetos/instâncias inexistentes ou não gerenciados. A ação criada SHALL ficar `pending`.

#### Scenario: Desligar tudo às 18h
- **WHEN** o administrador cria uma ação `stop` com alvo "todos os projetos" para hoje às 18:00
- **THEN** a ação é salva como `pending` com o instante em UTC e a resposta inclui seu identificador

#### Scenario: Instante no passado
- **WHEN** o instante informado já passou
- **THEN** o sistema responde `400` e nada é salvo

### Requirement: Alvo resolvido na execução
O conjunto de instâncias de uma ação agendada SHALL ser resolvido no momento da execução: no alvo (a), projetos e instâncias importados depois da criação MUST ser incluídos; nos alvos (a) e (b), instâncias removidas do gerenciamento MUST ser excluídas; no alvo (c), instâncias removidas do gerenciamento MUST ser ignoradas. Se nenhuma instância restar, a ação MUST terminar `skipped` com o motivo "sem instâncias no alvo", sem criar operação. A remoção de um projeto selecionado no alvo (b) MUST retirá-lo do alvo da ação.

#### Scenario: Projeto importado depois
- **WHEN** uma ação `stop` com alvo "todos os projetos" foi criada às 14:00 e o projeto `blog` foi importado às 15:00
- **THEN** a operação criada às 18:00 inclui as instâncias de `blog`

#### Scenario: Alvo vazio
- **WHEN** todas as instâncias selecionadas de uma ação foram removidas do gerenciamento antes do horário
- **THEN** a ação termina `skipped` com "sem instâncias no alvo" e nenhuma operação é criada

### Requirement: Execução automática da ação
No instante de uma ação `pending`, o sistema SHALL criar e executar a operação correspondente sobre as instâncias do alvo, sem confirmação humana, aplicando as mesmas regras das operações manuais (leitura do estado atual, itens já no estado desejado, em transição ou aguardando aprovação ignorados com motivo, isolamento de falhas, limite de concorrência, bloqueio de conflitos e verificação). A operação MUST registrar a origem `scheduled_action` e a ação que a disparou. Cada ação MUST ser executada no máximo uma vez, mesmo com reinícios do servidor. Ao ser processada, a ação SHALL passar a `executed` (ou `late`, se executada depois do instante), `skipped` ou `failed`, com a operação criada quando houver.

#### Scenario: Execução no horário
- **WHEN** chega o instante de uma ação `stop` pendente com alvo o projeto `loja`
- **THEN** é criada uma operação de desligar com origem `scheduled_action` e a ação passa a `executed` com o identificador da operação

#### Scenario: Reinício após executar
- **WHEN** o servidor reinicia logo após executar uma ação
- **THEN** a ação não é executada novamente

#### Scenario: Sem credencial válida
- **WHEN** chega o instante de uma ação e não há credencial válida
- **THEN** a ação termina `failed` com o motivo e nada é enviado ao Railway

### Requirement: Recuperação limitada de ações perdidas
Se o sistema estiver fora do ar no instante de uma ação, ao voltar SHALL executá-la somente se o atraso for no máximo o limite de recuperação configurado para as agendas (padrão 30 minutos), registrando-a como `late`. Acima do limite, a ação MUST ser registrada como `missed`, sem execução.

#### Scenario: Volta dentro do limite
- **WHEN** o servidor volta às 18:10 e a ação das 18:00 não foi executada
- **THEN** a ação é executada e registrada como `late`

#### Scenario: Volta fora do limite
- **WHEN** o servidor volta às 19:00 e a ação das 18:00 não foi executada
- **THEN** a ação é registrada como `missed` e nada é executado

### Requirement: Cancelamento
O sistema SHALL permitir cancelar uma ação `pending`, que passa a `cancelled` e MUST NOT ser executada. Tentar cancelar uma ação em qualquer outra situação MUST resultar em `409` com a situação atual.

#### Scenario: Cancelar já executada
- **WHEN** o administrador tenta cancelar uma ação `executed`
- **THEN** o sistema responde `409` informando que a ação já foi executada

### Requirement: Consulta de ações agendadas
O sistema SHALL listar ações agendadas ordenadas pelo instante (pendentes primeiro, da mais próxima para a mais distante; demais da mais recente para a mais antiga), com filtro por situação e paginação, exibindo tipo, instante, alvo descrito de forma legível (por exemplo "todos os projetos · production"), observação, situação, motivo e operação gerada. A tela de Agendas da interface SHALL exibir as ações pendentes com a opção de cancelar, e o histórico SHALL permitir filtrar pela origem `scheduled_action`.

#### Scenario: Ações pendentes na tela de Agendas
- **WHEN** existe uma ação pendente de desligar todos os projetos às 18:00
- **THEN** a tela de Agendas mostra "Desligar · todos os projetos · hoje 18:00" com o botão de cancelar
