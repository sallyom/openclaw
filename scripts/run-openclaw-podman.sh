#!/usr/bin/env bash
# Rootless OpenClaw in Podman: run after one-time setup.
#
# One-time setup (from repo root): ./scripts/podman/setup.sh
# Then:
#   ~/.local/bin/run-openclaw-podman.sh launch        # Start gateway
#   ~/.local/bin/run-openclaw-podman.sh launch setup  # Onboarding wizard
#
# Manage the running container from the host CLI:
#   openclaw --container openclaw dashboard --no-open
#   openclaw --container openclaw channels login
#
# Legacy: "setup-host" delegates to the Podman setup script

set -euo pipefail

resolve_user_home() {
  local user="$1"
  local home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [[ -z "$home" && -f /etc/passwd ]]; then
    home="$(awk -F: -v u="$user" '$1==u {print $6}' /etc/passwd 2>/dev/null || true)"
  fi
  if [[ -z "$home" ]]; then
    home="/home/$user"
  fi
  printf '%s' "$home"
}

fail() {
  echo "$*" >&2
  exit 1
}

validate_single_line_value() {
  local label="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    fail "Invalid $label: control characters are not allowed."
  fi
}

validate_absolute_path() {
  local label="$1"
  local value="$2"
  validate_single_line_value "$label" "$value"
  [[ "$value" == /* ]] || fail "Invalid $label: expected an absolute path."
  [[ "$value" != *"//"* ]] || fail "Invalid $label: repeated slashes are not allowed."
  [[ "$value" != *"/./"* && "$value" != */. && "$value" != *"/../"* && "$value" != */.. ]] ||
    fail "Invalid $label: dot path segments are not allowed."
}

ensure_safe_existing_regular_file() {
  local label="$1"
  local file="$2"
  validate_absolute_path "$label" "$file"
  [[ -e "$file" ]] || fail "Missing $label: $file"
  [[ ! -L "$file" ]] || fail "Unsafe $label: symlinks are not allowed ($file)"
  [[ -f "$file" ]] || fail "Unsafe $label: expected a regular file ($file)"
}

ensure_safe_existing_dir() {
  local label="$1"
  local dir="$2"
  validate_absolute_path "$label" "$dir"
  [[ -d "$dir" ]] || fail "Missing $label: $dir"
  [[ ! -L "$dir" ]] || fail "Unsafe $label: symlinks are not allowed ($dir)"
}

ensure_safe_write_file_path() {
  local label="$1"
  local file="$2"
  local dir
  validate_absolute_path "$label" "$file"
  if [[ -e "$file" ]]; then
    [[ ! -L "$file" ]] || fail "Unsafe $label: symlinks are not allowed ($file)"
    [[ -f "$file" ]] || fail "Unsafe $label: expected a regular file ($file)"
  fi
  dir="$(dirname "$file")"
  ensure_safe_existing_dir "${label} parent directory" "$dir"
}

load_podman_env_file() {
  local file="$1"
  local line=""
  local key=""
  local value=""
  local trimmed=""
  ensure_safe_existing_regular_file "Podman env file" "$file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    case "$key" in
      OPENCLAW_GATEWAY_TOKEN|OPENCLAW_PODMAN_CONTAINER|OPENCLAW_PODMAN_IMAGE|OPENCLAW_IMAGE|OPENCLAW_PODMAN_PULL|OPENCLAW_PODMAN_GATEWAY_HOST_PORT|OPENCLAW_GATEWAY_PORT|OPENCLAW_PODMAN_BRIDGE_HOST_PORT|OPENCLAW_BRIDGE_PORT|OPENCLAW_GATEWAY_BIND|OPENCLAW_PODMAN_USERNS|OPENCLAW_BIND_MOUNT_OPTIONS)
        ;;
      *)
        continue
        ;;
    esac
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done <"$file"
}

load_launcher_state_file() {
  local file="$1"
  local line=""
  local key=""
  local value=""
  local trimmed=""
  ensure_safe_existing_regular_file "Podman launcher state file" "$file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    case "$key" in
      OPENCLAW_CONFIG_DIR|OPENCLAW_WORKSPACE_DIR|OPENCLAW_PODMAN_ENV)
        ;;
      *)
        continue
        ;;
    esac
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done <"$file"
}

EFFECTIVE_USER="$(id -un)"
EFFECTIVE_HOME="${HOME:-}"
if [[ -z "$EFFECTIVE_HOME" ]]; then
  EFFECTIVE_HOME="$(resolve_user_home "$EFFECTIVE_USER")"
fi
if [[ "$(id -u)" -eq 0 ]]; then
  fail "Run run-openclaw-podman.sh as your normal user so Podman stays rootless."
fi

