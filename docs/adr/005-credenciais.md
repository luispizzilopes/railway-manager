# ADR-005: Armazenamento e uso da credencial Railway

- **Status:** aceito
- **Data:** 2026-11-16
- **Relacionado:** `design.md` (Decisões 9 e 10), specs `railway-credentials`, `app-access`

## Contexto

O Manager guarda um token capaz de desligar infraestrutura. O token precisa ser
cadastrado e trocado pela interface, sobreviver a reinícios e nunca vazar (API, logs,
histórico, banco lido por terceiros).

## Decisão

- **Cifra em repouso:** XChaCha20-Poly1305 (`chacha20poly1305`), chave de 32 bytes em
  `RM_MASTER_KEY` (base64), nonce aleatório de 192 bits por gravação, o ID da credencial
  como dado associado (o ciphertext não pode ser movido para outra linha) e
  `key_version` para rotação futura.
- **Validação antes de salvar:** token de conta via `me`, de workspace via
  `workspace(workspaceId)`. Recusa → 422 e nada é salvo; Railway indisponível → 503.
  Tokens de projeto são recusados explicitamente.
- **Uma credencial por vez:** substituir grava a nova, reatribui os projetos e apaga a
  anterior numa transação. Remover apaga o valor cifrado; projetos e histórico ficam
  (`credential_id` → `NULL`), e as chamadas ao Railway passam a responder
  "integração não configurada".
- **Chave ausente ou errada:** o servidor sobe sem integração; a credencial é marcada
  `undecipherable` sem apagar o dado. Se a chave correta voltar, ela volta a `valid`.
  Chave **malformada** (não base64 ou ≠ 32 bytes) impede a inicialização.
- **Na memória:** `RailwayToken` sobre `secrecy::SecretString`, com `Debug` redigido;
  o texto decifrado é zerado (`zeroize`) após o uso. DTOs de saída não têm o campo: só
  tipo, rótulo, os 4 últimos caracteres, situação e datas.
- **Falha de autenticação em uso:** qualquer 401/403 ou erro GraphQL de autorização
  marca a credencial `invalid`, o que aparece como alerta na visão geral.
- **Acesso à aplicação:** senha de administrador por `RM_ADMIN_PASSWORD_HASH` (argon2;
  `railway-manager hash-password`) ou `RM_ADMIN_PASSWORD` (dev). Sessão por cookie opaco
  `HttpOnly`, `SameSite=Strict`, `Secure` configurável; o banco guarda só o SHA-256 do
  ID. Limite de tentativas em janela deslizante. Mutações exigem `Content-Type:
  application/json` (mitigação de CSRF junto com `SameSite=Strict`).

## Alternativas consideradas

- **Keychain do sistema** — indisponível num container no Railway.
- **Token só em variável de ambiente** — impede cadastrar/substituir pela interface.
- **AES-GCM** — equivalente, mas o nonce de 96 bits exige mais cuidado com nonces
  aleatórios; XChaCha20 elimina o risco prático de colisão.

## Consequências

- Perder `RM_MASTER_KEY` exige recadastrar o token (recuperável no Railway); nenhum
  dado local se perde.
- Testes provam que o token não aparece em respostas HTTP, logs de `tracing` (inclusive
  em nível `trace`) nem nos bytes do arquivo SQLite/WAL.
