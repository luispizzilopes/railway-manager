# command-console Specification

## Purpose
Console de comandos dentro do frontend que permite fazer, em uma linha, tudo o que a interface gráfica faz — ligar, desligar, reiniciar, agendar e gerenciar projetos, instâncias, agendas, credencial e histórico — com recursos extras como seletores com curinga, ações em todos os projetos, simulação, apelidos e documentação embutida.

## Requirements

### Requirement: Acesso ao console
O frontend SHALL oferecer o console em uma página própria (`/console`) e em um painel que pode ser aberto e fechado por atalho de teclado (`Ctrl+\``, e `Ctrl+K` como alternativa) a partir de qualquer tela autenticada. O console MUST estar disponível apenas com sessão válida e MUST usar a mesma API e as mesmas regras de autorização da interface gráfica. Ao expirar a sessão, o console MUST exibir o erro e o app MUST voltar ao login como nas demais telas.

#### Scenario: Abrir pelo atalho
- **WHEN** o administrador está na tela de Histórico e pressiona `Ctrl+\``
- **THEN** o painel do console abre com o cursor no campo de comando, sem sair da tela atual

#### Scenario: Sessão expirada
- **WHEN** um comando recebe `401` da API
- **THEN** o console exibe "sessão expirada" e o app volta para a tela de login

### Requirement: Sintaxe de comandos
Cada linha SHALL ser composta por um comando, subcomando quando houver, argumentos posicionais e opções (`--opcao valor`, `--opcao=valor` ou `-x`), com valores entre aspas simples ou duplas quando contiverem espaços. Comandos e subcomandos SHALL aceitar também os nomes em português definidos na referência (por exemplo `desligar` = `stop`, `ligar` = `start`, `reiniciar` = `restart`, `ajuda` = `help`). Vários comandos separados por `;` SHALL ser executados em sequência, e a sequência MUST parar no primeiro comando que falhar. Linhas com erro de sintaxe, comando desconhecido, opção desconhecida ou argumento obrigatório ausente MUST ser recusadas antes de qualquer chamada à API, com a mensagem do erro e a sugestão do comando mais próximo quando houver.

#### Scenario: Nome em português
- **WHEN** o administrador executa `desligar loja`
- **THEN** o resultado é o mesmo de `stop loja`

#### Scenario: Comando desconhecido
- **WHEN** o administrador digita `stp loja`
- **THEN** o console responde "comando desconhecido: stp — você quis dizer stop?" e nenhuma chamada à API é feita

#### Scenario: Sequência interrompida
- **WHEN** o administrador executa `project sync loja; stop loja -y` e a sincronização falha
- **THEN** o erro da sincronização é exibido e `stop loja` não é executado

### Requirement: Seletores de alvo
Comandos que agem sobre instâncias SHALL aceitar um ou mais seletores, resolvidos sobre as instâncias gerenciadas: `all` (todas as instâncias de todos os projetos gerenciados), `<projeto>` (todas as instâncias do projeto), `<projeto>@<ambiente>`, `<projeto>/<serviço>` (o serviço em todos os ambientes) e `<projeto>/<serviço>@<ambiente>`. Projeto, serviço e ambiente SHALL ser reconhecidos pelo nome de exibição, pelo nome no Railway ou pelo ID, sem diferenciar maiúsculas de minúsculas, e SHALL aceitar o curinga `*`. A opção `--env <ambiente>` SHALL restringir todos os seletores a um ambiente, `--except <seletor>` (repetível) SHALL remover instâncias do resultado e `--state <estado>` SHALL filtrar pelo estado observado. Um seletor que não corresponda a nada ou que seja ambíguo MUST fazer o comando falhar listando as possibilidades, sem executar nada. O resultado de vários seletores SHALL ser a união sem repetições.

#### Scenario: Curinga de serviço
- **WHEN** o administrador executa `stop */worker --env staging --dry-run`
- **THEN** o plano lista o serviço `worker` do ambiente `staging` de todos os projetos que o possuem

#### Scenario: Exclusão
- **WHEN** o administrador executa `stop all --except blog --except loja/db`
- **THEN** o plano inclui todas as instâncias gerenciadas, exceto as do projeto `blog` e as do serviço `db` de `loja`

#### Scenario: Curinga em projetos
- **WHEN** existem os projetos `loja` e `loja-admin` e o administrador executa `stop 'loja*' --dry-run`
- **THEN** o plano inclui as instâncias dos dois projetos

#### Scenario: Seletor sem correspondência
- **WHEN** existem os projetos `loja` e `loja-admin` e o administrador executa `stop loj`
- **THEN** o comando falha com "nenhum projeto 'loj' — semelhantes: loja, loja-admin" e nada é executado

