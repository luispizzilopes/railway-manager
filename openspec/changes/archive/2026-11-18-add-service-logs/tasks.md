## 1. Backend: leitura de logs no Railway

- [x] 1.1 Criar `deployment_logs.graphql`, `build_logs.graphql` e `deployment_list.graphql` (deploys recentes de serviço × ambiente com `id`, `status`, `createdAt`), registrá-las em `ops.rs` e verificar que `cargo build` valida os campos contra `railway.schema.json`
- [x] 1.2 Estender `RailwayGateway` com `deployment_logs`, `build_logs` e `recent_deployments` (tipos de domínio `LogLine`/`LogSeverity` com normalização para `error|warn|info|debug`), implementar no `client.rs` com o limite de 1000 linhas e classificação de erros existente; verificar com testes de transporte simulado (severidades normalizadas, `429`, deploy inexistente → não encontrado)
- [x] 1.3 Implementar as mesmas operações no `FakeRailway` do `testkit`, com logs programáveis por deploy; verificar que os testes existentes continuam passando

## 2. Backend: caso de uso e API

- [x] 2.1 Criar `LogsService` (resolve instância/credencial, deploy padrão atual, valida `deployment_id` contra os deploys recentes, valida `limit`/`start`/`end`/`severity`, aplica `q` e `severity`, ordena e marca `truncated`); verificar com testes de aplicação dos cenários "Logs do deploy mais recente", "Deploy de outra instância", "Instância sem deploy", "Somente erros", "Limite acima do máximo" e "Resultado truncado"
- [x] 2.2 Rotas `GET /api/instances/:id/logs` e `GET /api/instances/:id/deployments` com sessão obrigatória, erros `400`/`401`/`404`/`422`/`429` e sem registrar mensagens de log; verificar com testes HTTP incluindo "Sem sessão" e que nenhuma operação é criada no histórico
- [x] 2.3 Teste de auditoria garantindo que a resposta e os logs do servidor não contêm o token e que nada de log é gravado no banco; verificar rodando a suíte do backend (`cargo test`, `cargo clippy`)

## 3. Frontend: base

- [x] 3.1 Tipos e métodos em `api/types.ts` e `api/client.ts` (`instanceLogs`, `instanceDeployments`); verificar com `npm run typecheck`
- [x] 3.2 Utilitários de log (remoção de ANSI, deduplicação por `timestamp`+`message`, teto de 5000 linhas, formato do arquivo baixado); verificar com testes unitários dos cenários "Códigos ANSI" e "Baixar"
- [x] 3.3 Hook `useLogs` com polling incremental, intervalo adaptativo, pausa/retomada, suspensão com aba oculta e aviso de `429` sem apagar as linhas; verificar com testes com timers falsos nos cenários "Novas linhas", "Pausa", "Aba oculta" e "Rate limit"
- [x] 3.4 Componente `LogViewer` (horário com título completo, severidade por cor e texto, quebra de linha, busca local com destaque, copiar, baixar, rolagem automática só quando no fim) e estados vazio/erro; verificar com testes de componente, inclusive "Mensagem com HTML" e os estados "Sem logs no período" e "Token recusado"

## 4. Frontend: telas

- [x] 4.1 `LogsPanel` com filtros (tipo, deploy, intervalo, severidade, busca, limite) e indicação de deploy não atual; verificar com teste do cenário "Deploy anterior"
- [x] 4.2 Página `/logs` com seletores de projeto, ambiente e serviço, estado na URL e orientação sem seleção; adicionar a rota em `App.tsx`, o item "Logs" no `Layout` (navegação e paleta) e o ícone; verificar com testes "Escolher um serviço", "Abrir por link" e "Instância removida"
- [x] 4.3 Ação "Logs" em cada instância de `ProjectDetail` abrindo o painel, com "Abrir em tela cheia" levando a `/logs` com a instância e os filtros; verificar com testes "Abrir o painel" e "Levar para a tela cheia", e que ligar/desligar continuam funcionando
- [ ] 4.4 Ajustar estilos (responsivo no celular, tema claro e escuro, fonte monoespaçada) seguindo o sistema de design; verificar manualmente nas duas telas em desktop e em largura de celular

## 5. Documentação e verificação final

- [x] 5.1 Atualizar `README.md` com a funcionalidade de logs e a observação sobre segredos nos logs; verificar a revisão do texto
- [ ] 5.2 Rodar `npm run lint`, `npm test`, `npm run build` e a suíte do backend; verificar manualmente com um serviço real ou com o `FakeRailway` o fluxo completo (projeto → serviço → logs ao vivo → filtro de erros → tela cheia)
