## Why

Para investigar por que um serviço caiu, não subiu ou está lento, hoje é preciso sair do Railway Manager e abrir o painel do Railway, escolher projeto, ambiente e serviço de novo e só então ler os logs. Como o manager já conhece os projetos e serviços gerenciados e guarda o token do Railway, ele pode mostrar os logs de cada serviço no mesmo lugar em que o administrador liga, desliga e acompanha o estado.

## What Changes

- Novo endpoint no backend que lê os logs de uma instância de serviço (serviço × ambiente) no Railway, por meio da query `deploymentLogs`, e os devolve ao frontend. O token do Railway permanece só no backend.
- Suporte a logs de **runtime** e de **build** do deploy mais recente da instância, ou de um deploy escolhido na lista de deploys recentes.
- Filtros por intervalo de tempo, por severidade (`error`, `warn`, `info`, `debug`) e por texto, e limite de linhas.
- Acompanhamento ao vivo por polling incremental (a partir do último `timestamp` recebido), que o administrador pode pausar e retomar.
- Na tela **Projeto** (`/projects/:id`): cada instância ganha o atalho "Logs", que abre um painel de logs do serviço sem sair da tela.
- Nova tela **Logs** (`/logs`), com item na navegação e na paleta de comandos: escolhe o projeto, o ambiente e o serviço e mostra os logs com todos os filtros. A seleção fica na URL (`/logs?project=…&instance=…`), então um link leva direto aos logs de um serviço. O painel da tela Projeto tem um link "Abrir em tela cheia" para esse endereço.
- Componente de visualização de logs compartilhado pelas duas telas: linhas com horário, severidade colorida e mensagem, quebra de linha opcional, rolagem automática, busca local, cópia e download do trecho exibido.
- Fora do escopo: persistir logs no banco do manager, alertas sobre o conteúdo dos logs, logs de HTTP (`httpLogs`) e comandos de logs no console.

## Capabilities

### New Capabilities
- `service-logs`: leitura, filtro e acompanhamento dos logs de runtime e de build de uma instância de serviço, pela API do manager e pelas telas Logs e Projeto.

### Modified Capabilities
- `railway-api-integration`: a integração passa a consultar `deploymentLogs` e `buildLogs` (somente leitura), com limites de tamanho de resposta, e a lista de operações verificadas contra o snapshot do schema inclui essas queries.

## Impact

- **Backend**: nova rota autenticada `GET /api/instances/:id/logs`; nova porta/método de leitura de logs em `RailwayGateway` com a implementação em `infrastructure/src/railway` e novos arquivos `.graphql` (`deployment_logs`, `build_logs`, lista de deploys recentes); novo caso de uso `LogsService` na camada `application`; fake em `testkit`. Sem migração: nada é persistido.
- **Frontend**: nova página `Logs`, componente `LogViewer` e hook de polling; ajustes em `ProjectDetail`, `Layout` (navegação e paleta), `App` (rota), `api/client.ts` e `api/types.ts`. Sem novas dependências.
- **Railway**: mais chamadas de leitura. O polling respeita o rate limit já implementado e é interrompido quando a aba fica oculta.
- **Segurança**: logs podem conter segredos impressos pela aplicação. O endpoint exige sessão e as mensagens não são gravadas no manager nem no histórico de operações.
