#!/bin/sh
# 扁平 Agent 模式实验验收（隔离测试栈，不影响 compose.yaml 的原容器）。
#
# 用法：
#   export COMPOSE_PROJECT_NAME=vibe-invest-flat-test   # 必须是全新的隔离项目名
#   export MODEL_PROVIDER=... MODEL_API_PROTOCOL=... MODEL_BASE_URL=... MODEL_NAME=... MODEL_CONTEXT_WINDOW=... MODEL_API_KEY=...
#   sh scripts/verify-flat-mode.sh                      # 扁平模式
#   VERIFY_AGENT_MODE=hierarchical sh scripts/verify-flat-mode.sh   # 同标的对照组（需换一个全新项目名）
set -eu

# 只导出验收需要的键，避免 .env 中含空格/括号等非 shell 安全值导致 source 失败。
if [ -f .env ]; then
  while IFS= read -r line; do
    case "$line" in
      MODEL_*=*|SEC_USER_AGENT=*|ALPACA_*=*|POSTGRES_*_PASSWORD=*|MIGRATION_DATABASE_PASSWORD=*|DATABASE_PASSWORD=*)
        export "$line"
        ;;
    esac
  done < .env
fi

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
  echo "run: docker compose -f docker-test.yml -p ${COMPOSE_PROJECT_NAME} down -v" >&2
  exit 2
fi

cleanup() {
  docker compose -f docker-test.yml down >/dev/null
}
trap cleanup EXIT INT TERM

docker compose -f docker-test.yml up --build -d --wait

test -n "$(docker compose -f docker-test.yml ps -q postgres)"
test -n "$(docker compose -f docker-test.yml ps -q financial-data)"
test -n "$(docker compose -f docker-test.yml ps -q analysis-api)"
test -n "$(docker volume inspect -f '{{.Name}}' "$postgres_volume")"

for service_port in 'postgres 5432/tcp' 'financial-data 8000/tcp'; do
  service=${service_port% *}
  port=${service_port#* }
  container=$(docker compose -f docker-test.yml ps -q "$service")
  if docker inspect --format "{{with (index .NetworkSettings.Ports \"$port\")}}{{println .}}{{end}}" "$container" | grep -q .; then
    echo "$service must not publish a host port" >&2
    exit 1
  fi
done

VIBE_INVEST_BASE_URL="http://127.0.0.1:${VIBE_INVEST_TEST_PORT:-3100}" \
  node scripts/verify-flat-mode.mjs
