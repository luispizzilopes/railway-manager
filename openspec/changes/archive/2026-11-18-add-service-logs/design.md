## Context

Veja `proposal.md` para a motivação. O backend segue camadas (`domain` → `application` → `infrastructure`/`api`); o Railway é acessado pela porta `RailwayGateway`, com operações GraphQL geradas por `graphql_client` e validadas contra `railway.schema.json` (um campo inexistente quebra o build). O token fica cifrado no backend e o frontend só fala com `/api/*`. O snapshot do schema já contém `deploymentLogs(deploymentId, startDate, endDate, filter, limit)` e `buildLogs`, cujo tipo `Log` tem `timestamp`, `message`, `severity`, `tags` e `attributes`. A query `deployments` e o campo `latest_deployment_id` da instância já existem.

## Goals / Non-Goals

**Goals:**
- Ler logs de runtime e de build de uma instância gerenciada, com filtros, e acompanhá-los quase em tempo real.
- Um componente de visualização só, usado pela tela `/logs` e pelo painel em `/projects/:id`.
- Não guardar logs e não expor o token.

**Non-Goals:**
- Streaming por WebSocket/subscription do Railway; histórico persistido; logs HTTP; alertas por conteúdo; logs de instâncias não gerenciadas.

## Decisions

**1. O backend faz de proxy.** O navegador chama `GET /api/instances/:id/logs` e o backend usa a credencial armazenada. Alternativa descartada: o frontend falar direto com o Railway, o que exigiria enviar o token ao navegador.

**2. Alvo é a instância gerenciada, não o ID cru do deploy.** A rota recebe o ID local da instância, o que garante que só instâncias cadastradas são consultadas. O deploy padrão é `latest_deployment_id` lido do Railway no momento (`get_service_instance`), pois o valor do inventário pode estar velho após um redeploy. `deployment_id` opcional só é aceito se constar nos deploys recentes da instância (consulta `deployments` filtrada por serviço e ambiente), o que cobre o `422` da spec. Alternativa: `environmentLogs` filtrado por serviço. Ela mistura deploys e tem outra paginação, e `deploymentLogs` casa melhor com "logs do serviço".

**3. Polling incremental em vez de subscription.** O frontend repete a consulta a cada 3 s com `start` = último `timestamp` e descarta linhas já vistas por (`timestamp`, `message`). A integração é toda HTTP com rate limit centralizado; abrir WebSocket para o Railway exigiria outro transporte, autenticação e reconexão. O intervalo sobe (3 → 6 → 12 s) a cada resposta vazia e volta a 3 s ao chegar linha. Alternativa: SSE no manager, que ainda faria polling por trás e acrescentaria estado no servidor.

**4. Contrato da resposta.**
```
{ deployment_id, deployment_status, is_current, truncated,
  lines: [{ timestamp, severity, message }] }
```
`severity` é normalizada no backend para `error|warn|info|debug|null`. `limit` é aplicado pedindo ao Railway `limit` linhas (máx. 1000) e `truncated` é verdadeiro quando o número devolvido atinge o limite. O filtro `q` e a `severity` são enviados no argumento `filter` do Railway (`@level:error`, texto livre) e reaplicados no backend por segurança, já que a sintaxe do filtro é do Railway. A ordenação crescente é garantida no backend.

**5. `LogsService` na camada `application`.** Recebe o ID da instância, resolve projeto/credencial como `PowerService` já faz, valida os parâmetros (limites, datas, `start <= end`) antes de chamar o gateway e traduz o erro do Railway para os erros de aplicação existentes (`401` credencial, `404` deploy, `429`, indisponível). O gateway ganha `deployment_logs`, `build_logs` e `recent_deployments`; o `FakeRailway` do `testkit` ganha as mesmas operações.

**6. Frontend.** `LogViewer` (puro: recebe linhas e opções) e `useLogs` (React Query com `refetchInterval` dinâmico; pausa com `document.visibilityState` e ao desmontar). A lista acumulada fica em estado local com teto de 5000 linhas no cliente, descartando as mais antigas. A rolagem automática só segue o fim quando o usuário já estava no fim. A seleção e os filtros ficam nos search params da URL, o que dá o link compartilhável e o "Abrir em tela cheia" quase de graça. Em `ProjectDetail` o painel é uma gaveta/seção abaixo da lista de instâncias, usando o mesmo `LogsPanel` da tela `/logs`, que só acrescenta os seletores de projeto/ambiente/serviço.

**7. Segurança da exibição.** Mensagens são renderizadas como nós de texto (sem `dangerouslySetInnerHTML`); ANSI é removido por regex antes de exibir. O backend não registra mensagens de log nem as devolve em erros.

## Risks / Trade-offs

- [Polling consome o rate limit do Railway] → intervalo adaptativo, pausa com aba oculta, uma consulta por tela aberta e respeito ao `Retry-After` do transporte existente.
- [Logs de serviços grandes ou com linhas enormes] → `limit` máximo de 1000 por chamada, teto de 5000 no cliente e corte visual de linhas muito longas, com "ver mais".
- [Segredos aparecem nos logs] → o acesso exige sessão, nada é persistido e a exibição é só leitura. O manager não os mascara, pois isso daria uma falsa sensação de segurança.
- [Duplicatas ou lacunas com `start` incremental, pois o Railway pode devolver linhas com o mesmo `timestamp`] → deduplicação por (`timestamp`, `message`, posição entre iguais) no cliente e sobreposição de 1 s na janela seguinte.
- [A sintaxe do `filter` do Railway pode mudar] → filtros reaplicados no backend e teste do contrato com o `FakeRailway`; o snapshot do schema protege nomes de campos, mas não a semântica do filtro.
- [Deploy antigo sem logs retidos] → resposta vazia tratada como "sem logs no período".

## Open Questions

- Intervalo inicial do polling (3 s) e teto do cliente (5000 linhas) são valores iniciais que podem ser ajustados em uso real, sem mudar spec ou tarefas.
