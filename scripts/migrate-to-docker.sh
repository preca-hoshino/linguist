#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Linguist: Host systemd binary (/opt/linguist) -> Docker Compose (/docker/linguist)
# Verified against ARTS-CN-PKX-01 layout (/docker/<service>/docker-compose.yml)
# ==============================================================================

SOURCE_DIR="${1:-/opt/linguist}"
TARGET_DIR="${2:-/docker/linguist}"
SERVICE_NAME="${3:-linguist.service}"
BACKUP_DIR="${SOURCE_DIR}_backup_$(date +%Y%m%d_%H%M%S)"

if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

echo "===> 1. Checking Docker & Docker Compose..."
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "[ERROR] Docker or Docker Compose V2 is not available!" >&2
  exit 1
fi

echo "===> 2. Backing up ${SOURCE_DIR} -> ${BACKUP_DIR}..."
if [ -d "${SOURCE_DIR}" ]; then
  $SUDO cp -a "${SOURCE_DIR}" "${BACKUP_DIR}"
  echo "Backup created: ${BACKUP_DIR}"
else
  echo "[ERROR] Source directory ${SOURCE_DIR} not found!" >&2
  exit 1
fi

echo "===> 3. Stopping and disabling systemd service (${SERVICE_NAME})..."
if $SUDO systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
  $SUDO systemctl stop "${SERVICE_NAME}"
fi
if $SUDO systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
  $SUDO systemctl disable "${SERVICE_NAME}"
fi
echo "Systemd service stopped and disabled."

echo "===> 4. Creating ${TARGET_DIR} layout..."
$SUDO mkdir -p "${TARGET_DIR}/config" "${TARGET_DIR}/examples"
$SUDO chmod 755 "${TARGET_DIR}" "${TARGET_DIR}/config" "${TARGET_DIR}/examples"

for f in config.toml linguist.d.ts; do
  if [ -f "${SOURCE_DIR}/${f}" ]; then
    echo "Copying ${SOURCE_DIR}/${f} -> ${TARGET_DIR}/config/${f}"
    $SUDO cp -a "${SOURCE_DIR}/${f}" "${TARGET_DIR}/config/${f}"
  fi
done

for ex in config.example.toml config.docker.example.toml linguist.d.ts; do
  if [ -f "${SOURCE_DIR}/${ex}" ]; then
    $SUDO cp -a "${SOURCE_DIR}/${ex}" "${TARGET_DIR}/examples/${ex}"
  fi
done

if [ -d "${SOURCE_DIR}/scripts" ] && [ ! -d "${TARGET_DIR}/config/scripts" ]; then
  $SUDO cp -a "${SOURCE_DIR}/scripts" "${TARGET_DIR}/config/scripts"
fi

echo "===> 5. Adapting ${TARGET_DIR}/config/config.toml for container..."
CONFIG_FILE="${TARGET_DIR}/config/config.toml"
USE_1PANEL_NET=false
if docker network inspect 1panel-network >/dev/null 2>&1; then
  USE_1PANEL_NET=true
fi

if [ -f "${CONFIG_FILE}" ]; then
  if grep -q 'host = "127.0.0.1"' "${CONFIG_FILE}"; then
    echo "Updating [server].host from 127.0.0.1 to 0.0.0.0..."
    $SUDO sed -i 's/host = "127.0.0.1"/host = "0.0.0.0"/' "${CONFIG_FILE}"
  fi

  if grep -qE 'postgres://[^@]+@127\.0\.0\.1:5432' "${CONFIG_FILE}"; then
    if [ "${USE_1PANEL_NET}" = "true" ]; then
      echo "Detected 1panel-network: updating database host 127.0.0.1 -> postgresql..."
      $SUDO sed -i 's#@127\.0\.0\.1:5432#@postgresql:5432#g' "${CONFIG_FILE}"
    else
      echo "Updating database host 127.0.0.1 -> host.docker.internal..."
      $SUDO sed -i 's#@127\.0\.0\.1:5432#@host.docker.internal:5432#g' "${CONFIG_FILE}"
    fi
  fi
fi

echo "===> 6. Setting read permissions for container user (UID 65532)..."
$SUDO chmod -R a+rX "${TARGET_DIR}/config"

