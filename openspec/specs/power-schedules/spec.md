# power-schedules Specification

## Purpose
Permite ligar e desligar automaticamente projetos inteiros ou serviços específicos em horários definidos pelo usuário, com várias janelas por dia, dias da semana e fuso horário, usando as mesmas regras e a mesma auditoria das operações manuais.

## Requirements

### Requirement: Definição de agenda
O sistema SHALL permitir criar agendas com nome, situação (ativa ou pausada), fuso horário IANA, um ou mais dias da semana e uma ou mais janelas, cada uma com horário de início e de fim no formato `HH:MM`. Cada janela SHALL gerar um evento *iniciar* no horário de início e um evento *desligar* no horário de fim, nos dias selecionados, segundo o fuso da agenda. Uma janela cujo fim seja menor que o início MUST ser interpretada como terminando no dia seguinte; fim igual ao início é duração zero e inválido, e o dia da semana considerado é o do início. Sem fuso informado, o sistema MUST usar o fuso padrão configurado.

#### Scenario: Duas janelas no mesmo dia
- **WHEN** o administrador cria uma agenda de segunda a sexta com as janelas 07:00–12:00 e 13:00–18:00
- **THEN** a agenda gera, em cada dia útil, os eventos iniciar 07:00, desligar 12:00, iniciar 13:00 e desligar 18:00 no fuso da agenda

#### Scenario: Janela que atravessa a meia-noite
- **WHEN** a agenda de sexta tem a janela 22:00–02:00
- **THEN** os eventos são iniciar sexta 22:00 e desligar sábado 02:00

#### Scenario: Agenda pausada
- **WHEN** a agenda está pausada
- **THEN** nenhum evento dela é executado até ser retomada, e eventos ocorridos durante a pausa não são recuperados depois

### Requirement: Validação da agenda
O sistema MUST recusar com `400` agendas sem nome, sem dias, sem janelas, com horário ou fuso inválidos, com janela de duração zero ou com janelas que se sobreponham dentro da mesma agenda (considerando janelas que atravessam a meia-noite).

#### Scenario: Janelas sobrepostas
- **WHEN** a agenda tem as janelas 07:00–12:00 e 11:00–15:00
- **THEN** o sistema responde `400` indicando as janelas em conflito e nada é salvo

#### Scenario: Fuso inválido
- **WHEN** o fuso informado não existe na base IANA
- **THEN** o sistema responde `400` e nada é salvo

### Requirement: Alvo da agenda
Cada agenda SHALL ter como alvo exatamente um projeto gerenciado e, dentro dele, ou (a) todas as instâncias gerenciadas, opcionalmente restritas a um ambiente, ou (b) instâncias selecionadas. No alvo (a), instâncias importadas depois da criação MUST passar a ser incluídas e instâncias removidas do gerenciamento MUST deixar de ser. No alvo (b), instâncias removidas do gerenciamento MUST sair da agenda; se nenhuma restar, a agenda MUST ser pausada e sinalizada. A remoção do projeto do gerenciamento MUST excluir suas agendas.

#### Scenario: Projeto inteiro inclui instâncias novas
- **WHEN** uma agenda tem como alvo o projeto `loja` inteiro e uma nova instância de `loja` é importada
- **THEN** o próximo evento da agenda inclui a nova instância

#### Scenario: Única instância selecionada removida
- **WHEN** a única instância selecionada de uma agenda é removida do gerenciamento
- **THEN** a agenda fica pausada com o aviso "sem instâncias no alvo"

### Requirement: Execução automática dos eventos
No horário de cada evento de uma agenda ativa, o sistema SHALL executar a operação correspondente (iniciar ou desligar) sobre as instâncias do alvo, aplicando as mesmas regras das operações manuais: leitura do estado atual, instâncias já no estado desejado, em transição ou aguardando aprovação ignoradas com motivo, escolha do deployment a reaproveitar ao iniciar, isolamento de falhas, limite de concorrência, bloqueio de conflitos e verificação do resultado. Nenhuma confirmação humana é exigida. Cada evento MUST ser executado no máximo uma vez, mesmo com reinícios do servidor.

#### Scenario: Desligar no fim da janela
- **WHEN** chega 12:00 de um dia selecionado em uma agenda ativa com a janela 07:00–12:00
- **THEN** o sistema cria uma operação de desligar para as instâncias do alvo e cada item tem resultado próprio no histórico

