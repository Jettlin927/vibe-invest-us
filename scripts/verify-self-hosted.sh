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
printf '%s' "$health" | grep -q '"financialData":{"service":"financial-data","status":"ok"}'

curl -fsS http://127.0.0.1:${VIBE_INVEST_PORT:-3000}/ | grep -q '<div id="root"></div>'

settings="$(curl -fsS http://127.0.0.1:${VIBE_INVEST_PORT:-3000}/api/settings)"
printf '%s' "$settings" | grep -q '"model"'
if printf '%s' "$settings" | grep -q 'MODEL_API_KEY'; then
  echo "settings endpoint exposed a credential name" >&2
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

docker compose exec -T analysis-api test -f /data/vibe-invest.db

echo "self-hosted verification passed"
