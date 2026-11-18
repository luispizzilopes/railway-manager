## Purpose

Permite consultar e acompanhar, dentro do Railway Manager, os logs de runtime e de build de cada serviço gerenciado, em uma tela própria e na tela do projeto, sem expor o token do Railway ao navegador.

## ADDED Requirements

### Requirement: Leitura de logs de uma instância
O sistema SHALL expor `GET /api/instances/:id/logs`, autenticado como as demais rotas, que devolve as linhas de log de uma instância de serviço (serviço × ambiente) lidas no Railway com a credencial armazenada. Cada linha MUST conter `timestamp`, `severity` (`error`, `warn`, `info`, `debug` ou ausente) e `message`. O tipo de log SHALL ser `runtime` (padrão) ou `build`. Sem deploy escolhido, o sistema MUST usar o deploy mais recente da instância; com `deployment_id`, MUST usar esse deploy se ele pertencer à instância. As linhas MUST ser devolvidas em ordem cronológica crescente.

#### Scenario: Logs do deploy mais recente
- **WHEN** o administrador pede `GET /api/instances/{id}/logs` de uma instância com deploy ativo
- **THEN** a resposta traz o `deployment_id` usado e as linhas de runtime desse deploy, da mais antiga para a mais recente

#### Scenario: Logs de build
- **WHEN** o administrador pede `type=build`
- **THEN** a resposta traz as linhas de build do deploy escolhido

#### Scenario: Deploy de outra instância
- **WHEN** `deployment_id` não pertence à instância informada
- **THEN** o sistema responde `422` e não consulta os logs

#### Scenario: Instância sem deploy
- **WHEN** a instância nunca teve deploy
- **THEN** a resposta é `200` com lista vazia e `deployment_id` nulo, e a interface mostra "Nenhum deploy ainda"

#### Scenario: Sem sessão
- **WHEN** a requisição não tem sessão válida
- **THEN** o sistema responde `401` sem chamar o Railway

### Requirement: Escolha do deploy
O sistema SHALL expor `GET /api/instances/:id/deployments`, com os deploys recentes da instância (ID, status, data de criação), do mais novo para o mais antigo, limitados a 20, para o administrador consultar logs de um deploy anterior, como o que falhou antes de um rollback.

#### Scenario: Deploy anterior
- **WHEN** o administrador escolhe na lista um deploy `FAILED` de ontem
- **THEN** os logs exibidos passam a ser os desse deploy e a tela indica que não é o deploy atual

### Requirement: Filtros e limite
A leitura SHALL aceitar `limit` (padrão 200, máximo 1000), `start` e `end` (instantes ISO 8601), `severity` (um ou mais níveis) e `q` (texto). Valores fora do intervalo, instantes inválidos ou `start` posterior a `end` MUST ser recusados com `400` antes de qualquer chamada ao Railway. Quando houver mais linhas do que o `limit`, a resposta MUST trazer as mais recentes e `truncated: true`.

#### Scenario: Somente erros
- **WHEN** o administrador filtra por `severity=error`
- **THEN** a resposta contém apenas linhas de severidade `error`

#### Scenario: Limite acima do máximo
- **WHEN** `limit=5000`
- **THEN** o sistema responde `400` e não chama o Railway

#### Scenario: Resultado truncado
- **WHEN** o deploy tem mais linhas do que o `limit` pedido
- **THEN** a resposta traz as `limit` linhas mais recentes com `truncated: true`

### Requirement: Acompanhamento ao vivo
A interface SHALL acompanhar os logs de runtime ao vivo por consultas periódicas incrementais que usam o `timestamp` da última linha recebida como `start`, sem repetir linhas já exibidas. O acompanhamento MUST poder ser pausado e retomado, MUST ser suspenso enquanto a aba estiver oculta ou a tela deixar de ser exibida, e MUST respeitar o rate limit da integração: em caso de `429` ou indisponibilidade, MUST espaçar as tentativas e informar o motivo sem apagar as linhas já exibidas. Para deploys que não estão ativos e para logs de build, o acompanhamento MUST ficar desligado por padrão.

#### Scenario: Novas linhas
- **WHEN** o serviço imprime novas linhas com o acompanhamento ligado
- **THEN** elas aparecem ao final da lista sem duplicar as anteriores e, se o administrador estava no fim da lista, a rolagem acompanha

#### Scenario: Pausa
- **WHEN** o administrador pausa o acompanhamento e rola a lista para cima
- **THEN** nenhuma consulta é feita e a lista não se move até ele retomar

