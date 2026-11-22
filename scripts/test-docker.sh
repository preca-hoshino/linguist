#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:?Usage: $0 <image-tag>}"
WORKDIR="$(mktemp -d)"
NET_NAME="linguist-ci-net-$$-${RANDOM}"
PG_NAME="linguist-pg-$$-${RANDOM}"
MOCK_NAME="linguist-mock-$$-${RANDOM}"
APP_NAME="linguist-app-$$-${RANDOM}"
HOST_PORT="${LINGUIST_TEST_PORT:-19527}"

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "==> Container logs on failure (rc=${rc}):"
    docker logs "$PG_NAME" 2>&1 || true
    docker logs "$APP_NAME" 2>&1 || true
    docker logs "$MOCK_NAME" 2>&1 || true
  fi
  docker rm -f "$APP_NAME" "$MOCK_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> 1. Verifying scratch image filesystem contents for ${IMAGE}"
docker save "$IMAGE" | python3 -c '
import io, json, sys, tarfile
outer = tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode="r:*")
manifest = json.load(outer.extractfile("manifest.json"))
files, dirs = set(), set()
for layer_path in manifest[0]["Layers"]:
    layer_tar = tarfile.open(fileobj=outer.extractfile(layer_path), mode="r:*")
    for m in layer_tar.getmembers():
        name = m.name.lstrip("./")
        if not name:
            continue
        if m.isdir():
            dirs.add(name.rstrip("/"))
        else:
            files.add(name)
print("Image files:", sorted(files))
print("Image dirs:", sorted(dirs))
assert files == {"linguist"}, f"Unexpected files in image: {files}"
assert dirs <= {"config"}, f"Unexpected dirs in image: {dirs}"
'

IMG_USER="$(docker image inspect --format '{{.Config.User}}' "$IMAGE")"
IMG_WORKDIR="$(docker image inspect --format '{{.Config.WorkingDir}}' "$IMAGE")"
IMG_BYTES="$(docker image inspect --format '{{.Size}}' "$IMAGE")"
IMG_MIB="$(python3 -c "print(f'{${IMG_BYTES} / (1024 * 1024):.2f}')")"
echo "==> Image metadata: user=${IMG_USER}, workdir=${IMG_WORKDIR}, size=${IMG_MIB} MiB"
test "$IMG_USER" = "65532:65532"
test "$IMG_WORKDIR" = "/config"

echo "==> 2. Generating test private CA and TLS server certificates"
mkdir -p "$WORKDIR/cfg/certs" "$WORKDIR/cfg/scripts" "$WORKDIR/pg-certs" "$WORKDIR/mock"
chmod 755 "$WORKDIR" "$WORKDIR/cfg" "$WORKDIR/cfg/certs" "$WORKDIR/cfg/scripts"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$WORKDIR/ca.key" -out "$WORKDIR/cfg/certs/ca.crt" \
  -subj "/CN=Linguist-CI-Root-CA" >/dev/null 2>&1

gen_leaf_cert() {
  local name="$1"
  local out_dir="$2"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$out_dir/server.key" -out "$WORKDIR/$name.csr" \
    -subj "/CN=$name" >/dev/null 2>&1
  cat > "$WORKDIR/$name.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$name
EOF
  openssl x509 -req -in "$WORKDIR/$name.csr" \
    -CA "$WORKDIR/cfg/certs/ca.crt" -CAkey "$WORKDIR/ca.key" -CAcreateserial \
    -out "$out_dir/server.crt" -days 2 -extfile "$WORKDIR/$name.ext" >/dev/null 2>&1
}

gen_leaf_cert "linguist-pg" "$WORKDIR/pg-certs"
gen_leaf_cert "linguist-mock" "$WORKDIR/mock"
cp "$WORKDIR/cfg/certs/ca.crt" "$WORKDIR/pg-certs/ca.crt"
chmod 644 "$WORKDIR/cfg/certs/ca.crt" "$WORKDIR/pg-certs/server.crt" "$WORKDIR/pg-certs/ca.crt" "$WORKDIR/mock/server.crt"
chmod 644 "$WORKDIR/pg-certs/server.key" "$WORKDIR/mock/server.key"