### Requirement: Cobertura das funções da interface
O console SHALL oferecer comandos para todas as ações disponíveis na interface gráfica: encerrar a sessão (`logout`); ver, cadastrar ou substituir e remover a credencial (`credential show|set|rm`); ver a visão geral e os estados com indicadores e alertas (`status`) e atualizar os estados (`refresh`); descobrir, importar, cadastrar, ver, editar, sincronizar e remover projetos (`project discover|import|add|show|edit|sync|rm`, e `project list`); listar, descobrir, importar, associar e remover instâncias e remover serviços (`instance list|discover|import|add|rm`, `service rm`); ligar e desligar (`start`, `stop`); ver operações recentes e acompanhar uma operação (`ops`, `op <id>`); consultar o histórico com todos os filtros da tela (`history`); e listar, ver, criar, editar, pausar, retomar e excluir agendas e ver suas execuções (`schedule list|show|create|edit|pause|resume|rm|runs`). Ações destrutivas (remover projeto, instância, serviço, agenda ou credencial) MUST pedir confirmação, dispensável com `-y`. O comando `open <página|projeto>` SHALL navegar para a tela correspondente da interface.

#### Scenario: Importar todos os projetos descobertos
- **WHEN** o administrador executa `project import --all`
- **THEN** todos os projetos acessíveis ainda não gerenciados são importados e o console mostra importados, já gerenciados e falhas

#### Scenario: Criar agenda recorrente
- **WHEN** o administrador executa `schedule create loja --name Comercial --days seg-sex --window 07:00-12:00 --window 13:00-18:00`
- **THEN** a agenda é criada com o fuso padrão e o console mostra as próximas 5 execuções e os avisos retornados

#### Scenario: Remoção pede confirmação
- **WHEN** o administrador executa `project rm blog` sem `-y`
- **THEN** o console mostra o que será removido (instâncias e agendas) e só remove após a resposta `s`

### Requirement: Ligar e desligar com plano e confirmação
Os comandos `start` e `stop` SHALL resolver os seletores, gerar um plano no backend e exibir cada instância com projeto, serviço, ambiente, estado atual e ação prevista (incluindo motivos de `will_skip`), além do total por ação. Sem `-y`, o console MUST pedir confirmação (`s`/`N`, padrão não) antes de executar. Com `--dry-run`, o console SHALL exibir o plano e MUST NOT executar. Se o plano não tiver nenhuma ação a executar, o console SHALL informar e não pedir confirmação. Se o plano expirar antes da confirmação, o console MUST informar e permitir gerar um novo plano repetindo o comando.

#### Scenario: Simulação
- **WHEN** o administrador executa `stop loja --dry-run`
- **THEN** o plano é exibido e nenhuma operação é criada

#### Scenario: Confirmação negada
- **WHEN** o administrador executa `stop loja` e responde `n` (ou apenas Enter)
- **THEN** nada é executado e o console mostra "cancelado"

#### Scenario: Nada a fazer
- **WHEN** todas as instâncias do alvo já estão `stopped` e o administrador executa `stop loja`
- **THEN** o console mostra o plano com todos os itens `will_skip` e informa "nada a executar", sem pedir confirmação

### Requirement: Ligar e desligar tudo
Os comandos `stop all` e `start all` SHALL agir sobre todas as instâncias gerenciadas de todos os projetos gerenciados em uma única operação, combináveis com `--env`, `--except` e `--state`. Além da confirmação comum, quando o alvo for `all` sem `-y`, o console MUST exigir que o administrador digite a palavra `tudo` para confirmar.

#### Scenario: Desligar tudo
- **WHEN** o administrador executa `stop all` e digita `tudo` na confirmação
- **THEN** uma única operação de desligar é criada para todas as instâncias gerenciadas, com resultado por instância agrupado por projeto

#### Scenario: Ligar tudo em produção
- **WHEN** o administrador executa `start all --env production -y`
- **THEN** uma única operação de iniciar é criada para todas as instâncias gerenciadas do ambiente `production` de todos os projetos, sem confirmação

### Requirement: Reinício orquestrado
O comando `restart <seletor...>` SHALL reiniciar as instâncias do alvo desligando-as e, depois que a operação de desligar terminar, ligando as instâncias cujo desligamento terminou `succeeded`. Cada etapa SHALL ser uma operação própria no histórico. Instâncias que não estavam ligadas (plano de desligar com `will_skip`) MUST NOT ser ligadas pelo reinício e SHALL ser reportadas como ignoradas. O console SHALL exibir uma única confirmação com o plano de desligar e o aviso de que as instâncias ficarão fora do ar até a segunda etapa terminar, e ao final um resumo por instância (reiniciada, falhou ao desligar, falhou ao ligar, ignorada). Se o console for fechado ou a página recarregada entre as etapas, o reinício MUST ser considerado interrompido: as instâncias permanecem desligadas, e ao reabrir o console SHALL avisar sobre o reinício interrompido e oferecer o comando para ligá-las. O reinício MUST NOT ser agendável com `--at`/`--in`.

