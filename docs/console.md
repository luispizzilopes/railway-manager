# Console de comandos

O console faz em uma linha tudo o que a interface do Railway Manager faz, além de algumas coisas que ela não faz. Por exemplo: desligar **todos** os projetos de uma vez, usar curingas nos alvos, marcar uma ação para um horário (`stop all --at 18:00`), reiniciar em lote e criar apelidos.

O console usa a mesma API, as mesmas regras e a mesma auditoria da interface. Toda ação de ligar ou desligar passa pelo plano do servidor. Nada é executado sem que o plano seja mostrado antes.

- [Abrir o console](#abrir-o-console)
- [Modo somente CLI](#modo-somente-cli)
- [Sintaxe](#sintaxe)
- [Seletores de alvo](#seletores-de-alvo)
- [Plano, confirmação e simulação](#plano-confirmação-e-simulação)
- [Desligar e ligar tudo](#desligar-e-ligar-tudo)
- [Reiniciar](#reiniciar)
- [Agendar](#agendar)
- [Acompanhar operações](#acompanhar-operações)
- [Saída e `--json`](#saída-e---json)
- [Histórico, busca, autocompletar e atalhos](#histórico-busca-autocompletar-e-atalhos)
- [Apelidos](#apelidos)
- [Token do Railway](#token-do-railway)
- [Opções globais](#opções-globais)
- [Receitas](#receitas)
- [Equivalência com a interface](#equivalência-com-a-interface)
- [Referência de comandos](#referência-de-comandos)

## Abrir o console

- **Página:** item **Console** no menu lateral (`/console`).
- **Painel em qualquer tela:** ``Ctrl+` `` (crase) abre e fecha um painel na parte de baixo da tela, sem sair da tela atual. No macOS, `Cmd` também funciona. `Esc` fecha o painel.

A saída e o comando em andamento são os mesmos no painel e na página: dá para começar num e continuar no outro. O console exige sessão válida. Se a sessão expirar, ele mostra o erro e o app volta para o login.

## Modo somente CLI

Antes do login, o app pergunta como você quer usar o Railway Manager: **interface gráfica** ou **somente linha de comando (CLI)**. A escolha fica salva neste navegador.

- **No modo CLI**, o console ocupa a tela inteira e também é a tela de login. Ele já abre pedindo a senha num campo mascarado. Para entrar de novo depois de um `logout` ou de uma sessão expirada, digite `login`.
- Antes do login, só funcionam `login`, `ui`, `cli`, `help` e `clear`. Os outros comandos respondem "faça login primeiro".
- **Para trocar de modo a qualquer momento**, sem precisar entrar de novo:
  - na CLI, digite `ui` ou clique em **Interface gráfica** no topo;
  - na interface, clique em **Modo CLI** no topo ou digite `cli` no console;
  - na tela de login, use **Mudar para linha de comando (CLI)**.
- No modo CLI, `open <tela>` passa para a interface gráfica já na tela pedida.

## Sintaxe

```
comando [subcomando] [argumentos...] [--opção valor | --opção=valor | -x] [; outro comando]
```

- Valores com espaços vão entre aspas simples ou duplas: `--at "amanhã 07:00"`, `--name 'Loja virtual'`. `\` escapa o caractere seguinte.
- Todo comando aceita também um nome em português: `desligar` = `stop`, `ligar` = `start`, `reiniciar` = `restart`, `ajuda` = `help`, `projeto` = `project`, `agenda` = `schedule`… A [referência](#referência-de-comandos) lista todos.
- `;` executa comandos em sequência. A sequência **para no primeiro comando que falhar**: erro, confirmação negada ou operação que termina `failed` ou `partially_failed`.

  ```
  project sync loja; stop loja -y
  ```

- Comando desconhecido, opção desconhecida, valor ausente ou argumento obrigatório ausente fazem a linha ser recusada **antes** de qualquer chamada à API. Quando dá, o console sugere o nome mais próximo:

  ```
  › stp loja
  erro: comando desconhecido: stp — você quis dizer stop?
  ```

## Seletores de alvo

Os comandos que agem sobre instâncias (`start`, `stop`, `restart`, `status`, `instance list`, `instance rm`) recebem um ou mais seletores. Um seletor é resolvido sobre as instâncias **gerenciadas**:

| Seletor | Significa |
| --- | --- |
| `all` | todas as instâncias de todos os projetos gerenciados |
| `all@staging` | todas as instâncias do ambiente `staging`, em qualquer projeto |
| `loja` | todas as instâncias do projeto `loja` |
| `loja@production` | as instâncias de `loja` no ambiente `production` |
| `loja/api` | o serviço `api` de `loja` em todos os ambientes |
| `loja/api@production` | uma instância específica |
| `*/worker` | o serviço `worker` de todos os projetos que o têm |
| `loja*` | os projetos cujo nome começa com `loja` |
| `<uuid>` | uma instância (ou um projeto) pelo ID |

- Projetos, serviços e ambientes são reconhecidos pelo nome de exibição, pelo nome no Railway ou pelo ID, **sem diferenciar maiúsculas de minúsculas**.
- Sem `*`, o nome precisa ser exato. Se nada corresponder, o comando falha e lista nomes parecidos:
  `nenhum projeto 'loj' — semelhantes: loja, loja-admin`.
- Vários seletores formam a **união**, sem repetir instâncias: `stop loja/api blog`.
- Filtros aplicados depois da união:
  - `--env <ambiente>` restringe todos os seletores a um ambiente;
  - `--state <estado>` mantém só as instâncias num estado: `running`, `stopped`, `sleeping`, `transitioning`, `failed`, `awaiting_approval` ou `unknown`;
  - `--except <seletor>` (repetível) remove instâncias do resultado.
- Se nada sobrar depois dos filtros, o comando falha sem executar nada.

## Plano, confirmação e simulação

`start` e `stop` sempre:

1. resolvem os seletores (com dados recém-lidos da visão geral);
2. pedem ao servidor um **plano**, que lê o estado real no Railway;
3. mostram cada instância com projeto, serviço, ambiente, estado atual e ação prevista (`desligar`, `iniciar` ou `ignorar: motivo`), mais os totais;
4. pedem confirmação: `s` para sim, `N` (ou só Enter) para não.

| Opção | Efeito |
| --- | --- |
| `--dry-run` | mostra o plano e para; nada é executado |
| `-y`, `--yes` | executa sem perguntar |

- Se nada precisa ser feito (por exemplo, tudo já está desligado), o console mostra o plano, avisa **"nada a executar"** e não pergunta nada.
- O plano vale por alguns minutos (`RM_PLAN_TTL_SECS`). Se expirar antes da confirmação, o console avisa e basta repetir o comando.
- As regras do servidor continuam valendo: instâncias em transição, aguardando aprovação ou já em outra operação aparecem como ignoradas, com o motivo.
- Remoções (`project rm`, `instance rm`, `service rm`, `schedule rm`, `credential rm`) mostram o que será removido e também pedem confirmação, dispensável com `-y`.

## Desligar e ligar tudo

```
stop all            # desliga todas as instâncias de todos os projetos
start all           # liga todas
```

- Viram **uma única operação**, com resultado por instância e agrupado por projeto.
- Sem `-y`, a confirmação exige **digitar `tudo`**. Responder `s` não basta.
- Combinam com os filtros: `stop all --except infra`, `start all --env production -y`, `stop all --state running`.

## Reiniciar

```
restart <seletor...> [--env] [--except] [--state] [--dry-run] [-y]
```

O reinício é feito pelo console em duas etapas, e cada uma vira uma operação própria no histórico:

1. **desligar** as instâncias do alvo e esperar a operação terminar;
2. **ligar** só as instâncias cujo desligamento terminou `succeeded`.

- Instâncias que **não estavam ligadas** não são ligadas. Aparecem como `ignorada — não estava ligada`.
- Há **uma** confirmação, com o plano de desligar e o aviso de que as instâncias ficam fora do ar até a segunda etapa terminar. Com o seletor `all`, a confirmação exige digitar `tudo`.
- Ao final, um resumo por instância: `reiniciada`, `falhou ao desligar`, `falhou ao ligar` ou `ignorada`.
- **Se a página for fechada ou recarregada entre as etapas**, as instâncias continuam desligadas. Ao reabrir, o console abre sozinho, avisa sobre o reinício interrompido e deixa pronto o comando `start <ids> -y`: basta pressionar Enter.
- O reinício **não pode ser agendado**: `restart … --at/--in` é recusado. Agende um `stop` e um `start` separados.

## Agendar

Há dois tipos de agendamento.

### Ações pontuais (uma vez): `--at` / `--in`

`start` e `stop` com `--at` ou `--in` criam uma **ação agendada** em vez de executar agora. O servidor a executa no horário, sem pedir confirmação, com as mesmas regras e auditoria das operações manuais. No histórico, a origem aparece como `scheduled_action`.

| Forma | Exemplo | Instante |
| --- | --- | --- |
| `HH:MM` | `--at 18:00` | hoje; amanhã se o horário já passou |
| `18h`, `18h30` | `--at 18h30` | idem |
| `AAAA-MM-DD HH:MM` | `--at "2026-11-20 07:00"` | data e hora |
| `DD/MM HH:MM` | `--at "20/11 07:00"` | no ano atual |
| `hoje HH:MM`, `amanhã HH:MM` | `--at "amanhã 07:00"` | relativo |
| duração | `--in 30m`, `--in 2h`, `--in 1h30m`, `--in 1d` | a partir de agora |

- O fuso é o padrão das agendas (`RM_SCHEDULE_TIMEZONE`) ou o informado em `--tz America/Sao_Paulo`. Um horário que não existe por causa do horário de verão vira o primeiro instante válido.
- A ação pode ser marcada para no máximo **30 dias** à frente.
- `--note <texto>` guarda uma observação.
- Antes de criar, o console mostra o instante (`hoje 18:00 — em 3h12m`), o fuso, o alvo e quantas instâncias ele tem hoje, e pede confirmação (`-y` dispensa).
- **Como o alvo é guardado:**
  - só `all` (com `--env` opcional) é **dinâmico**: na hora da execução inclui projetos e instâncias importados depois;
  - só projetos inteiros (`loja`, `loja@production`, `loja*`) guardam a lista de **projetos**: instâncias importadas depois entram;
  - qualquer outra coisa (serviço, curinga de serviço, `--except`) guarda as **instâncias fixas** resolvidas agora.
- `--state` não pode ser usado com `--at`/`--in`, porque o estado só é conhecido na hora da execução.
- Se o servidor estiver fora do ar no horário, ao voltar ele executa a ação se o atraso for de até `RM_SCHEDULE_CATCHUP_SECS` (padrão 30 min), marcando-a como `late`. Com atraso maior, a ação é registrada como `missed` e não é executada.

Para gerenciar:

```
at list                 # pendentes
at list --all           # todas (executadas, canceladas, perdidas, com falha…)
at show 7c1e            # detalhes e a operação gerada
at cancel 7c1e          # cancela (ID completo ou prefixo de 4+ caracteres)
at cancel --all -y      # cancela todas as pendentes
```

As ações pendentes também aparecem na tela **Agendas**, com o botão **Cancelar**.

### Agendas recorrentes: `schedule`

São as mesmas agendas da tela Agendas: janelas ligadas em dias da semana, num fuso.

```
schedule create loja --name Comercial --days seg-sex --window 07:00-12:00 --window 13:00-18:00
schedule create loja@staging --name Noite --days todos --window 22:00-02:00
schedule create loja --name Workers --days uteis --window 08:00-18:00 --instances worker@production
schedule pause comercial; schedule resume comercial
```

- `--days`: `seg-sex`, `seg,qua,sex`, `sex-seg` (passa pelo domingo), `todos`, `uteis`, `fds`. Aceita também nomes em inglês (`mon-fri`).
- `--window HH:MM-HH:MM` (repetível): o início liga e o fim desliga. Se o fim for menor que o início, a janela atravessa a meia-noite.
- Agendas são referidas pelo nome ou pelo ID (ou prefixo dele).
- Erros de validação mostram as janelas em conflito: `janelas em conflito: 07:00–12:00 × 11:00–15:00`.

## Acompanhar operações

Depois de executar, o console acompanha a operação até o fim, mostrando cada item (pendente, executando, verificando, final) e o resultado agregado.

- `--no-wait` só mostra o identificador da operação.
- `Ctrl+C` **para só o acompanhamento**: a operação continua no servidor. O console mostra `op <id>` para retomar.
- `ops` lista as operações recentes. `op <id>` (ID ou prefixo) volta a acompanhar uma delas.

## Saída e `--json`

- Resultados aparecem como tabelas. Os estados têm cor **e** texto.
- As datas usam o fuso do navegador. Agendas e ações agendadas também mostram o fuso delas.
- IDs aparecem encurtados (8 caracteres). Passe o mouse para ver o ID completo e clique para copiá-lo.
- `--json` em qualquer comando mostra a resposta da API sem formatação.
- `clear` (ou `Ctrl+L`) limpa a saída.

## Histórico, busca, autocompletar e atalhos

| Tecla | Ação |
| --- | --- |
| `Enter` | executa a linha |
| `↑` / `↓` | navega pelos últimos 200 comandos |
| `Ctrl+R` | busca no histórico: cada toque procura uma entrada mais antiga que contenha o texto digitado |
| `Tab` | completa comando, subcomando, opção ou valor (projetos, serviços, ambientes, estados, agendas, ações, operações); se houver várias opções, lista todas |
| `Ctrl+C` | interrompe o comando em andamento ou cancela a pergunta; sem comando em andamento, limpa a linha |
| `Ctrl+L` | limpa a saída |
| `Esc` | cancela a pergunta, sai da busca ou fecha o painel |
| ``Ctrl+` `` | abre ou fecha o painel (`Ctrl+K` abre a paleta de comandos, que também abre o console) |

O histórico e os apelidos ficam **neste navegador**. Se o armazenamento do navegador estiver indisponível (janela privada, bloqueio), o console funciona normalmente, só que sem guardar o histórico.

## Apelidos

```
alias fimdodia="stop all --except infra -y"
alias bomdia="start all --env production -y"
alias              # lista
unalias fimdodia
```

O apelido troca o **primeiro termo** da linha pela expansão. O resto da linha é mantido: `fimdodia --env staging` vira `stop all --except infra -y --env staging`. Um apelido nunca substitui um comando existente.

## Token do Railway

`credential set account` (ou `credential set workspace --workspace <id>`) pede o token num **campo mascarado**. O token nunca aparece na saída e nunca vai para o histórico de comandos. Uma linha com o token como argumento (`credential set account abc…`) é recusada e não é gravada.

## Opções globais

Aceitas por todos os comandos:

| Opção | Descrição |
| --- | --- |
| `--json` | mostra a resposta da API em JSON, sem formatação |
| `-h`, `--help` | mostra a ajuda do comando (o mesmo que `help <comando>`) |

## Receitas

```
# Fim do expediente: desliga tudo, menos a infraestrutura
stop all --except infra

# Desligar tudo hoje às 19h e religar produção amanhã às 7h
stop all --at 19:00 -y; start all --env production --at "amanhã 07:00" -y

# O que está ligado agora em staging?
status --env staging --state running

# Simular antes de agir
stop */worker --dry-run

# Reiniciar a API de produção de todos os projetos
restart */api@production

# Primeira configuração: token, projetos e instâncias
credential set account; project import --all; instance import loja --all

# O que as ações agendadas fizeram nesta semana?
history --trigger scheduled_action --from 2026-11-17

# Pausar todas as agendas de um projeto para uma manutenção
schedule list loja
schedule pause comercial; schedule pause noite
```

## Equivalência com a interface

| Na interface | No console |
| --- | --- |
| Visão geral (indicadores, alertas, estados) | `status` |
| Atualizar estados | `refresh` |
| Projetos → Descobrir / Importar | `project discover`, `project import <nomes>` / `--all` |
| Projetos → Cadastrar por ID | `project add <id-railway>` |
| Projeto → Editar / Sincronizar / Remover | `project edit`, `project sync`, `project rm` |
| Projeto → Instâncias (descobrir, importar, associar, remover) | `instance discover`, `instance import`, `instance add`, `instance rm` |
| Remover serviço | `service rm projeto/serviço` |
| Ligar / desligar (instância, projeto, lote) | `start` / `stop` com seletores |
| Acompanhar operação | `op <id>`, `ops` |
| Histórico com filtros | `history --project --service --env --kind --result --trigger --from --to` |
| Agendas (criar, editar, pausar, retomar, excluir, execuções) | `schedule create/edit/pause/resume/rm/runs/show/list` |
| Configurações → Token | `credential show`, `credential set`, `credential rm` |
| Sair | `logout` |
| Entrar (tela de login) | `login` (modo CLI) |
| Trocar entre interface e CLI | `ui` / `cli` |
| *(só no console)* | `all`, curingas, `--except`, `--state`, `restart`, `--at`/`--in`, `at`, `alias`, `--json`, sequências com `;` |

## Referência de comandos

Gerada a partir do mesmo registro que o `help` do console usa. Um teste automatizado confere que esta referência e o console têm os mesmos comandos e opções.

## Energia

### `stop`

Desliga instâncias (interrompe os deployments ativos).

```
stop <seletor...> [opções]
```

Também: `desligar`.

Gera um plano no servidor, mostra o que será feito e pede confirmação antes de desligar. Com o seletor all, a confirmação exige digitar "tudo". Com --at/--in, cria uma ação agendada em vez de executar agora (alvo all é dinâmico; projetos inteiros incluem instâncias novas; o resto fica fixo).

| Argumento | Descrição |
| --- | --- |
| `<seletor...>` | all, projeto, projeto@ambiente, projeto/serviço, projeto/serviço@ambiente; aceita * e IDs |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--env <ambiente>` | — | restringe todos os seletores a um ambiente |
| `--except <seletor>` (repetível) | — | remove instâncias do alvo |
| `--state <estado>` | — | filtra pelo estado observado (running, stopped, …) |
| `--dry-run` | — | só mostra o plano; nada é executado |
| `-y, --yes` | — | não pede confirmação |
| `--no-wait` | — | não acompanha a operação; mostra só o identificador |
| `--at <quando>` | — | agenda para um instante: HH:MM, AAAA-MM-DD HH:MM, DD/MM HH:MM, "amanhã HH:MM" |
| `--in <duração>` | — | agenda para daqui a uma duração: 30m, 2h, 1h30m |
| `--tz <fuso>` | fuso padrão das agendas | fuso IANA de --at |
| `--note <texto>` | — | observação da ação agendada |

```
stop loja
stop all --except infra
stop */worker --env staging --dry-run
stop all --at 18:00 -y
desligar loja/api@production -y --no-wait
```

### `start`

Liga instâncias (reaproveita o último deployment).

```
start <seletor...> [opções]
```

Também: `ligar`.

Gera um plano no servidor, mostra o que será feito e pede confirmação antes de iniciar. Com o seletor all, a confirmação exige digitar "tudo". Com --at/--in, cria uma ação agendada em vez de executar agora (alvo all é dinâmico; projetos inteiros incluem instâncias novas; o resto fica fixo).

| Argumento | Descrição |
| --- | --- |
| `<seletor...>` | all, projeto, projeto@ambiente, projeto/serviço, projeto/serviço@ambiente; aceita * e IDs |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--env <ambiente>` | — | restringe todos os seletores a um ambiente |
| `--except <seletor>` (repetível) | — | remove instâncias do alvo |
| `--state <estado>` | — | filtra pelo estado observado (running, stopped, …) |
| `--dry-run` | — | só mostra o plano; nada é executado |
| `-y, --yes` | — | não pede confirmação |
| `--no-wait` | — | não acompanha a operação; mostra só o identificador |
| `--at <quando>` | — | agenda para um instante: HH:MM, AAAA-MM-DD HH:MM, DD/MM HH:MM, "amanhã HH:MM" |
| `--in <duração>` | — | agenda para daqui a uma duração: 30m, 2h, 1h30m |
| `--tz <fuso>` | fuso padrão das agendas | fuso IANA de --at |
| `--note <texto>` | — | observação da ação agendada |

```
start loja@production
start all --env production -y
start blog --in 2h
start all --at "amanhã 07:00" --tz America/Sao_Paulo
```

### `restart`

Reinicia instâncias: desliga e, ao terminar, liga as que desligaram.

```
restart <seletor...> [opções]
```

Também: `reiniciar`.

Duas operações no histórico (desligar, depois iniciar). Instâncias que não estavam ligadas não são ligadas. Se o console for fechado entre as etapas, as instâncias ficam desligadas e, ao reabrir, o console mostra o comando para ligá-las.

| Argumento | Descrição |
| --- | --- |
| `<seletor...>` | all, projeto, projeto@ambiente, projeto/serviço, projeto/serviço@ambiente; aceita * e IDs |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--env <ambiente>` | — | restringe todos os seletores a um ambiente |
| `--except <seletor>` (repetível) | — | remove instâncias do alvo |
| `--state <estado>` | — | filtra pelo estado observado (running, stopped, …) |
| `--dry-run` | — | só mostra o plano; nada é executado |
| `-y, --yes` | — | não pede confirmação |
| `--at <quando>` | — | não suportado: o reinício não pode ser agendado |
| `--in <duração>` | — | não suportado: o reinício não pode ser agendado |

```
restart loja/api@production
restart loja --env staging -y
reiniciar */worker --dry-run
```

## Consulta

### `status`

Visão geral: indicadores, alertas e estado de cada instância.

```
status [seletor...] [opções]
```

Também: `ls`, `estado`.

| Argumento | Descrição |
| --- | --- |
| `<seletor...>` (opcional) | filtra as instâncias (padrão: todas) |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--env <ambiente>` | — | só um ambiente |
| `--state <estado>` | — | só instâncias neste estado |

```
status
status loja
ls --state stopped
status */worker --env staging
```

### `refresh`

Lê de novo o estado de todas as instâncias no Railway.

```
refresh
```

Também: `atualizar`.

```
refresh
```

## Operações

### `ops`

Operações recentes.

```
ops
```

Também: `operacoes`.

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--limit <n>` | 10 | quantas mostrar |

```
ops
ops --limit 3
```

### `op`

Mostra e acompanha uma operação até o fim.

```
op <id> [opções]
```

Também: `operacao`.

| Argumento | Descrição |
| --- | --- |
| `<id>` | ID completo ou prefixo (de ops) |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--no-wait` | — | mostra o estado atual sem acompanhar |

```
op 3f2a91c0
op 3f2a91c0 --no-wait
```

### `history`

Histórico de itens de operações, com os filtros da tela.

```
history
```

Também: `historico`.

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--project <projeto>` | — | projeto (nome ou ID) |
| `--service <serviço>` | — | serviço (nome ou ID Railway) |
| `--env <ambiente>` | — | ambiente |
| `--kind <tipo>` | — | start ou stop |
| `--result <resultado>` | — | pending, running, verifying, succeeded, failed, skipped, timed_out, interrupted |
| `--trigger <origem>` | — | manual, schedule, scheduled_action |
| `--from <data>` | — | a partir de (AAAA-MM-DD ou RFC 3339) |
| `--to <data>` | — | até (AAAA-MM-DD ou RFC 3339, inclusive) |
| `--page <n>` | 1 | página |
| `--limit <n>` | 20 | itens por página |

```
history
history --project loja --kind stop --result failed
history --trigger scheduled_action --from 2026-11-01
```

## Agendamento

### `at` — ações agendadas pontuais (criadas com start/stop --at/--in)

Também: `agendadas`. Subcomandos: `list`, `show`, `cancel`.

#### `at list`

Lista ações agendadas (padrão: pendentes).

```
at list
```

Também: `ls`.

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--all` | — | inclui executadas, canceladas, perdidas… |
| `--status <situação>` | — | pending, processing, executed, late, skipped, missed, failed, cancelled |

```
at list
at list --all
at list --status failed
```

#### `at show`

Mostra uma ação e a operação que ela gerou.

```
at show <id>
```

| Argumento | Descrição |
| --- | --- |
| `<id>` | ID ou prefixo |

```
at show 7c1e
```

#### `at cancel`

Cancela ações pendentes.

```
at cancel <id...> | --all
```

Também: `cancelar`.

| Argumento | Descrição |
| --- | --- |
| `<id...>` (opcional) | IDs ou prefixos |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--all` | — | cancela todas as pendentes |
| `-y, --yes` | — | não pede confirmação |

```
at cancel 7c1e
at cancel --all -y
```

### `schedule` — agendas recorrentes de ligar/desligar

Também: `agenda`, `schedules`. Subcomandos: `list`, `show`, `create`, `edit`, `pause`, `resume`, `rm`, `runs`.

#### `schedule list`

Lista agendas com a próxima execução.

```
schedule list [projeto]
```

Também: `ls`.

| Argumento | Descrição |
| --- | --- |
| `<projeto>` (opcional) | só deste projeto |

```
schedule list
schedule list loja
```

#### `schedule show`

Detalhes, próximas 5 e últimas execuções.

```
schedule show <agenda>
```

| Argumento | Descrição |
| --- | --- |
| `<agenda>` | nome ou ID (prefixo) |

```
schedule show comercial
```

#### `schedule create`

Cria uma agenda para um projeto (ou ambiente, ou instâncias).

```
schedule create <projeto[@ambiente]> --name <nome> --days <dias> --window <HH:MM-HH:MM>... [opções]
```

Também: `criar`.

| Argumento | Descrição |
| --- | --- |
| `<projeto[@ambiente]>` | alvo da agenda |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--name <nome>` | — | nome da agenda |
| `--days <dias>` | — | seg-sex, seg,qua,sex, todos, fds, uteis |
| `--window <HH:MM-HH:MM>` (repetível) | — | janela ligada (início liga, fim desliga); fim < início atravessa a meia-noite |
| `--tz <fuso>` | fuso padrão das agendas | fuso IANA |
| `--instances <lista>` | — | serviço@ambiente separados por vírgula (em vez do projeto inteiro) |

```
schedule create loja --name Comercial --days seg-sex --window 07:00-12:00 --window 13:00-18:00
schedule create loja@staging --name Noite --days todos --window 22:00-02:00 --tz America/Sao_Paulo
schedule create loja --name Workers --days uteis --window 08:00-18:00 --instances worker@production,worker@staging
```

#### `schedule edit`

Altera uma agenda (só os campos informados; --window substitui todas).

```
schedule edit <agenda> [opções]
```

Também: `editar`.

| Argumento | Descrição |
| --- | --- |
| `<agenda>` | nome ou ID (prefixo) |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--name <nome>` | — | nome da agenda |
| `--days <dias>` | — | seg-sex, seg,qua,sex, todos, fds, uteis |
| `--window <HH:MM-HH:MM>` (repetível) | — | janela ligada (início liga, fim desliga); fim < início atravessa a meia-noite |
| `--tz <fuso>` | fuso padrão das agendas | fuso IANA |
| `--instances <lista>` | — | serviço@ambiente separados por vírgula (em vez do projeto inteiro) |
| `--env <ambiente>` | — | alvo: projeto inteiro restrito a um ambiente |
| `--whole` | — | alvo: projeto inteiro, todos os ambientes |

```
schedule edit comercial --window 08:00-18:00
schedule edit comercial --days seg-sab --whole
```

#### `schedule pause`

Pausa (eventos durante a pausa não são recuperados).

```
schedule pause <agenda>
```

Também: `pausar`.

| Argumento | Descrição |
| --- | --- |
| `<agenda>` | nome ou ID (prefixo) |

```
schedule pause comercial
```

#### `schedule resume`

Retoma a partir do próximo evento.

```
schedule resume <agenda>
```

Também: `retomar`.

| Argumento | Descrição |
| --- | --- |
| `<agenda>` | nome ou ID (prefixo) |

```
schedule resume comercial
```

#### `schedule rm`

Exclui a agenda.

```
schedule rm <agenda> [-y]
```

Também: `excluir`, `remover`.

| Argumento | Descrição |
| --- | --- |
| `<agenda>` | nome ou ID (prefixo) |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `-y, --yes` | — | não pede confirmação |

```
schedule rm comercial
```

#### `schedule runs`

Execuções da agenda, mais recentes primeiro.

```
schedule runs <agenda> [--page <n>]
```

Também: `execucoes`.

| Argumento | Descrição |
| --- | --- |
| `<agenda>` | nome ou ID (prefixo) |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--page <n>` | 1 | página (20 por página) |

```
schedule runs comercial
```

## Cadastro

### `project` — projetos gerenciados

Também: `projeto`, `projects`. Subcomandos: `list`, `discover`, `import`, `add`, `show`, `edit`, `sync`, `rm`.

#### `project list`

Lista os projetos gerenciados.

```
project list
```

Também: `ls`.

```
project list
```

#### `project discover`

Lista os projetos acessíveis pelo token no Railway.

```
project discover
```

Também: `descobrir`.

```
project discover
```

#### `project import`

Importa projetos do Railway (nome ou ID) ou todos os não gerenciados.

```
project import <projeto...> | --all
```

Também: `importar`.

| Argumento | Descrição |
| --- | --- |
| `<projeto...>` (opcional) | nome ou ID Railway |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--all` | — | importa todos os projetos acessíveis ainda não gerenciados |

```
project import --all
project import loja blog
```

#### `project add`

Cadastra um projeto pelo ID Railway.

```
project add <id-railway> [--name <nome>]
```

Também: `cadastrar`.

| Argumento | Descrição |
| --- | --- |
| `<id-railway>` | Railway Project ID |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--name <nome>` | — | nome de exibição |

```
project add 0f3c2a1b-1234-4abc-9def-0123456789ab --name Loja
```

#### `project show`

Detalhes, instâncias e agendas de um projeto.

```
project show <projeto>
```

| Argumento | Descrição |
| --- | --- |
| `<projeto>` | nome ou ID |

```
project show loja
```

#### `project edit`

Altera nome de exibição e descrição (vazio limpa).

```
project edit <projeto> [--name <nome>] [--description <texto>]
```

Também: `editar`.

| Argumento | Descrição |
| --- | --- |
| `<projeto>` | nome ou ID |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--name <nome>` | — | nome de exibição ("" volta ao nome do Railway) |
| `--description <texto>` | — | descrição ("" limpa) |

```
project edit loja --name "Loja virtual"
project edit loja --description ""
```

#### `project sync`

Sincroniza nome, ambientes e estados com o Railway.

```
project sync <projeto...> | --all
```

Também: `sincronizar`.

| Argumento | Descrição |
| --- | --- |
| `<projeto...>` (opcional) | nome ou ID |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--all` | — | sincroniza todos |

```
project sync loja
project sync --all
```

#### `project rm`

Remove o projeto do gerenciamento (nada muda no Railway).

```
project rm <projeto> [-y]
```

Também: `remover`.

| Argumento | Descrição |
| --- | --- |
| `<projeto>` | nome ou ID |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `-y, --yes` | — | não pede confirmação |

```
project rm blog
```

### `instance` — instâncias gerenciadas (serviço × ambiente)

Também: `instancia`, `instances`. Subcomandos: `list`, `discover`, `import`, `add`, `rm`.

#### `instance list`

Lista instâncias gerenciadas com IDs.

```
instance list [seletor...]
```

Também: `ls`.

| Argumento | Descrição |
| --- | --- |
| `<seletor...>` (opcional) | padrão: all |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--env <ambiente>` | — | só um ambiente |
| `--state <estado>` | — | só neste estado |

```
instance list loja
instance list --state failed
```

#### `instance discover`

Lista as instâncias do projeto no Railway e se já são gerenciadas.

```
instance discover <projeto>
```

Também: `descobrir`.

| Argumento | Descrição |
| --- | --- |
| `<projeto>` | nome ou ID |

```
instance discover loja
```

#### `instance import`

Importa instâncias do Railway.

```
instance import <projeto> [serviço@ambiente...] [--all] [--env <ambiente>]
```

Também: `importar`.

| Argumento | Descrição |
| --- | --- |
| `<projeto>` | nome ou ID |
| `<serviço@ambiente...>` (opcional) | aceita * e IDs Railway |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--all` | — | importa todas as não gerenciadas (exceto ambientes efêmeros) |
| `--env <ambiente>` | — | só deste ambiente |

```
instance import loja --all
instance import loja api@production worker@*
instance import loja --all --env staging
```

#### `instance add`

Associa uma instância específica.

```
instance add <projeto> <serviço@ambiente>
```

Também: `associar`.

| Argumento | Descrição |
| --- | --- |
| `<projeto>` | nome ou ID |
| `<serviço@ambiente>` | nomes ou IDs Railway |

```
instance add loja api@pr-7
```

#### `instance rm`

Remove instâncias do gerenciamento (nada muda no Railway).

```
instance rm <seletor...> [-y]
```

Também: `remover`.

| Argumento | Descrição |
| --- | --- |
| `<seletor...>` | instâncias a remover |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--env <ambiente>` | — | só um ambiente |
| `-y, --yes` | — | não pede confirmação |

```
instance rm loja/worker@staging
instance rm loja --env staging -y
```

### `service` — serviços gerenciados

Também: `servico`. Subcomandos: `rm`.

#### `service rm`

Remove o serviço e todas as suas instâncias do gerenciamento.

```
service rm <projeto/serviço> [-y]
```

Também: `remover`.

| Argumento | Descrição |
| --- | --- |
| `<projeto/serviço>` | ex.: loja/worker |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `-y, --yes` | — | não pede confirmação |

```
service rm loja/worker
```

## Configuração

### `credential` — token do Railway

Também: `credencial`, `token`. Subcomandos: `show`, `set`, `rm`.

#### `credential show`

Mostra o token cadastrado (mascarado).

```
credential show
```

```
credential show
```

#### `credential set`

Cadastra ou substitui o token (digitado num campo mascarado).

```
credential set <account|workspace> [--workspace <id>]
```

Também: `definir`.

O token nunca é aceito como argumento e nunca vai para o histórico de comandos.

| Argumento | Descrição |
| --- | --- |
| `<tipo>` | account ou workspace |

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `--workspace <id>` | — | ID do workspace (obrigatório para tokens de workspace) |

```
credential set account
credential set workspace --workspace 0f3c2a1b-…
```

#### `credential rm`

Remove o token.

```
credential rm [-y]
```

Também: `remover`.

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `-y, --yes` | — | não pede confirmação |

```
credential rm
```

## Console

### `help`

Lista os comandos ou mostra a ajuda de um comando.

```
help [comando...]
```

Também: `ajuda`, `?`.

| Argumento | Descrição |
| --- | --- |
| `<comando...>` (opcional) | ex.: stop, project import |

```
help
help stop
ajuda schedule create
```

### `clear`

Limpa a saída (Ctrl+L).

```
clear
```

Também: `limpar`, `cls`.

### `open`

Abre uma tela da interface ou a página de um projeto.

```
open <página|projeto>
```

Também: `abrir`.

| Argumento | Descrição |
| --- | --- |
| `<destino>` | overview, visao, inicio, projects, projetos, schedules, agendas, history, historico, settings, config, console ou nome do projeto |

```
open history
open loja
```

### `alias`

Cria ou lista apelidos (guardados neste navegador).

```
alias [<nome>=<expansão>]
```

Também: `apelido`.

| Argumento | Descrição |
| --- | --- |
| `<definição...>` (opcional) | nome=expansão; sem argumentos, lista |

```
alias
alias fimdodia="stop all --except infra -y"
alias bomdia="start all --env production -y"
```

### `unalias`

Remove um apelido.

```
unalias <nome>
```

| Argumento | Descrição |
| --- | --- |
| `<nome>` | apelido a remover |

```
unalias fimdodia
```

### `logout`

Encerra a sessão.

```
logout
```

Também: `sair`.

## Sessão

### `login`

Entra com a senha do administrador (digitada num campo mascarado). No modo CLI, é o primeiro comando: antes do login só `login`, `ui`, `cli`, `help` e `clear` funcionam.

```
login
```

Também: `entrar`.

### `ui`

Passa para a interface gráfica (a sessão continua a mesma).

```
ui
```

Também: `interface`, `gui`.

### `cli`

Passa para o modo só linha de comando (a sessão continua a mesma).

```
cli
```

Também: `terminal`.