echo "===> 7. Writing ${TARGET_DIR}/.env and ${TARGET_DIR}/docker-compose.yml..."
if [ ! -f "${TARGET_DIR}/.env" ]; then
  echo "LINGUIST_TAG=latest" | $SUDO tee "${TARGET_DIR}/.env" >/dev/null
  $SUDO chmod 600 "${TARGET_DIR}/.env"
fi

if [ ! -f "${TARGET_DIR}/docker-compose.yml" ]; then
  if [ "${USE_1PANEL_NET}" = "true" ]; then
    $SUDO tee "${TARGET_DIR}/docker-compose.yml" >/dev/null << 'YAML'
# ==============================================================================
# Linguist — 可编程路由 OpenAI Chat API 网关与 Token 统计看板
# ==============================================================================
# 用法:
#   docker compose run --rm linguist check-config
#   docker compose up -d
#   docker compose logs -f linguist
# ==============================================================================

services:
  linguist:
    image: ghcr.io/preca-hoshino/linguist:${LINGUIST_TAG:-latest}
    container_name: ARTS-CCIN-linguist
    restart: unless-stopped
    environment:
      LINGUIST_CATALOG_KEY: ${LINGUIST_CATALOG_KEY:-}
      LINGUIST_OIDC_ADMIN_SUB: ${LINGUIST_OIDC_ADMIN_SUB:-}
    # ─── 端口映射（仅监听本机回环，由 OpenResty 反代暴露）───
    ports:
      - "127.0.0.1:9527:9527"
    networks:
      - 1panel-network
    # ─── 容器运行安全加固 ───
    user: "65532:65532"
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    # ─── 配置挂载与宿主机时区 / CA 证书同步 ───
    volumes:
      - ./config:/config:ro
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
      - /etc/ssl/certs:/etc/ssl/certs:ro
      - /usr/local/share/ca-certificates:/usr/local/share/ca-certificates:ro
    # ─── 资源限制与日志轮转 ───
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 256M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  1panel-network:
    external: true
YAML
  else
    $SUDO tee "${TARGET_DIR}/docker-compose.yml" >/dev/null << 'YAML'
# ==============================================================================
# Linguist — 可编程路由 OpenAI Chat API 网关与 Token 统计看板
# ==============================================================================
# 用法:
#   docker compose run --rm linguist check-config
#   docker compose up -d
#   docker compose logs -f linguist
# ==============================================================================

services:
  linguist:
    image: ghcr.io/preca-hoshino/linguist:${LINGUIST_TAG:-latest}
    container_name: linguist
    restart: unless-stopped
    environment:
      LINGUIST_CATALOG_KEY: ${LINGUIST_CATALOG_KEY:-}
      LINGUIST_OIDC_ADMIN_SUB: ${LINGUIST_OIDC_ADMIN_SUB:-}
    ports:
      - "127.0.0.1:9527:9527"
    user: "65532:65532"
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m
    volumes:
      - ./config:/config:ro
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
      - /etc/ssl/certs:/etc/ssl/certs:ro
      - /usr/local/share/ca-certificates:/usr/local/share/ca-certificates:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 256M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
YAML
  fi
  $SUDO chmod 600 "${TARGET_DIR}/docker-compose.yml"
fi

echo "=============================================================================="
echo "Migration preparations complete at ${TARGET_DIR}!"
echo "Next steps:"
echo "  1. Check ${TARGET_DIR}/docker-compose.yml (ports binding, network, limits)"
echo "  2. Check ${TARGET_DIR}/config/config.toml (database URL & server host)"
echo "  3. Set LINGUIST_CATALOG_KEY and LINGUIST_OIDC_ADMIN_SUB in ${TARGET_DIR}/.env. Reuse the existing LINGUIST_CATALOG_KEY if the database already has a catalog."
echo "     For a new catalog, generate the key with 'openssl rand -hex 32'. Configure [oidc] in config.toml and place the client secret at /config/secrets/oidc-client-secret."
echo "     If using an existing Compose file, pass both variables through to the container."
echo "  4. Validate config (offline in JSON mode):"
echo "     cd ${TARGET_DIR} && docker compose pull && docker compose run --rm linguist check-config"
echo "  5. Start container:"
echo "     cd ${TARGET_DIR} && docker compose up -d"
echo "  6. Verify health:"
echo "     curl -fsS http://127.0.0.1:9527/healthz"
echo "=============================================================================="
