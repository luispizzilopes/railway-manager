## Purpose

Define a identidade visual, o sistema de design e os padrões de experiência de uso aplicados de forma consistente a todas as telas e componentes do frontend, para que a aplicação seja clara, acessível e confiável na operação de infraestrutura.

## ADDED Requirements

### Requirement: Identidade visual sóbria
A interface SHALL usar superfícies planas separadas por linhas finas, uma única cor de destaque para ações e foco, e cor semântica reservada exclusivamente para indicar estado (sucesso, atenção, falha, informação). A interface MUST NOT usar brilhos, sombras coloridas, gradientes decorativos, texto em gradiente, animações pulsantes contínuas nem rótulos em caixa-alta com espaçamento ampliado.

#### Scenario: Cor só significa estado
- **WHEN** uma tela exibe elementos de ação e elementos de estado
- **THEN** ações usam a cor de destaque ou neutros, e verde, âmbar e vermelho aparecem apenas em indicadores de estado e alertas

#### Scenario: Sem decoração animada
- **WHEN** a interface está em repouso
- **THEN** nenhum elemento anima continuamente; animações existem apenas em transições curtas de entrada e saída

### Requirement: Fonte monoespaçada apenas para dados
A interface SHALL usar fonte monoespaçada somente para dados técnicos (nomes de serviço, identificadores, valores numéricos tabulares, horários e saída do console) e fonte proporcional para texto de interface.

#### Scenario: Números alinhados
- **WHEN** uma tabela exibe colunas numéricas
- **THEN** os valores usam algarismos tabulares alinhados à direita

### Requirement: Temas claro e escuro
A interface SHALL oferecer tema claro e escuro, seguir a preferência do sistema por padrão e permitir ao administrador escolher manualmente, lembrando a escolha entre sessões. Ambos os temas MUST atender ao contraste mínimo WCAG AA para texto e componentes.

#### Scenario: Preferência do sistema
- **WHEN** o administrador abre a aplicação sem escolha manual e o sistema operacional está em modo claro
- **THEN** a interface é exibida no tema claro

#### Scenario: Escolha manual persistente
- **WHEN** o administrador escolhe o tema escuro e recarrega a página
- **THEN** o tema escuro continua aplicado, sem piscar o tema errado durante o carregamento

### Requirement: Componentes base compartilhados
Todas as telas SHALL ser compostas a partir de um conjunto único de componentes base (botão, campo, seleção, tabela, indicador de estado, abas, diálogo, aviso, estado vazio e esqueleto de carregamento), com variantes e estados (padrão, foco, desabilitado, carregando, erro) definidos uma só vez.

#### Scenario: Consistência entre telas
- **WHEN** duas telas diferentes exibem uma ação primária ou um indicador de estado
- **THEN** ambas usam o mesmo componente, com a mesma aparência e o mesmo comportamento

### Requirement: Estado nunca só por cor
Todo indicador de estado SHALL combinar cor com texto e forma (ícone ou marcador distinto), de modo que seja distinguível sem percepção de cor.

#### Scenario: Falha reconhecível sem cor
- **WHEN** um serviço está com falha
- **THEN** o indicador mostra o texto "Com falha" e um ícone próprio, além da cor

### Requirement: Estados de carregamento, vazio e erro
Toda lista, tabela e painel que depende de dados remotos SHALL exibir esqueleto durante o carregamento, uma mensagem com próxima ação quando vazio e uma mensagem de erro com opção de tentar novamente quando a leitura falha.

#### Scenario: Lista vazia
- **WHEN** não há projetos gerenciados
- **THEN** a tela explica a situação e oferece a ação de importar projetos

#### Scenario: Falha de leitura
- **WHEN** a leitura de uma tela falha
- **THEN** a tela mostra o erro em linguagem clara e um botão para tentar novamente, mantendo os dados anteriores quando existirem

### Requirement: Feedback imediato de ações
A interface SHALL confirmar o resultado de ações do administrador com aviso temporário não bloqueante (sucesso ou erro) e MUST manter o botão acionado em estado de carregamento enquanto a ação está em andamento, impedindo envio duplicado.

#### Scenario: Ação concluída
- **WHEN** o administrador salva uma configuração com sucesso
- **THEN** um aviso de sucesso aparece e some sozinho, sem exigir clique

### Requirement: Confirmação de ações destrutivas
Ações que desligam serviços, removem recursos ou apagam credenciais SHALL abrir confirmação que declara explicitamente o que será afetado e usar a variante de perigo no botão de confirmação.

#### Scenario: Desligar vários serviços
- **WHEN** o administrador aciona o desligamento de um projeto
- **THEN** o diálogo lista os serviços afetados e o botão de confirmação usa a variante de perigo

### Requirement: Navegação por teclado
Todas as funções SHALL ser operáveis por teclado, com indicador de foco sempre visível, ordem de tabulação lógica, diálogos que prendem e devolvem o foco e fechamento por Esc. A interface SHALL oferecer uma paleta de comandos aberta por Ctrl+K para navegar entre telas e acionar o console.

#### Scenario: Paleta de comandos
- **WHEN** o administrador pressiona Ctrl+K em qualquer tela
- **THEN** a paleta abre com foco no campo de busca e permite ir a uma tela digitando parte do nome

#### Scenario: Diálogo e foco
- **WHEN** um diálogo é aberto e depois fechado com Esc
- **THEN** o foco retorna ao elemento que o abriu

### Requirement: Responsividade e movimento reduzido
A interface SHALL ser utilizável de 360 px a telas largas, sem rolagem horizontal da página, com alvos de toque de pelo menos 40 px em telas sensíveis ao toque, e SHALL respeitar a preferência de movimento reduzido removendo transições não essenciais.

#### Scenario: Celular
- **WHEN** a aplicação é aberta com 360 px de largura
- **THEN** a navegação, as tabelas e os formulários permanecem utilizáveis sem rolagem horizontal da página

#### Scenario: Movimento reduzido
- **WHEN** o sistema operacional indica preferência por movimento reduzido
- **THEN** transições e animações não essenciais são desativadas

### Requirement: Linguagem consistente
Os textos da interface SHALL estar em português do Brasil, usar vocabulário único para o mesmo conceito (por exemplo "serviço", "projeto", "agenda") e ser curtos e diretos, com mensagens de erro que dizem o que aconteceu e o que fazer.

#### Scenario: Mesmo termo em todo lugar
- **WHEN** um serviço é citado em telas diferentes
- **THEN** é sempre chamado de "serviço", nunca alternando com sinônimos
