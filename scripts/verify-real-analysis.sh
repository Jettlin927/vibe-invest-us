#!/bin/sh
set -eu

if [ -z "${MODEL_PROVIDER:-}" ] || [ -z "${MODEL_API_PROTOCOL:-}" ] || [ -z "${MODEL_BASE_URL:-}" ] || [ -z "${MODEL_NAME:-}" ] || [ -z "${MODEL_API_KEY:-}" ]; then
  echo "MODEL_PROVIDER, MODEL_API_PROTOCOL, MODEL_BASE_URL, MODEL_NAME and MODEL_API_KEY are required" >&2
  exit 2
fi

cleanup() {
  docker compose down >/dev/null
}
trap cleanup EXIT INT TERM

docker compose up --build -d --wait

base_url="http://127.0.0.1:${VIBE_INVEST_PORT:-3000}"
created="$(curl -fsS -X POST -H 'content-type: application/json' -d '{"symbol":"NVDA"}' "$base_url/api/analyses")"
analysis_id="$(printf '%s' "$created" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).analysisId??''))")"
test -n "$analysis_id"

attempt=0
while [ "$attempt" -lt 300 ]; do
  analysis="$(curl -fsS "$base_url/api/analyses/$analysis_id")"
  status="$(printf '%s' "$analysis" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).status??''))")"
  case "$status" in
    completed|partial) break ;;
    failed|cancelled|interrupted)
      printf '%s' "$analysis" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const v=JSON.parse(s);console.error(JSON.stringify({id:v.id,status:v.status,error:v.error}))})"
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$attempt" -ge 300 ]; then
  echo "real analysis timed out" >&2
  exit 1
fi

research="$(curl -fsS "$base_url/api/research/$analysis_id")"
printf '%s' "$research" | grep -q '"report"'
printf '%s' "$research" | grep -q '"keyJudgments"'
printf '%s' "$research" | grep -q '"facts"'
printf '%s' "$research" | grep -q '"trace"'

echo "real provider analysis verification passed: $analysis_id ($status)"
