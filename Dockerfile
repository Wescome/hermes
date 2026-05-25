# ── Stage 0: uv binary ───────────────────────────────────────────────────────
FROM ghcr.io/astral-sh/uv:0.11.6 AS uv_source

# ── Main image ────────────────────────────────────────────────────────────────
# cloudflare/sandbox:0.7.20 matches @cloudflare/sandbox SDK v0.7.20.
# Base: Ubuntu 22.04 LTS (x86_64).
# ENTRYPOINT ["/container-server/sandbox"] is inherited and re-declared below
# to ensure Cloudflare's build pipeline preserves it after our custom layers.
FROM docker.io/cloudflare/sandbox:0.7.20

ENV PYTHONUNBUFFERED=1

# uv binary lives at /uv in ghcr.io/astral-sh/uv images (root of filesystem).
COPY --chmod=0755 --from=uv_source /uv /usr/local/bin/uv

# System dependencies.
# gosu: privilege drop root → hermes in start-hermes.sh.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl \
      ffmpeg gcc git gosu libffi-dev \
      openssh-client procps \
      python3 python3-dev \
      ripgrep tini \
    && rm -rf /var/lib/apt/lists/*

# hermes user — home under /home for Sandbox SDK backup/restore path restriction.
RUN useradd -u 10000 -m -d /home/hermes hermes

WORKDIR /opt/hermes

# ── Python environment ────────────────────────────────────────────────────────
# uv installs Python 3.13 from astral.sh managed builds (Ubuntu 22.04 ships 3.10).
# playwright is omitted — install browsers at runtime via start-hermes.sh if needed.
#
# IMPORTANT: install the managed Python under /opt/python (world-readable) rather
# than the default /root/.local/share/uv/python. The default location is inside
# /root which is mode 700 — the unprivileged `hermes` user (uid 10000) cannot
# traverse it, so the venv's python symlink resolves to an unreachable path and
# every `hermes` / `python` invocation fails with "bad interpreter: Permission
# denied" (exit 126). Pinning the install dir keeps the interpreter accessible
# after gosu drops privileges.
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN uv python install 3.13 && \
    uv venv .venv --python 3.13 && \
    uv pip install --python .venv/bin/python --no-cache \
      'hermes-agent[all,messaging]'

# ── TUI build ─────────────────────────────────────────────────────────────────
# hermes-agent pip wheel ships no prebuilt TUI bundle (_find_bundled_tui()=None).
# Clone the matching tag, build dist/entry.js, and point HERMES_TUI_DIR at it
# so the dashboard /chat PTY tab works in the container.
RUN git clone --depth=1 --branch v2026.5.16 \
      https://github.com/NousResearch/hermes-agent.git /tmp/hermes-src && \
    cd /tmp/hermes-src/ui-tui && \
    npm install --silent --no-fund --no-audit && \
    npm run build && \
    mkdir -p /opt/hermes-tui && \
    cp -r dist /opt/hermes-tui/ && \
    cp package.json /opt/hermes-tui/ && \
    rm -rf /tmp/hermes-src

ENV HERMES_TUI_DIR=/opt/hermes-tui

# ── Startup script ────────────────────────────────────────────────────────────
# The Worker starts this via sandbox.startProcess() — NOT the container ENTRYPOINT.
COPY start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh

# ── Permissions ───────────────────────────────────────────────────────────────
# Make /opt/python and /opt/hermes world-readable+traversable so the unprivileged
# hermes user can resolve symlinks into the managed Python install.
RUN chmod -R a+rX /opt/python /opt/hermes /opt/hermes-tui && \
    chown -R hermes:hermes /opt/hermes/.venv

# ── Runtime environment ───────────────────────────────────────────────────────
ENV PATH="/opt/hermes/.venv/bin:/home/hermes/.local/bin:${PATH}"
ENV HERMES_HOME=/home/hermes
ENV HERMES_WEB_DIST=/opt/hermes/.venv/lib/python3.13/site-packages/hermes_cli/web_dist

# Keep WORKDIR at /container-server (base image default) so the sandbox binary
# can find its relative assets. /home/hermes is used only at runtime by Hermes.
WORKDIR /container-server

EXPOSE 3000
EXPOSE 9119

# Explicitly re-declare ENTRYPOINT — some container registries/runtimes do not
# inherit ENTRYPOINT from multi-stage base images reliably.
ENTRYPOINT ["/container-server/sandbox"]