# Legacy: setup-host -> run the Podman setup script
if [[ "${1:-}" == "setup-host" ]]; then
  shift
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  SETUP_PODMAN="$REPO_ROOT/scripts/podman/setup.sh"
  if [[ -f "$SETUP_PODMAN" ]]; then
    exec "$SETUP_PODMAN" "$@"
  fi
  SETUP_PODMAN="$REPO_ROOT/setup-podman.sh"
  if [[ -f "$SETUP_PODMAN" ]]; then
    exec "$SETUP_PODMAN" "$@"
  fi
  echo "Podman setup script not found. Run from repo root: ./scripts/podman/setup.sh" >&2
  exit 1
fi

if [[ "${1:-}" == "launch" ]]; then
  shift
fi

if [[ -z "${EFFECTIVE_HOME:-}" ]]; then
  EFFECTIVE_HOME="/tmp"
fi
validate_absolute_path "effective home" "$EFFECTIVE_HOME"

LAUNCHER_STATE_FILE="${EFFECTIVE_HOME}/.config/openclaw/podman-launcher.env"
if [[ -z "${OPENCLAW_CONFIG_DIR:-}" && -z "${OPENCLAW_WORKSPACE_DIR:-}" && -z "${OPENCLAW_PODMAN_ENV:-}" ]] && [[ -f "$LAUNCHER_STATE_FILE" ]]; then
  load_launcher_state_file "$LAUNCHER_STATE_FILE"
fi

CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$EFFECTIVE_HOME/.openclaw}"
ENV_FILE="${OPENCLAW_PODMAN_ENV:-$CONFIG_DIR/.env}"
# Bootstrap `.env` may set runtime/container options, but it must not
# relocate the config/workspace/env paths mid-run. Those path overrides are
# only honored from the parent process environment before bootstrap.
if [[ -f "$ENV_FILE" ]]; then
  load_podman_env_file "$ENV_FILE"
fi

CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$EFFECTIVE_HOME/.openclaw}"
ENV_FILE="${OPENCLAW_PODMAN_ENV:-$CONFIG_DIR/.env}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$CONFIG_DIR/workspace}"
CONTAINER_NAME="${OPENCLAW_PODMAN_CONTAINER:-openclaw}"
OPENCLAW_IMAGE="${OPENCLAW_PODMAN_IMAGE:-${OPENCLAW_IMAGE:-openclaw:local}}"
PODMAN_PULL="${OPENCLAW_PODMAN_PULL:-never}"
HOST_GATEWAY_PORT="${OPENCLAW_PODMAN_GATEWAY_HOST_PORT:-${OPENCLAW_GATEWAY_PORT:-18789}}"
HOST_BRIDGE_PORT="${OPENCLAW_PODMAN_BRIDGE_HOST_PORT:-${OPENCLAW_BRIDGE_PORT:-18790}}"
validate_absolute_path "config directory" "$CONFIG_DIR"
validate_absolute_path "workspace directory" "$WORKSPACE_DIR"
validate_absolute_path "env file path" "$ENV_FILE"
validate_single_line_value "container name" "$CONTAINER_NAME"
validate_single_line_value "image name" "$OPENCLAW_IMAGE"

cd "$EFFECTIVE_HOME" 2>/dev/null || cd /tmp 2>/dev/null || true

RUN_SETUP=false
if [[ "${1:-}" == "setup" || "${1:-}" == "onboard" ]]; then
  RUN_SETUP=true
  shift
fi

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR"
mkdir -p "$CONFIG_DIR/canvas" "$CONFIG_DIR/cron"
ensure_safe_existing_dir "config directory" "$CONFIG_DIR"
ensure_safe_existing_dir "workspace directory" "$WORKSPACE_DIR"
chmod 700 "$CONFIG_DIR" "$WORKSPACE_DIR" 2>/dev/null || true

# Keep Podman default local-only unless explicitly overridden.
GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  local dir
  ensure_safe_write_file_path "env file" "$file"
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.env.tmp.XXXXXX")"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { found = 0 }
      $0 ~ ("^" k "=") { print k "=" v; found = 1; next }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

generate_token_hex_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return 0
  fi
  if command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d " \n"
    return 0
  fi
  echo "Missing dependency: need openssl or python3 (or od) to generate OPENCLAW_GATEWAY_TOKEN." >&2
  exit 1
}

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$(generate_token_hex_32)"
  mkdir -p "$(dirname "$ENV_FILE")"
  ensure_safe_existing_dir "env file directory" "$(dirname "$ENV_FILE")"
  upsert_env_var "$ENV_FILE" "OPENCLAW_GATEWAY_TOKEN" "$OPENCLAW_GATEWAY_TOKEN"
  echo "Generated OPENCLAW_GATEWAY_TOKEN and wrote it to $ENV_FILE." >&2
fi

