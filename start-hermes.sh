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

# ── AI Gateway model override ─────────────────────────────────────────────────
# CF_AI_GATEWAY_MODEL=<openrouter|anthropic|...>/<model-id>
# Routes Hermes's LLM calls through Cloudflare AI Gateway for
# analytics, caching, and rate-limit visibility.
gw_model = os.environ.get("CF_AI_GATEWAY_MODEL", "")
account_id = os.environ.get("CF_AI_GATEWAY_ACCOUNT_ID", "")
gateway_id = os.environ.get("CF_AI_GATEWAY_GATEWAY_ID", "")
gw_api_key = os.environ.get("CF_AI_GATEWAY_API_KEY", "")

if gw_model and account_id and gateway_id and gw_api_key:
    slash = gw_model.index("/")
    gw_provider = gw_model[:slash]
    model_id = gw_model[slash + 1:]
    base_url = f"https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{gw_provider}"
    config.setdefault("model", {})
    config["model"]["default"] = model_id
    config["model"]["provider"] = "openai"  # AI Gateway is OpenAI-compatible
    config["model"]["base_url"] = f"{base_url}/v1"
    config["model"]["api_key"] = gw_api_key
    print(f"[hermes/patch] AI Gateway: {gw_provider}/{model_id} via {base_url}")
elif os.environ.get("OPENROUTER_API_KEY"):
    # Fall back to direct OpenRouter if no AI Gateway configured
    config.setdefault("model", {})
    config["model"]["provider"] = "openrouter"
    config["model"]["base_url"] = "https://openrouter.ai/api/v1"
    model = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o")
    config["model"]["default"] = model
    print(f"[hermes/patch] OpenRouter fallback: {model}")

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
# Start hermes gateway to handle Telegram/Discord/Slack webhooks.
# The Cloudflare Worker proxies webhook requests from the public URL to the
# container; Hermes receives them here and routes to the right platform adapter.
if [ -n "${TELEGRAM_BOT_TOKEN:-}${DISCORD_BOT_TOKEN:-}${SLACK_BOT_TOKEN:-}" ]; then
    echo "[hermes] Starting messaging gateway (background)"
    (
        hermes gateway 2>&1 | sed -u 's/^/[gateway] /'
    ) &
fi

# ── Dashboard (foreground) ────────────────────────────────────────────────────
# Hermes dashboard = web UI + REST API + WebSocket.
# Worker proxies all inbound HTTP/WS to port 9119.
# --insecure is required when binding to 0.0.0.0 (container-internal; the
# Worker + Cloudflare Access provide the actual security boundary).
DASHBOARD_PORT="${HERMES_DASHBOARD_PORT:-9119}"
echo "[hermes] Starting dashboard on 0.0.0.0:${DASHBOARD_PORT}"

exec hermes dashboard \
    --host 0.0.0.0 \
    --port "$DASHBOARD_PORT" \
    --no-open \
    --insecure
