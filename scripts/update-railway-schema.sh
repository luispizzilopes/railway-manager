#!/usr/bin/env bash
# Regenera o snapshot do schema da API pública do Railway por introspecção.
# A saída é normalizada (chaves e listas ordenadas) para que o diff só mostre
# mudanças reais do schema.
#
# Uso: scripts/update-railway-schema.sh [arquivo-de-saida]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENDPOINT="${RM_RAILWAY_API_URL:-https://backboard.railway.com/graphql/v2}"
OUT="${1:-$ROOT/backend/crates/infrastructure/graphql/railway.schema.json}"

for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "erro: '$bin' não encontrado" >&2; exit 1; }
done

read -r -d '' QUERY <<'GQL' || true
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name description locations args { ...InputValue } }
  }
}
fragment FullType on __Type {
  kind name description
  fields(includeDeprecated: true) {
    name description args { ...InputValue } type { ...TypeRef }
    isDeprecated deprecationReason
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue }
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name
    ofType { kind name ofType { kind name ofType { kind name } } } } } } }
}
GQL

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl --fail --silent --show-error --max-time 60 \
  -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg q "$QUERY" '{query: $q}')" \
  -o "$TMP"

if jq -e '.errors // empty | length > 0' "$TMP" >/dev/null; then
  echo "erro: introspecção retornou errors:" >&2
  jq '.errors' "$TMP" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
# Ordena tipos, campos, argumentos, enums e diretivas por nome.
jq --sort-keys '
  def byname: if type == "array" then sort_by(.name) else . end;
  .data.__schema |= (
    .types |= (byname | map(
      .fields |= (byname | if . then map(.args |= byname) else . end)
      | .inputFields |= byname
      | .enumValues |= byname
      | .interfaces |= byname
      | .possibleTypes |= byname
    ))
    | .directives |= (byname | map(.args |= byname))
  )
' "$TMP" > "$OUT"

echo "schema salvo em ${OUT#$ROOT/} ($(jq '.data.__schema.types | length' "$OUT") tipos)"