CONFIG_JSON="$CONFIG_DIR/openclaw.json"
if [[ ! -f "$CONFIG_JSON" ]]; then
  ensure_safe_existing_dir "config directory" "$CONFIG_DIR"
  ensure_safe_write_file_path "config file" "$CONFIG_JSON"
  echo '{ "gateway": { "mode": "local" } }' >"$CONFIG_JSON"
  chmod 600 "$CONFIG_JSON" 2>/dev/null || true
  echo "Created $CONFIG_JSON (minimal gateway.mode=local)." >&2
fi

PODMAN_USERNS="${OPENCLAW_PODMAN_USERNS:-keep-id}"
USERNS_ARGS=()
RUN_USER_ARGS=()
case "$PODMAN_USERNS" in
  ""|auto) ;;
  keep-id) USERNS_ARGS=(--userns=keep-id) ;;
  host) USERNS_ARGS=(--userns=host) ;;
  *)
    echo "Unsupported OPENCLAW_PODMAN_USERNS=$PODMAN_USERNS (expected: keep-id, auto, host)." >&2
    exit 2
    ;;
esac

RUN_UID="$(id -u)"
RUN_GID="$(id -g)"
if [[ "$PODMAN_USERNS" == "keep-id" ]]; then
  RUN_USER_ARGS=(--user "${RUN_UID}:${RUN_GID}")
  echo "Starting container as uid=${RUN_UID} gid=${RUN_GID} (must match owner of $CONFIG_DIR)" >&2
else
  echo "Starting container without --user (OPENCLAW_PODMAN_USERNS=$PODMAN_USERNS), mounts may require ownership fixes." >&2
fi

ENV_FILE_ARGS=()
[[ -f "$ENV_FILE" ]] && ENV_FILE_ARGS+=(--env-file "$ENV_FILE")

SELINUX_MOUNT_OPTS=""
if [[ -z "${OPENCLAW_BIND_MOUNT_OPTIONS:-}" ]]; then
  if [[ "$(uname -s 2>/dev/null)" == "Linux" ]] && command -v getenforce >/dev/null 2>&1; then
    _selinux_mode="$(getenforce 2>/dev/null || true)"
    if [[ "$_selinux_mode" == "Enforcing" || "$_selinux_mode" == "Permissive" ]]; then
      SELINUX_MOUNT_OPTS=",Z"
    fi
  fi
else
  SELINUX_MOUNT_OPTS="${OPENCLAW_BIND_MOUNT_OPTIONS#:}"
  [[ -n "$SELINUX_MOUNT_OPTS" ]] && SELINUX_MOUNT_OPTS=",$SELINUX_MOUNT_OPTS"
fi

if [[ "$RUN_SETUP" == true ]]; then
  exec podman run --pull="$PODMAN_PULL" --rm -it \
    --init \
    "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
    -e HOME=/home/node -e TERM=xterm-256color -e BROWSER=echo \
    -e NPM_CONFIG_CACHE=/home/node/.openclaw/.npm \
    -e NPM_CONFIG_PREFIX=/home/node/.openclaw/.npm-global \
    -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/node/.openclaw/.npm-global/bin \
    -e OPENCLAW_NO_RESPAWN=1 \
    -e OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
    -v "$CONFIG_DIR:/home/node/.openclaw:rw${SELINUX_MOUNT_OPTS}" \
    -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw${SELINUX_MOUNT_OPTS}" \
    "${ENV_FILE_ARGS[@]}" \
    "$OPENCLAW_IMAGE" \
    node dist/index.js onboard "$@"
fi

podman run --pull="$PODMAN_PULL" -d --replace \
  --name "$CONTAINER_NAME" \
  --init \
  "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
  -e HOME=/home/node -e TERM=xterm-256color \
  -e NPM_CONFIG_CACHE=/home/node/.openclaw/.npm \
  -e NPM_CONFIG_PREFIX=/home/node/.openclaw/.npm-global \
  -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/node/.openclaw/.npm-global/bin \
  -e OPENCLAW_NO_RESPAWN=1 \
  -e OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
  "${ENV_FILE_ARGS[@]}" \
  -v "$CONFIG_DIR:/home/node/.openclaw:rw${SELINUX_MOUNT_OPTS}" \
  -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw${SELINUX_MOUNT_OPTS}" \
  -p "${HOST_GATEWAY_PORT}:18789" \
  -p "${HOST_BRIDGE_PORT}:18790" \
  "$OPENCLAW_IMAGE" \
  node dist/index.js gateway --bind "$GATEWAY_BIND" --port 18789

echo "Container $CONTAINER_NAME started. Dashboard: http://127.0.0.1:${HOST_GATEWAY_PORT}/"
echo "Host CLI: openclaw --container $CONTAINER_NAME dashboard --no-open"
echo "Logs: podman logs -f $CONTAINER_NAME"
echo "For auto-start/restarts, use: ./scripts/podman/setup.sh --quadlet (Quadlet + systemd user service)."
