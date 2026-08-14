#!/bin/sh
set -eu

cleanup() {
  docker compose down >/dev/null
}
trap cleanup EXIT INT TERM

docker compose config >/dev/null
docker compose build
docker compose up -d --wait

health="$(curl -fsS http://127.0.0.1:${VIBE_INVEST_PORT:-3000}/api/health)"
printf '%s' "$health" | grep -q '"service":"analysis-api"'
printf '%s' "$health" | grep -q '"engine":"postgresql"'
printf '%s' "$health" | grep -q '"financialData":{"service":"financial-data","status":"ok"}'

curl -fsS http://127.0.0.1:${VIBE_INVEST_PORT:-3000}/ | grep -q '<div id="root"></div>'

settings="$(curl -fsS http://127.0.0.1:${VIBE_INVEST_PORT:-3000}/api/settings)"
printf '%s' "$settings" | grep -q '"model"'
if printf '%s' "$settings" | grep -q 'MODEL_API_KEY'; then
  echo "settings endpoint exposed a credential name" >&2
  exit 1
fi

ACCESS_LOG_SENTINEL="private-tool-argument-must-not-enter-logs"
docker compose exec -T financial-data python - "$ACCESS_LOG_SENTINEL" <<'PY'
import sys
import urllib.parse
import urllib.request

query = urllib.parse.urlencode({'tool_argument': sys.argv[1]})
with urllib.request.urlopen(f'http://127.0.0.1:8000/health?{query}', timeout=10) as response:
    assert response.status == 200
PY
if docker compose logs --no-color financial-data analysis-api | grep -Fq "$ACCESS_LOG_SENTINEL"; then
  echo "ordinary container logs exposed a tool argument" >&2
  exit 1
fi

docker compose exec -T financial-data python - <<'PY'
import json
import urllib.request

request = urllib.request.Request(
    'http://127.0.0.1:8000/v1/quotes',
    data=json.dumps(['NVDA']).encode(),
    headers={'Content-Type': 'application/json'},
)
payload = json.load(urllib.request.urlopen(request, timeout=30))
assert payload['quotes'][0]['symbol'] == 'NVDA'
assert len(payload['quotes'][0]['sources']) == 3
PY

financial_data_container="$(docker compose ps -q financial-data)"
if docker inspect --format '{{with (index .NetworkSettings.Ports "8000/tcp")}}{{println .}}{{end}}' "$financial_data_container" | grep -q .; then
  echo "financial-data must not publish a host port" >&2
  exit 1
fi

postgres_container="$(docker compose ps -q postgres)"
if docker inspect --format '{{with (index .NetworkSettings.Ports "5432/tcp")}}{{println .}}{{end}}' "$postgres_container" | grep -q .; then
  echo "postgres must not publish a host port by default" >&2
  exit 1
fi

echo "self-hosted verification passed"