#### Scenario: Aba oculta
- **WHEN** a aba do navegador fica oculta com o acompanhamento ligado
- **THEN** as consultas são suspensas e retomam ao voltar à aba, buscando apenas o que faltou

#### Scenario: Rate limit
- **WHEN** o Railway responde `429`
- **THEN** a interface mantém as linhas atuais, mostra o aviso de limite atingido e tenta de novo após o intervalo indicado

### Requirement: Tela Logs
O frontend SHALL oferecer a tela `/logs`, com item "Logs" na navegação e na paleta de comandos, na qual o administrador escolhe o projeto, o ambiente e o serviço (listando apenas instâncias gerenciadas) e vê os logs com tipo (runtime/build), deploy, intervalo, severidade, busca e limite. A seleção e os filtros MUST ser refletidos na URL (`/logs?instance=…&type=…`), de modo que o link reabra a mesma consulta. Sem instância escolhida, a tela MUST mostrar a orientação para escolher uma.

#### Scenario: Escolher um serviço
- **WHEN** o administrador abre `/logs`, escolhe o projeto `loja`, o ambiente `production` e o serviço `api`
- **THEN** a URL passa a conter a instância escolhida e os logs de runtime do deploy atual são exibidos

#### Scenario: Abrir por link
- **WHEN** o administrador abre um link `/logs?instance={id}&severity=error`
- **THEN** a tela já vem com a instância e o filtro aplicados

#### Scenario: Instância removida
- **WHEN** o link aponta para uma instância que não está mais gerenciada
- **THEN** a tela informa que o serviço não foi encontrado e permite escolher outro, sem erro genérico

### Requirement: Logs na tela do projeto
A tela do projeto (`/projects/:id`) SHALL oferecer, em cada instância listada, a ação "Logs" que abre um painel com os logs daquela instância, com os mesmos filtros e o mesmo acompanhamento da tela Logs, sem sair da tela e sem interferir nas ações de ligar e desligar. O painel MUST ter o link "Abrir em tela cheia" que leva à tela `/logs` com a mesma instância e os mesmos filtros.

#### Scenario: Abrir o painel
- **WHEN** o administrador clica em "Logs" na instância `api@production`
- **THEN** o painel abre com os logs dessa instância e a lista de instâncias continua visível

#### Scenario: Levar para a tela cheia
- **WHEN** o administrador clica em "Abrir em tela cheia" com o filtro `error` aplicado
- **THEN** a tela `/logs` abre com a mesma instância e o filtro `error`

### Requirement: Visualização das linhas
Cada linha SHALL ser exibida com horário (no fuso do navegador, com o instante completo disponível ao passar o cursor), severidade identificável por cor e por texto, e a mensagem preservando espaços e quebras. O visualizador MUST oferecer quebra de linha opcional, busca local destacando as ocorrências, copiar o trecho exibido e baixar como arquivo de texto. Mensagens MUST ser exibidas como texto puro, nunca interpretadas como HTML, e códigos de cor ANSI MUST ser removidos da exibição.

#### Scenario: Mensagem com HTML
- **WHEN** a mensagem de uma linha contém `<script>alert(1)</script>`
- **THEN** o texto aparece literalmente e nada é executado

#### Scenario: Códigos ANSI
- **WHEN** a mensagem contém sequências de cor ANSI
- **THEN** elas não aparecem na exibição, só o texto

#### Scenario: Baixar
- **WHEN** o administrador baixa o trecho exibido
- **THEN** recebe um arquivo de texto com uma linha por registro, com horário, severidade e mensagem

### Requirement: Estados e erros
A interface MUST distinguir "carregando", "sem logs no período", "sem credencial ou token recusado", "Railway indisponível" e "serviço sem deploy", cada um com mensagem própria. Falhas MUST NOT apagar as linhas já exibidas.

#### Scenario: Sem logs no período
- **WHEN** o filtro não retorna nenhuma linha
- **THEN** a tela mostra "Nenhum log no período" com a sugestão de ampliar o intervalo

#### Scenario: Token recusado
- **WHEN** o Railway recusa o token ao buscar os logs
- **THEN** a tela informa que a credencial foi recusada e leva à tela de Configurações

### Requirement: Sem persistência e sem vazamento
O sistema MUST NOT gravar o conteúdo dos logs no banco, no histórico de operações nem em seus próprios logs, e MUST NOT incluir o token do Railway em nenhuma resposta. A consulta de logs MUST ser somente leitura e não alterar o estado do serviço.

#### Scenario: Auditoria
- **WHEN** o administrador consulta logs de uma instância
- **THEN** nenhuma operação é criada no histórico e nenhum conteúdo de log é gravado no banco
