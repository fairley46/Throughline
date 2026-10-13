#!/usr/bin/env bash
set -euo pipefail

HOST="${THROUGHLINE_HOST:-127.0.0.1}"
PORT="${THROUGHLINE_PORT:-4317}"
TOKEN="${THROUGHLINE_ACCESS_TOKEN:-verifytoken}"
BASE="http://${HOST}:${PORT}"

code_shell=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/?token=${TOKEN}")
code_model=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/model.json?token=${TOKEN}")
code_denied=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/model.json")

echo "shell=${code_shell} model=${code_model} denied=${code_denied}"

test "${code_shell}" = "200"
test "${code_model}" = "200"
test "${code_denied}" = "403"

echo "doctor: ok"
