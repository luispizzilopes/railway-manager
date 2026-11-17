# Architecture Decision Records

Decisões de arquitetura do Railway Manager. Para criar um novo ADR, copie
[`template.md`](template.md) para `NNN-titulo-em-kebab-case.md` com o próximo número.

| ADR | Título | Status |
|---|---|---|
| [001](001-camadas-e-crates.md) | Camadas e Cargo workspace com crates por camada | aceito |
| [002](002-cliente-graphql-validado.md) | Cliente GraphQL validado em compilação | aceito |
| [003](003-mecanismo-de-desligamento.md) | Mecanismo de desligamento (`deploymentRemove` × `deploymentStop`) | proposto |
| [004](004-plano-execucao-verificacao.md) | Fluxo plano → execução → verificação | aceito |
| [005](005-credenciais.md) | Armazenamento e uso da credencial Railway | aceito |
| [006](006-agendador.md) | Agendador por varredura com exatamente-uma-vez no banco | aceito |
| [007](007-console-e-acoes-agendadas.md) | Console de comandos no cliente e ações agendadas pontuais | aceito |
