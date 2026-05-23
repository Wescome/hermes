#!/bin/bash
# Startup script for Hermes in Cloudflare Sandbox.
#
# Flow:
#   1. Privilege drop via gosu (root → hermes user)
#   2. Bootstrap config.yaml + .env if fresh container
#   3. Patch config.yaml — AI Gateway model, messaging channels, trusted proxies
#   4. Start hermes dashboard on 0.0.0.0:9119 (proxied by the Worker)
#      Optionally start hermes gateway in background for Telegram/Discord/etc.
#
# Persistence (backup/restore) is handled by the Sandbox SDK at the Worker
# level via createBackup() / restoreBackup() — no R2 credentials needed here.
#
# NOTE: Never pass secrets as CLI arguments — they're visible via ps/proc.
# All credentials come from environment variables and are written to config.yaml
# at startup by the Python patcher below.

set -euo pipefail

# Mirror all output of this script to /tmp/hermes-start.log so the Worker can
# read it via `sandbox.exec('cat /tmp/hermes-start.log')` for debugging
# container startup. Only redirect on the *real* run (post-privilege-drop) so
# we don't double-log when this script re-execs itself via gosu.
if [ "$(id -u)" != "0" ] && [ -z "${HERMES_LOG_REDIRECTED:-}" ]; then
    export HERMES_LOG_REDIRECTED=1
    exec > >(tee /tmp/hermes-start.log) 2>&1
fi

HERMES_HOME="${HERMES_HOME:-/home/hermes}"
INSTALL_DIR="/opt/hermes"

# ── Privilege drop ────────────────────────────────────────────────────────────
if [ "$(id -u)" = "0" ]; then
    if [ -n "${HERMES_UID:-}" ] && [ "$HERMES_UID" != "$(id -u hermes)" ]; then
        echo "[hermes] Remapping hermes UID to $HERMES_UID"
        usermod -u "$HERMES_UID" hermes
    fi

    actual_uid=$(id -u hermes)
    if [ "$(stat -c %u "$HERMES_HOME" 2>/dev/null || echo 0)" != "$actual_uid" ]; then
        chown -R hermes:hermes "$HERMES_HOME" 2>/dev/null || \
            echo "[hermes] Warning: chown failed (rootless?) — continuing"
        chown -R hermes:hermes "$INSTALL_DIR/.venv" 2>/dev/null || true
    fi

    echo "[hermes] Dropping to hermes user"
    exec gosu hermes "$0" "$@"
fi

# ── Running as hermes from here ───────────────────────────────────────────────
source "${INSTALL_DIR}/.venv/bin/activate"

echo "[hermes] HERMES_HOME=$HERMES_HOME"
echo "[hermes] Hermes version: $(hermes --version 2>/dev/null || echo unknown)"

# ── Bootstrap config on first boot ───────────────────────────────────────────
mkdir -p "$HERMES_HOME"/{cron,sessions,logs,hooks,memories,skills,skins,plans,workspace,home}

# Stamp install method
echo "docker" > "$HERMES_HOME/.install_method" 2>/dev/null || true

# .env — copy example if absent
if [ ! -f "$HERMES_HOME/.env" ]; then
    if [ -f "$INSTALL_DIR/.venv/lib/python3.13/site-packages/.env.example" ]; then
        cp "$INSTALL_DIR/.venv/lib/python3.13/site-packages/.env.example" "$HERMES_HOME/.env"
    else
        touch "$HERMES_HOME/.env"
    fi
fi

# config.yaml — copy example if absent
if [ ! -f "$HERMES_HOME/config.yaml" ]; then
    if [ -f "$INSTALL_DIR/.venv/lib/python3.13/site-packages/cli-config.yaml.example" ]; then
        cp "$INSTALL_DIR/.venv/lib/python3.13/site-packages/cli-config.yaml.example" \
           "$HERMES_HOME/config.yaml"
    else
        echo "{}" > "$HERMES_HOME/config.yaml"
    fi
fi

# ── Patch Hermes session token (fixed known value) ────────────────────────────
# Hermes generates a random session token per restart. We replace it with a
# fixed value from HERMES_GATEWAY_TOKEN so the Cloudflare Worker can inject it
# into proxied API requests (X-Hermes-Session-Token header).
python3 - <<'EOFTOKEN'
import os, re
from pathlib import Path

fixed_token = os.environ.get("HERMES_GATEWAY_TOKEN", "")
if not fixed_token:
    print("[hermes/token] HERMES_GATEWAY_TOKEN not set, using random session token")
    exit(0)

ws_path = Path("/opt/hermes/.venv/lib/python3.13/site-packages/hermes_cli/web_server.py")
content = ws_path.read_text()
old = "_SESSION_TOKEN = secrets.token_urlsafe(32)"
new = f"_SESSION_TOKEN = os.environ.get('HERMES_GATEWAY_TOKEN', secrets.token_urlsafe(32))"
if old in content:
    ws_path.write_text(content.replace(old, new, 1))
    print(f"[hermes/token] Session token pinned to HERMES_GATEWAY_TOKEN")
else:
    print("[hermes/token] Pattern not found, skipping (already patched?)")
EOFTOKEN

# ── Patch config.yaml ─────────────────────────────────────────────────────────
# Uses Python (already in PATH) to merge Cloudflare-specific settings into
# Hermes's YAML config without clobbering values set by prior runs.
python3 - <<'EOFPATCH'
import os, sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("[hermes/patch] PyYAML not available, skipping config patch", file=sys.stderr)
    sys.exit(0)