echo "==> 3. Preparing read-only /config fixture (with @file script)"
cat > "$WORKDIR/cfg/scripts/tag.js" <<'EOF'
ctx.request.headers['x-ci-script'] = 'ok';
EOF

cat > "$WORKDIR/cfg/chatLanguageModels.json" <<'EOF'
[
  {
    "id": "mock-tls",
    "name": "Mock TLS Provider",
    "apiKey": "sk-ci-mock",
    "script": "@file:scripts/tag.js",
    "models": [
      {
        "id": "mock-model",
        "name": "Mock Model",
        "url": "https://linguist-mock:8443",
        "toolCalling": true,
        "vision": false,
        "thinking": false,
        "streaming": true,
        "maxInputTokens": 65536,
        "maxOutputTokens": 8192
      }
    ]
  },
  {
    "id": "public-https",
    "name": "Public HTTPS Probe",
    "apiKey": "sk-ci-public",
    "models": [
      {
        "id": "pub-tls-probe",
        "name": "Public TLS Probe",
        "url": "https://api.github.com",
        "streaming": false
      }
    ]
  }
]
EOF

cat > "$WORKDIR/cfg/projects.json" <<'EOF'
[
  {
    "id": "coding",
    "name": "CI Coding Project",
    "apiKey": "lin-proj-coding-secret",
    "callModels": [
      {
        "id": "smart-coder",
        "name": "Smart Coder"
      },
      {
        "id": "pub-tls-probe",
        "name": "Public TLS Probe"
      }
    ]
  }
]
EOF

cat > "$WORKDIR/cfg/routes.json" <<'EOF'
[
  {
    "id": "coding-mock",
    "name": "Route Coding to Mock TLS",
    "enabled": true,
    "priority": 100,
    "match": {
      "projectIds": ["coding"],
      "callModelIds": ["smart-coder"]
    },
    "rewriteResponseModel": true,
    "target": { "providerId": "mock-tls", "modelId": "mock-model" }
  },
  {
    "id": "coding-public-tls",
    "name": "Route Public TLS Probe",
    "enabled": true,
    "priority": 90,
    "match": {
      "projectIds": ["coding"],
      "callModelIds": ["pub-tls-probe"]
    },
    "rewriteResponseModel": false,
    "target": { "providerId": "public-https", "modelId": "pub-tls-probe" }
  }
]
EOF

write_config_toml() {
  local db_url="$1"
  cat > "$WORKDIR/cfg/config.toml" <<EOF
[server]
host = "0.0.0.0"
port = 9527
upstream_timeout_secs = 30

[database]
url = "${db_url}"
max_connections = 5
log_error_payload = true
log_full_payload = false

[configs]
source = "json_files"
providers_path = "./chatLanguageModels.json"
projects_path = "./projects.json"
routes_path = "./routes.json"
watch_reload = false

[script_engine]
timeout_ms = 50
memory_limit_mb = 32
fallback_status_codes = [429, 500, 502, 503, 504]

[metrics]
sliding_window_minutes = 60
warmup_days_from_db = 7

[ui]
title = "Linguist CI"
timezone = "Asia/Shanghai"
default_days_range = 30
leaderboard_min_requests = 1
EOF
  chmod 644 "$WORKDIR/cfg/config.toml"
}

chmod 644 "$WORKDIR/cfg/scripts/tag.js" "$WORKDIR/cfg/chatLanguageModels.json" "$WORKDIR/cfg/projects.json" "$WORKDIR/cfg/routes.json"
write_config_toml "postgres://linguist:linguistpass@linguist-pg:5432/linguist?sslmode=verify-full&sslrootcert=/config/certs/ca.crt"

echo "==> 4. Verifying unified check-config CLI behavior inside read-only container"
CHECK_OUT="$(docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v "$WORKDIR/cfg:/config:ro" \
  "$IMAGE" check-config)"