#### Scenario: Reinício bem-sucedido
- **WHEN** o administrador executa `restart loja/api -y` com a instância `running`
- **THEN** uma operação de desligar e depois uma de iniciar são criadas, e o console mostra `loja/api` como reiniciada

#### Scenario: Instância já desligada
- **WHEN** o alvo de `restart loja` inclui uma instância `stopped`
- **THEN** essa instância não é ligada e aparece como "ignorada — não estava ligada"

#### Scenario: Página recarregada no meio
- **WHEN** a página é recarregada depois da etapa de desligar e antes da etapa de ligar
- **THEN** ao abrir o console é exibido o aviso de reinício interrompido com o comando `start` pronto para as instâncias afetadas

#### Scenario: Reinício agendado recusado
- **WHEN** o administrador executa `restart all --at 03:00`
- **THEN** o console responde que `restart` não pode ser agendado e nada é criado

### Requirement: Acompanhamento de operações
Após executar uma operação, o console SHALL acompanhar o progresso por item até o fim (pendente, executando, verificando, final) e exibir o resultado agregado. Com `--no-wait`, o console SHALL apenas mostrar o identificador da operação. Interromper o acompanhamento (`Ctrl+C`) MUST NOT cancelar a operação no backend, e o console SHALL mostrar o comando `op <id>` para retomá-lo. O código de saída de um comando de operação SHALL ser falha quando a operação terminar `failed` ou `partially_failed`, para fins de interrupção de sequências com `;`.

#### Scenario: Retomar acompanhamento
- **WHEN** o administrador interrompe com `Ctrl+C` o acompanhamento de um `stop all` e depois executa `op <id>`
- **THEN** a operação continuou no backend e o console volta a mostrar o progresso atual dela

### Requirement: Agendamento pelo console
Os comandos `start` e `stop` SHALL aceitar `--at <quando>` ou `--in <duração>` para criar uma ação agendada pontual em vez de executar agora. `--at` SHALL aceitar `HH:MM` (hoje, ou amanhã se o horário já passou), `AAAA-MM-DD HH:MM` e `amanhã HH:MM`, no fuso padrão do sistema ou no informado por `--tz`; `--in` SHALL aceitar durações como `30m`, `2h` e `1h30m`. Antes de criar, o console SHALL exibir o instante resultante (no fuso escolhido e relativo, por exemplo "hoje 18:00 — em 3h12m"), o alvo e a quantidade atual de instâncias, e pedir confirmação (dispensável com `-y`). O comando `at list` SHALL listar ações agendadas (padrão: pendentes; `--all` inclui as demais), `at show <id>` SHALL mostrar uma ação com a operação gerada, e `at cancel <id>` (ou `at cancel --all`) SHALL cancelar ações pendentes.

#### Scenario: Desligar tudo às 18h
- **WHEN** às 14:48 o administrador executa `stop all --at 18:00 -y`
- **THEN** uma ação agendada de desligar com alvo "todos os projetos" é criada para hoje às 18:00 e o console mostra seu identificador e "em 3h12m"

#### Scenario: Horário já passou
- **WHEN** às 19:00 o administrador executa `start loja --at 07:00`
- **THEN** o instante proposto é amanhã às 07:00

#### Scenario: Cancelar
- **WHEN** o administrador executa `at cancel <id>` de uma ação pendente
- **THEN** a ação passa a `cancelled` e não é executada

### Requirement: Formato de saída
O console SHALL exibir resultados como tabelas e listas legíveis, com estados destacados por cor e texto (não apenas cor), datas no fuso do navegador e identificadores encurtados que possam ser copiados por inteiro com um clique. A opção global `--json` SHALL exibir a resposta da API sem formatação adicional. O comando `clear` SHALL limpar a saída.

#### Scenario: Saída JSON
- **WHEN** o administrador executa `status --json`
- **THEN** o console exibe o JSON da visão geral

### Requirement: Histórico e autocompletar
O console SHALL manter o histórico dos últimos 200 comandos no navegador, navegável com as setas ↑/↓ e pesquisável com `Ctrl+R`. A tecla `Tab` SHALL completar comandos, subcomandos, opções e valores conhecidos (projetos, serviços, ambientes, estados, IDs de agenda e de ação agendada) e, havendo várias opções, listá-las. O console MUST funcionar normalmente se o armazenamento do navegador estiver indisponível, apenas sem histórico persistente.

