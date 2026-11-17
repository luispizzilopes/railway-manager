#!/usr/bin/env bash
# Verificações do backend: formatação, lints, regra de dependência do domínio e testes.
# Uso: scripts/check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"

step() { printf '\n==> %s\n' "$*"; }

step "cargo fmt"
cargo fmt --all -- --check

step "cargo clippy"
cargo clippy --workspace --all-targets --locked -- -D warnings

step "domain sem dependências de I/O (ADR-001)"
forbidden='^(tokio|sqlx|axum|reqwest|hyper) '
if cargo tree -p domain --edges normal --prefix none --format '{p}' | grep -E "$forbidden"; then
  echo "erro: a crate domain depende de crates de I/O/runtime" >&2
  exit 1
fi

step "cargo test"
cargo test --workspace --locked

if [[ -f "$ROOT/frontend/package.json" ]]; then
  cd "$ROOT/frontend"
  step "frontend: typecheck"
  npm run --silent typecheck
  step "frontend: testes"
  npm run --silent test
  step "frontend: build"
  npm run --silent build
fi

printf '\nOK\n'