config_path = Path(os.environ.get("HERMES_HOME", "/home/hermes")) / "config.yaml"
print(f"[hermes/patch] Patching {config_path}")

config = {}
if config_path.exists():
    with open(config_path) as f:
        config = yaml.safe_load(f) or {}

def deep_set(d, *keys, value):
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value

# ── Trusted proxies (Cloudflare Sandbox networking) ──────────────────────────
# Sandbox containers receive traffic from the Worker via 10.1.0.0.
deep_set(config, "agent", "trusted_proxies", value=["10.1.0.0/8"])

# ── Model provider config ─────────────────────────────────────────────────────
# Hermes valid built-in providers: openrouter, nous, codex, custom.
# Custom endpoints use the providers: section with key_env pointing at an
# env var that holds the actual API key. The env var comes from the Worker
# via startProcess({ env: { ... } }).
gw_model = os.environ.get("CF_AI_GATEWAY_MODEL", "")
account_id = os.environ.get("CF_AI_GATEWAY_ACCOUNT_ID", "")
gateway_id = os.environ.get("CF_AI_GATEWAY_GATEWAY_ID", "")
gw_api_key_env = "CF_AI_GATEWAY_API_KEY"

if gw_model and account_id and gateway_id and os.environ.get("CF_AI_GATEWAY_API_KEY"):
    slash = gw_model.index("/")
    gw_provider = gw_model[:slash]
    model_id = gw_model[slash + 1:]
    base_url = f"https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{gw_provider}/v1"
    config.setdefault("providers", {})
    config["providers"]["cf_gateway"] = {
        "base_url": base_url,
        "key_env": gw_api_key_env,
    }
    config["model"] = {"provider": "cf_gateway", "default": model_id}
    print(f"[hermes/patch] CF AI Gateway: {gw_provider}/{model_id}")
elif os.environ.get("OPENROUTER_API_KEY"):
    # openrouter is a valid built-in provider; the key comes from OPENROUTER_API_KEY env var
    model = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o")
    config["model"] = {"provider": "openrouter", "default": model}
    print(f"[hermes/patch] OpenRouter: {model}")
elif os.environ.get("OFOX_API_KEY"):
    # OFOx is OpenAI-compatible; register as a custom provider using key_env
    model = os.environ.get("OFOX_MODEL", "openai/gpt-4o")
    config.setdefault("providers", {})
    config["providers"]["ofox"] = {
        "base_url": "https://api.ofox.ai/v1",
        "key_env": "OFOX_API_KEY",
    }
    config["model"] = {"provider": "ofox", "default": model}
    print(f"[hermes/patch] OFOx: {model}")

# ── Telegram ──────────────────────────────────────────────────────────────────
if os.environ.get("TELEGRAM_BOT_TOKEN"):
    config.setdefault("telegram", {})
    config["telegram"]["allowed_chats"] = os.environ.get("TELEGRAM_ALLOWED_CHATS", "")
    print("[hermes/patch] Telegram enabled")

# ── Discord ───────────────────────────────────────────────────────────────────
if os.environ.get("DISCORD_BOT_TOKEN"):
    config.setdefault("discord", {})
    config["discord"]["require_mention"] = True
    print("[hermes/patch] Discord enabled")

# ── Slack ─────────────────────────────────────────────────────────────────────
if os.environ.get("SLACK_BOT_TOKEN"):
    config.setdefault("slack", {})
    config["slack"]["require_mention"] = True
    print("[hermes/patch] Slack enabled")

with open(config_path, "w") as f:
    yaml.dump(config, f, default_flow_style=False, allow_unicode=True)

print("[hermes/patch] config.yaml patched successfully")
EOFPATCH

# ── Messaging gateway (background) ────────────────────────────────────────────
# Start gateway after the dashboard is up to avoid port conflicts.
# The gateway and dashboard must listen on different ports; the gateway's
# HTTP server (for webhooks) defaults to 9000, not 9119.
(
    # Wait for dashboard port to be bound before starting gateway
    for i in $(seq 1 30); do
        bash -c "echo >/dev/tcp/localhost/${HERMES_DASHBOARD_PORT:-9119}" 2>/dev/null && break
        sleep 1
    done
    echo "[hermes] Starting gateway (background, dashboard is up)"
    hermes gateway 2>&1 | sed -u 's/^/[gateway] /'
) &

# ── Dashboard (foreground) ────────────────────────────────────────────────────
# Hermes dashboard = web UI + REST API + WebSocket.
# Worker proxies all inbound HTTP/WS to port 9119.
# --insecure is required when binding to 0.0.0.0 (container-internal; the
# Worker + Cloudflare Access provide the actual security boundary).
DASHBOARD_PORT="${HERMES_DASHBOARD_PORT:-9119}"
echo "[hermes] Starting dashboard on 0.0.0.0:${DASHBOARD_PORT}"

# HERMES_DASHBOARD_TUI=1 enables the embedded chat UI in the web dashboard.
# Without it, _DASHBOARD_EMBEDDED_CHAT_ENABLED stays False and the chat input
# never renders. This is the env-var path from web_server.py:start_server().
export HERMES_DASHBOARD_TUI=1

# All output already flows through `tee /tmp/hermes-start.log` thanks to the
# `exec > >(tee ...)` redirect at the top of the script.
exec hermes dashboard \
    --host 0.0.0.0 \
    --port "$DASHBOARD_PORT" \
    --no-open \
    --insecure
