# internationalization Specification

## Purpose
Permite usar a interface do Railway Manager em português (pt-BR) ou inglês, com todo texto visível vindo de catálogos de tradução e exibido conforme o idioma escolhido pelo usuário.

## Requirements

### Requirement: Idiomas suportados e seleção
O sistema SHALL oferecer a interface em `pt-BR` e `en`, e MUST permitir que o usuário troque o idioma a qualquer momento, em qualquer tela (inclusive login), sem recarregar a página. A troca MUST atualizar imediatamente todos os textos visíveis.

#### Scenario: Troca de idioma
- **WHEN** o usuário seleciona "English" no seletor de idioma
- **THEN** menus, páginas, botões, diálogos e rótulos passam a ser exibidos em inglês sem recarregar a página

#### Scenario: Seletor disponível sem sessão
- **WHEN** o usuário está na tela de login
- **THEN** o seletor de idioma está disponível e a tela de login é exibida no idioma escolhido

### Requirement: Idioma inicial e persistência
O sistema SHALL persistir a escolha de idioma no navegador e reaplicá-la nas visitas seguintes. Sem escolha salva, o sistema MUST usar o idioma do navegador quando for `pt-BR` ou `en` (qualquer variante `pt`/`en`) e `pt-BR` nos demais casos. O atributo `lang` do documento MUST refletir o idioma ativo.

#### Scenario: Escolha persistida
- **WHEN** o usuário escolhe inglês e recarrega a página
- **THEN** a interface abre em inglês

#### Scenario: Navegador em inglês sem escolha salva
- **WHEN** o usuário abre o sistema pela primeira vez com navegador configurado em `en-US`
- **THEN** a interface é exibida em inglês

#### Scenario: Idioma não suportado
- **WHEN** o usuário abre o sistema pela primeira vez com navegador em `fr-FR`
- **THEN** a interface é exibida em `pt-BR`

### Requirement: Nenhum texto fixo na interface
Todo texto visível ao usuário — conteúdo de páginas e componentes, toasts, diálogos de confirmação, placeholders, títulos, `aria-label`s, mensagens de validação e estados vazios/de carregamento/de erro — SHALL ser obtido dos catálogos de tradução. O sistema MUST NOT conter texto de usuário escrito diretamente em componentes. Os catálogos `pt-BR` e `en` MUST ter exatamente o mesmo conjunto de chaves.

#### Scenario: Toast no idioma ativo
- **WHEN** o usuário executa uma ação que mostra um toast de sucesso com a interface em inglês
- **THEN** o toast é exibido em inglês

#### Scenario: Chave faltando em um idioma
- **WHEN** uma chave existe em `pt-BR` mas não em `en` (ou o inverso)
- **THEN** a verificação automatizada do projeto falha apontando a chave

#### Scenario: Texto fixo em componente
- **WHEN** um componente contém texto literal de usuário em JSX fora dos catálogos
- **THEN** a verificação automatizada do projeto falha apontando o arquivo

### Requirement: Formatação conforme o idioma
Datas, horas, dias da semana, tempos relativos, durações, números e listas SHALL ser formatados conforme o idioma ativo. Rótulos de estado (ex.: ativo, desligado, falhou) MUST ser traduzidos.

#### Scenario: Data em inglês
- **WHEN** a interface está em inglês e exibe um horário de operação
- **THEN** data e hora seguem a formatação do locale inglês e o tempo relativo aparece como "5 min ago"

#### Scenario: Data em português
- **WHEN** a interface está em `pt-BR` e exibe o mesmo horário
- **THEN** a data segue a formatação `pt-BR` e o tempo relativo aparece como "há 5 min"

### Requirement: Erros da API traduzidos
O sistema SHALL exibir erros retornados pela API no idioma ativo, traduzindo pelo `code` do erro. Para um `code` sem tradução, o sistema MUST exibir a `message` recebida do backend; sem `message`, uma mensagem genérica traduzida.

#### Scenario: Erro com código conhecido
- **WHEN** a API responde erro com `code` que possui tradução e a interface está em inglês
- **THEN** o toast ou aviso exibe a mensagem em inglês

#### Scenario: Erro com código desconhecido
- **WHEN** a API responde erro com `code` sem tradução
- **THEN** o texto exibido é a `message` enviada pelo backend

### Requirement: Console no idioma ativo
Descrições de comandos, ajuda, saídas, mensagens de erro e dicas do console SHALL ser exibidas no idioma ativo. Nomes de comandos, subcomandos e opções MUST permanecer iguais em todos os idiomas.

#### Scenario: Ajuda do console em inglês
- **WHEN** a interface está em inglês e o usuário executa `help`
- **THEN** as descrições são exibidas em inglês e os nomes dos comandos permanecem inalterados

#### Scenario: Mesmo comando em ambos os idiomas
- **WHEN** o usuário executa o mesmo comando com a interface em `pt-BR` e em `en`
- **THEN** a execução é idêntica e só os textos exibidos diferem