#### Scenario: Completar projeto
- **WHEN** o administrador digita `stop lo` e pressiona `Tab` com os projetos `loja` e `logs` gerenciados
- **THEN** o console lista `loja` e `logs` como opções

### Requirement: Apelidos
O comando `alias <nome>=<expansão>` SHALL criar um apelido que substitui o primeiro termo da linha pela expansão, `alias` sem argumentos SHALL listar os apelidos e `unalias <nome>` SHALL removê-lo. Apelidos MUST NOT substituir comandos existentes e SHALL ser guardados no navegador.

#### Scenario: Apelido para fim de expediente
- **WHEN** o administrador cria `alias fimdodia="stop all --except infra -y"` e executa `fimdodia`
- **THEN** o console executa `stop all --except infra -y`

### Requirement: Proteção de dados sensíveis
O token informado em `credential set` MUST ser digitado em um campo mascarado solicitado pelo console (não como argumento da linha), MUST NOT aparecer na saída e MUST NOT ser gravado no histórico de comandos. Linhas que contenham um token como argumento MUST ser recusadas com a orientação de usar o campo mascarado.

#### Scenario: Token como argumento
- **WHEN** o administrador digita `credential set account abc123...`
- **THEN** o console recusa a linha, não a grava no histórico e pede o token no campo mascarado

### Requirement: Documentação dos comandos
O comando `help` SHALL listar todos os comandos agrupados por área com uma linha de descrição, e `help <comando>` (ou `<comando> --help`) SHALL mostrar a sintaxe, os nomes em português, todas as opções com seus valores padrão e ao menos um exemplo. O repositório SHALL conter uma referência completa do console (`docs/console.md`) com a sintaxe, os seletores, todos os comandos e opções, a confirmação, o reinício, o agendamento, os apelidos, os atalhos de teclado e receitas de uso comuns. A ajuda embutida e a referência MUST descrever o mesmo conjunto de comandos e opções, e essa consistência MUST ser verificada por teste automatizado.

#### Scenario: Ajuda de um comando
- **WHEN** o administrador executa `help stop`
- **THEN** o console mostra a sintaxe de `stop`, o nome `desligar`, as opções `--env`, `--except`, `--state`, `--dry-run`, `-y`, `--at`, `--in`, `--tz`, `--no-wait` e `--json`, e exemplos

#### Scenario: Comando novo sem documentação
- **WHEN** um comando é adicionado ao console sem constar em `docs/console.md`
- **THEN** o teste de consistência da documentação falha

### Requirement: Exibição de erros
Erros da API SHALL ser exibidos com a mensagem retornada e o código HTTP, incluindo detalhes estruturados quando existirem (por exemplo, janelas em conflito de uma agenda). Falhas de rede SHALL ser exibidas como tais, sem travar o console.

#### Scenario: Agenda inválida
- **WHEN** `schedule create` recebe `400` com janelas em conflito
- **THEN** o console mostra a mensagem e as janelas em conflito, e a agenda não é criada

### Requirement: Modo somente CLI
Antes do login, o frontend SHALL permitir escolher entre usar a interface gráfica ou somente a linha de comando, e SHALL lembrar a escolha neste navegador. No modo CLI, o console SHALL ocupar a tela inteira e servir também de tela de login: o comando `login` MUST pedir a senha num campo mascarado, e antes do login apenas `login`, `ui`, `cli`, `help` e `clear` SHALL ser executados; os demais MUST responder que é preciso fazer login. O usuário SHALL poder alternar entre os modos a qualquer momento, com os comandos `ui`/`cli` ou com um controle visível em cada modo e na tela de login, sem precisar entrar de novo.

#### Scenario: Escolha antes do login
- **WHEN** o administrador abre o app sem sessão e sem modo escolhido
- **THEN** o app pergunta se ele quer a interface gráfica ou somente a linha de comando, antes de mostrar qualquer login

#### Scenario: Login pela linha de comando
- **WHEN** o administrador escolhe somente linha de comando
- **THEN** o console abre em tela cheia pedindo a senha num campo mascarado, e com a senha correta passa a aceitar todos os comandos

#### Scenario: Comando antes do login
- **WHEN** no modo CLI sem sessão o administrador executa `status`
- **THEN** o console responde "faça login primeiro: digite login" e nada é consultado

#### Scenario: Alternar sem entrar de novo
- **WHEN** o administrador autenticado no modo CLI executa `ui`
- **THEN** a interface gráfica aparece com a mesma sessão, e o botão "Modo CLI" volta ao console em tela cheia