#### Scenario: Instância em operação manual
- **WHEN** no horário do evento uma instância do alvo participa de uma operação manual em andamento
- **THEN** o item dessa instância é ignorado com motivo "operação em andamento" e as demais seguem

#### Scenario: Evento não executado duas vezes
- **WHEN** o servidor reinicia logo após executar o evento das 07:00
- **THEN** o evento das 07:00 não é executado novamente

### Requirement: Ação apenas nos horários
O sistema SHALL agir somente nos horários dos eventos. Entre dois eventos, o sistema MUST NOT ligar ou desligar instâncias para corrigir ações manuais.

#### Scenario: Ligado manualmente fora da janela
- **WHEN** o administrador liga manualmente às 15:00 uma instância cuja agenda desliga às 12:00 e liga às 13:00
- **THEN** o sistema não a desliga antes do próximo evento de desligar da agenda

### Requirement: Recuperação limitada de eventos perdidos
Se o sistema estiver fora do ar ou impedido de executar no horário de um evento, ao voltar SHALL executar, por agenda, apenas o evento perdido mais recente, e somente se tiver ocorrido há no máximo o limite configurado (padrão 30 minutos). Os demais eventos perdidos MUST ser registrados como `missed`, sem execução.

#### Scenario: Volta dentro do limite
- **WHEN** o servidor volta às 07:10 e o evento iniciar das 07:00 não foi executado
- **THEN** o evento das 07:00 é executado e registrado como atrasado

#### Scenario: Volta fora do limite
- **WHEN** o servidor volta às 13:30 depois de ficar fora desde 06:00, com eventos às 07:00, 12:00 e 13:00
- **THEN** apenas o evento das 13:00 é executado; os das 07:00 e 12:00 são registrados como `missed`

### Requirement: Conflito entre agendas
Quando, no mesmo instante, uma mesma instância receber evento de iniciar e de desligar vindos de agendas diferentes, o sistema SHALL executar apenas *iniciar* para essa instância e registrar o conflito na execução das duas agendas. Ao salvar uma agenda, o sistema SHALL avisar (sem impedir) quando suas janelas se sobrepõem às de outra agenda ativa com instâncias em comum.

#### Scenario: Iniciar prevalece
- **WHEN** às 12:00 a agenda A desliga a instância `api` e a agenda B a inicia
- **THEN** a instância `api` recebe apenas a ação de iniciar e ambas as execuções registram o conflito

### Requirement: Registro de execuções e origem
Cada evento processado SHALL gerar um registro de execução com agenda, ação, horário previsto, horário real, situação (`executed`, `late`, `skipped`, `missed`, `failed`) e, quando houver, a operação criada. Operações criadas pelo agendador MUST registrar a origem `schedule` e a agenda que as disparou, e o histórico SHALL permitir filtrar por origem (`manual` ou `schedule`). A exclusão de uma agenda MUST preservar as operações já criadas por ela.

#### Scenario: Filtro por origem
- **WHEN** o administrador filtra o histórico pela origem `schedule`
- **THEN** apenas itens de operações disparadas por agendas são retornados, com o nome da agenda

#### Scenario: Agenda sem token válido
- **WHEN** um evento ocorre sem credencial configurada ou com credencial inválida
- **THEN** a execução é registrada como `failed` com o motivo e nada é enviado ao Railway

### Requirement: Gerenciamento e visualização
O sistema SHALL permitir listar, criar, editar, pausar, retomar e excluir agendas, e exibir para cada agenda as próximas execuções (ao menos as 5 próximas, no fuso da agenda) e as últimas execuções. O dashboard SHALL exibir, por projeto, a próxima ação agendada (ação, horário e agenda). Editar uma agenda MUST valer a partir do próximo evento, sem recuperar eventos anteriores à edição.

#### Scenario: Próximas execuções
- **WHEN** o administrador abre uma agenda de segunda a sexta com janela 07:00–12:00 numa sexta às 10:00
- **THEN** as próximas execuções listadas são desligar sexta 12:00, iniciar segunda 07:00, desligar segunda 12:00, iniciar terça 07:00 e desligar terça 12:00

#### Scenario: Próxima ação no dashboard
- **WHEN** o projeto `loja` tem uma agenda ativa cujo próximo evento é desligar às 18:00
- **THEN** o card do projeto mostra "Desligar às 18:00" com o nome da agenda