echo "$CHECK_OUT"
echo "$CHECK_OUT" | grep -q "Config OK"

echo "==> 5. Starting external TLS PostgreSQL and HTTPS mock upstream containers"
docker network create "$NET_NAME" >/dev/null

docker run -d --name "$PG_NAME" --network "$NET_NAME" --network-alias linguist-pg \
  -e POSTGRES_USER=linguist \
  -e POSTGRES_PASSWORD=linguistpass \
  -e POSTGRES_DB=linguist \
  -v "$WORKDIR/pg-certs:/certs:ro" \
  postgres:17-alpine \
  sh -c 'cp /certs/server.key /tmp/server.key && chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key -c ssl_ca_file=/certs/ca.crt' >/dev/null

pg_ready=0
for _ in $(seq 1 45); do
  if docker exec "$PG_NAME" env PGPASSWORD=linguistpass psql -h 127.0.0.1 -U linguist -d linguist -c "SELECT 1" >/dev/null 2>&1; then
    pg_ready=1
    break
  fi
  sleep 1
done
test "$pg_ready" = "1"

cat > "$WORKDIR/mock/server.py" <<'PY'
import http.server, json, ssl

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        payload = json.loads(raw or b"{}")
        assert self.headers.get("x-ci-script") == "ok", f"missing x-ci-script: {self.headers}"
        if payload.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            chunks = [
                'data: {"id":"cmpl-1","model":"mock-model","choices":[{"index":0,"delta":{"content":"Hello "}}]}\n\n',
                'data: {"id":"cmpl-1","model":"mock-model","choices":[{"index":0,"delta":{"content":"TLS!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
                'data: [DONE]\n\n',
            ]
            for c in chunks:
                data = c.encode("utf-8")
                self.wfile.write(f"{len(data):x}\r\n".encode("ascii") + data + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        else:
            body = json.dumps({
                "id": "cmpl-1",
                "object": "chat.completion",
                "model": "mock-model",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok-from-tls-mock"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 6, "completion_tokens": 3, "total_tokens": 9},
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()

    def log_message(self, format, *args):
        pass

httpd = http.server.HTTPServer(("0.0.0.0", 8443), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/mock/server.crt", "/mock/server.key")
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
httpd.serve_forever()
PY
chmod 644 "$WORKDIR/mock/server.py"

docker run -d --name "$MOCK_NAME" --network "$NET_NAME" --network-alias linguist-mock \
  -v "$WORKDIR/mock:/mock:ro" \
  python:3.12-alpine python /mock/server.py >/dev/null
sleep 1

wait_healthz() {
  for _ in $(seq 1 30); do
    if body="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null)"; then
      if echo "$body" | grep -q '"database":"ok"'; then
        return 0
      fi
    fi
    sleep 1
  done
  docker logs "$APP_NAME" || true
  return 1
}

echo "==> 6. Phase A: pure scratch without SSL_CERT_FILE (public HTTPS webpki + PG sslrootcert)"
docker run -d --name "$APP_NAME" --network "$NET_NAME" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v "$WORKDIR/cfg:/config:ro" \
  -p "127.0.0.1:${HOST_PORT}:9527" \
  "$IMAGE" >/dev/null

wait_healthz
IDLE_MEM="$(docker stats --no-stream --format '{{.MemUsage}}' "$APP_NAME")"
echo "==> Idle memory: ${IDLE_MEM}"

curl -fsS "http://127.0.0.1:${HOST_PORT}/" | grep -qi "<html"
curl -fsS "http://127.0.0.1:${HOST_PORT}/icons/deepseek-color.svg" | grep -q "<svg"
curl -fsS "http://127.0.0.1:${HOST_PORT}/icons/doubao-color.svg" | grep -q "Doubao"
curl -fsS "http://127.0.0.1:${HOST_PORT}/icons/lobehub.svg" | grep -q "<svg"

UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/model/coding/v1/models")"
test "$UNAUTH_CODE" = "401"
MODELS_JSON="$(curl -fsS -H "Authorization: Bearer lin-proj-coding-secret" "http://127.0.0.1:${HOST_PORT}/model/coding/v1/models")"
echo "$MODELS_JSON" | grep -q '"smart-coder"'

PUB_STATUS="$(curl -s -o "$WORKDIR/pub_resp.txt" -w '%{http_code}' \
  -X POST "http://127.0.0.1:${HOST_PORT}/model/coding/v1/chat/completions" \
  -H "Authorization: Bearer lin-proj-coding-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"pub-tls-probe","messages":[{"role":"user","content":"ping"}]}')"
echo "==> Public HTTPS probe HTTP status: ${PUB_STATUS}"
if [ "$PUB_STATUS" = "502" ]; then
  cat "$WORKDIR/pub_resp.txt"
  exit 1
fi

docker rm -f "$APP_NAME" >/dev/null

echo "==> 7. Phase B: recreated container with SSL_CERT_FILE (private CA for both PG and upstream HTTPS)"
write_config_toml "postgres://linguist:linguistpass@linguist-pg:5432/linguist?sslmode=verify-full"

docker run -d --name "$APP_NAME" --network "$NET_NAME" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -e SSL_CERT_FILE=/config/certs/ca.crt \
  -v "$WORKDIR/cfg:/config:ro" \
  -p "127.0.0.1:${HOST_PORT}:9527" \
  "$IMAGE" >/dev/null

wait_healthz

NON_STREAM_RESP="$(curl -fsS -X POST "http://127.0.0.1:${HOST_PORT}/model/coding/v1/chat/completions" \
  -H "Authorization: Bearer lin-proj-coding-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"smart-coder","stream":false,"messages":[{"role":"user","content":"hi"}]}')"
echo "$NON_STREAM_RESP" | grep -q '"ok-from-tls-mock"'
echo "$NON_STREAM_RESP" | grep -q '"model":"smart-coder"'

STREAM_RESP="$(curl -fsSN -X POST "http://127.0.0.1:${HOST_PORT}/model/coding/v1/chat/completions" \
  -H "Authorization: Bearer lin-proj-coding-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"smart-coder","stream":true,"messages":[{"role":"user","content":"hi"}]}')"
echo "$STREAM_RESP" | grep -q 'TLS!'
echo "$STREAM_RESP" | grep -q '"model":"smart-coder"'

LOAD_MEM="$(docker stats --no-stream --format '{{.MemUsage}}' "$APP_NAME")"
echo "==> Light-load memory: ${LOAD_MEM}"

sleep 1
docker rm -f "$APP_NAME" >/dev/null

echo "==> 8. Phase C: verifying external DB persistence across container replacement"
docker run -d --name "$APP_NAME" --network "$NET_NAME" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -e SSL_CERT_FILE=/config/certs/ca.crt \
  -v "$WORKDIR/cfg:/config:ro" \
  -p "127.0.0.1:${HOST_PORT}:9527" \
  "$IMAGE" >/dev/null

wait_healthz
OVERVIEW_JSON="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/api/v1/stats/overview")"
python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
total = data["summary"]["totalRequests"]
print("Persisted totalRequests:", total)
assert total >= 2, f"Expected >= 2 persisted requests, got {total}"
' <<< "$OVERVIEW_JSON"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Container Verification (${IMAGE})"
    echo "- Image size: **${IMG_MIB} MiB**"
    echo "- Idle memory: \`${IDLE_MEM}\`"
    echo "- Light-load memory: \`${LOAD_MEM}\`"
    echo "- Verified: pure scratch layout, non-root \`65532:65532\`, \`check-config\`, public HTTPS (\`webpki-roots\`), private CA (\`SSL_CERT_FILE\` + \`sslrootcert\`), external PG TLS migrations, normal + SSE mock upstream, persistence across recreate."
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "==> ALL DOCKER CONTAINER CHECKS PASSED"
