# ADR-001: Camadas e Cargo workspace com crates por camada

- **Status:** aceito
- **Data:** 2026-11-16
- **Relacionado:** `openspec/changes/railway-manager/design.md` (Decisão 3)

## Contexto

O Railway Manager precisa de regras de negócio (estado observado, decisão de
desligar/iniciar, máquina de estados das operações) que sejam testáveis sem rede,
banco ou servidor HTTP, e que sobrevivam à troca de adaptadores (por exemplo,
SQLite → Postgres, ou um agendador futuro chamando os mesmos casos de uso).

Uma separação em camadas apenas por convenção de módulos não impede que o domínio
passe a importar `sqlx` ou `reqwest` com o tempo. Queremos que a regra de
dependência seja verificada pelo compilador.

## Decisão

O backend é um Cargo workspace em `backend/` com cinco crates:

```
backend/crates/domain          entidades, value objects, estados e regras puras
backend/crates/application     casos de uso e traits de porta (RailwayGateway,
                               repositórios, Clock, CredentialCipher)
backend/crates/infrastructure  adaptadores: Railway (graphql_client + reqwest),
                               SQLite (sqlx), criptografia, rate limiter
backend/crates/api             Axum: rotas, DTOs, extractors, sessão, erros HTTP
backend/crates/server          binário: configuração, wiring, migrações,
                               serviço do frontend estático
```

Direção das dependências (somente para baixo):

```
server ──► api ──► application ──► domain
   │                    ▲
   └──► infrastructure ─┘
```

- `domain` não depende de nenhuma crate de I/O ou runtime: **sem** `tokio`, `sqlx`,
  `axum`, `reqwest`.
- `application` depende só de `domain` e define as portas como traits; não conhece
  SQLite, HTTP nem o Railway concreto.
- `infrastructure` implementa as portas de `application`.
- `api` traduz HTTP ↔ casos de uso e não acessa `infrastructure` diretamente.
- `server` é o único ponto que conhece todas as crates e faz a composição.

Não haverá crate por agregado: cinco crates é o mínimo que torna a regra verificável.

## Alternativas consideradas

- **Crate única com módulos por camada** — mais simples de compilar, mas a regra de
  dependência vira convenção e se perde silenciosamente.
- **Crate por agregado/feature** — granularidade maior que o necessário para uma
  ferramenta de um administrador; aumenta o custo de build e de manutenção sem ganho.

## Consequências

- Testes de domínio e de casos de uso rodam com fakes, sem rede nem banco.
- Trocar o banco ou adicionar um agendador não altera `domain` nem `application`.
- Verificação: `cargo tree -p domain` não pode listar `tokio`, `sqlx`, `axum` ou
  `reqwest`; o script `scripts/check.sh` executa essa checagem.
- Custo: tipos precisam ser mapeados entre camadas (DTO ↔ domínio ↔ linha do banco).
