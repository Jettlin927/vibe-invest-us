#!/bin/sh
set -eu

if [ -z "${MODEL_PROVIDER:-}" ] || [ -z "${MODEL_API_PROTOCOL:-}" ] || [ -z "${MODEL_BASE_URL:-}" ] || [ -z "${MODEL_NAME:-}" ] || [ -z "${MODEL_CONTEXT_WINDOW:-}" ] || [ -z "${MODEL_API_KEY:-}" ]; then
  echo "MODEL_PROVIDER, MODEL_API_PROTOCOL, MODEL_BASE_URL, MODEL_NAME, MODEL_CONTEXT_WINDOW and MODEL_API_KEY are required" >&2
  exit 2
fi

case "${COMPOSE_PROJECT_NAME:-}" in
  ''|vibe-invest-us|vibeinvestus)
    echo "COMPOSE_PROJECT_NAME must name a fresh isolated project" >&2
    exit 2
    ;;
esac

postgres_volume="${COMPOSE_PROJECT_NAME}_vibe-invest-postgres"
if docker volume inspect "$postgres_volume" >/dev/null 2>&1; then
  echo "refusing to reuse existing PostgreSQL volume: $postgres_volume" >&2
  exit 2
fi

cleanup() {
  docker compose down >/dev/null
}
trap cleanup EXIT INT TERM

docker compose up --build -d --wait

test -n "$(docker compose ps -q postgres)"
test -n "$(docker compose ps -q financial-data)"
test -n "$(docker compose ps -q analysis-api)"
test -n "$(docker volume inspect -f '{{.Name}}' "$postgres_volume")"

for service_port in 'postgres 5432/tcp' 'financial-data 8000/tcp'; do
  service=${service_port% *}
  port=${service_port#* }
  container=$(docker compose ps -q "$service")
  if docker inspect --format "{{with (index .NetworkSettings.Ports \"$port\")}}{{println .}}{{end}}" "$container" | grep -q .; then
    echo "$service must not publish a host port" >&2
    exit 1
  fi
done

VIBE_INVEST_BASE_URL="http://127.0.0.1:${VIBE_INVEST_PORT:-3000}" \
  node scripts/verify-real-analysis.mjs
