# ── Stage 0: tool binaries ───────────────────────────────────────────────────
FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie AS uv_source
FROM tianon/gosu:1.19-trixie AS gosu_source

# ── Main image ────────────────────────────────────────────────────────────────
# debian:13.4 (Trixie) ships Python 3.13 in-repos, matching Hermes upstream.
FROM debian:13.4

ENV PYTHONUNBUFFERED=1

# Playwright browsers live at a path that the R2 FUSE overlay can't shadow.
# The overlay mounts at /home/hermes; anything outside it survives restores.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

COPY --chmod=0755 --from=gosu_source /gosu /usr/local/bin/gosu
COPY --chmod=0755 --from=uv_source /usr/local/bin/uv /usr/local/bin/uv

# System dependencies.
# nodejs is required by Playwright (browser automation).
# tini reaps zombie subprocesses when running as PID 1.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl \
      ffmpeg gcc git libffi-dev \
      nodejs npm \
      openssh-client procps python3 python3-dev \
      ripgrep tini \
    && rm -rf /var/lib/apt/lists/*

# hermes user with home under /home — required by the Cloudflare Sandbox SDK
# backup/restore API, which only permits paths under /home, /workspace,
# /tmp, or /var/tmp. /opt/data (Hermes upstream default) is not allowed.
RUN useradd -u 10000 -m -d /home/hermes hermes

WORKDIR /opt/hermes

# ── Python environment ────────────────────────────────────────────────────────
# Create a dedicated venv and install Hermes from PyPI.
# [all,messaging] pulls in every platform adapter (Telegram, Discord, Slack,
# WhatsApp, Signal, etc.) plus all optional feature deps.
# The PyPI wheel includes pre-built web_dist and tui_dist assets, so no
# npm build step is needed here.
RUN uv venv .venv --python python3.13 && \
    uv pip install --python .venv/bin/python --no-cache \
      'hermes-agent[all,messaging]' playwright

# ── Playwright browsers ───────────────────────────────────────────────────────
RUN .venv/bin/playwright install --with-deps chromium

# ── Startup script ────────────────────────────────────────────────────────────
COPY start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh

# ── Permissions ───────────────────────────────────────────────────────────────
# World-readable so any HERMES_UID remapping can read the install.
# .venv must stay hermes-writable for lazy_deps.py to install platform
# packages at first boot (discord.py, etc.).
RUN chmod -R a+rX /opt/hermes && \
    chown -R hermes:hermes /opt/hermes/.venv

# ── Runtime environment ───────────────────────────────────────────────────────
ENV PATH="/opt/hermes/.venv/bin:/home/hermes/.local/bin:${PATH}"
# HERMES_HOME under /home so Sandbox SDK R2 mount covers all persistent state.
ENV HERMES_HOME=/home/hermes
# Point Hermes at its venv-installed web assets.
ENV HERMES_WEB_DIST=/opt/hermes/.venv/lib/python3.13/site-packages/hermes_cli/web_dist

WORKDIR /home/hermes

# Hermes dashboard (web UI + API). The Worker proxies all inbound requests here.
EXPOSE 9119

# tini as PID 1 reaps orphaned zombies; start-hermes.sh handles config +
# privilege drop before exec-ing hermes.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/start-hermes.sh"]
