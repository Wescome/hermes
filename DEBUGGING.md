# Hermes Cloudflare Sandbox — Debugging Log

## Problem History & Fixes

### Fix 1: uv binary path wrong
**Symptom**: Docker build failed.  
**Cause**: `COPY --from=uv_source /usr/local/bin/uv` — that path doesn't exist in `ghcr.io/astral-sh/uv`. The binary is at `/uv` (root of the image).  
**Fix**: `COPY --chmod=0755 --from=uv_source /uv /usr/local/bin/uv`

---

### Fix 2: ENTRYPOINT not inherited in cloud
**Symptom**: Port 3000 (Sandbox SDK control plane) never came up in cloud, even though local Docker tests passed. All SDK calls (exec, startProcess, listProcesses) timed out or hung.  
**Cause**: WORKDIR was overridden to `/home/hermes`, and ENTRYPOINT was only inherited (not declared). Some Cloudflare registry/runtime configs don't reliably preserve inherited ENTRYPOINT metadata from multi-stage base images.  
**Fix**:
```dockerfile
WORKDIR /container-server  # must match base image default
ENTRYPOINT ["/container-server/sandbox"]  # explicitly re-declare
```

---

### Fix 3: startProcess canceled from Worker waitUntil (ROOT CAUSE of port 9119 never opening)
**Symptom**: Port 3000 worked. `startProcess` was being called (logs: `[gateway] Starting Hermes`, `[gateway] Hermes process launched`). But port 9119 never opened, even after 80+ seconds. DO logs showed `startProcess outcome: "canceled"`.  
**Cause**: `startProcess('/usr/local/bin/start-hermes.sh')` was called from `ctx.waitUntil(ensureHermes(...))` in the Worker. The Worker's RPC connection to the Durable Object gets canceled when the HTTP response is sent — this is a fundamental constraint of the Worker/DO RPC model. The process was being "started" and immediately interrupted.  
**Fix**: Override `onStart()` in a `HermesSandbox extends Sandbox<HermesEnv>` subclass. `onStart()` runs inside the DO lifecycle after the container boots — no Worker timeout can cancel it.

```typescript
class HermesSandbox extends Sandbox<HermesEnv> {
  override onStart(): void {
    super.onStart();
    void this.launchHermes();
  }

  private async launchHermes(): Promise<void> {
    const envVars = buildContainerEnv(this.env);
    await this.startProcess('/usr/local/bin/start-hermes.sh', {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
      onOutput: (stream, data) => console.log(`[hermes/${stream}]`, data.trim()),
      onExit: (code) => console.log('[hermes/exit] code:', code),
    });
  }
}

// wrangler.jsonc uses class_name: "Sandbox"
export { HermesSandbox as Sandbox };
```

Also removed `waitUntil(ensureHermes(...))` from `/api/status` — the DO handles startup, the Worker just polls the port.

---

## Architecture (current, working)

```
Browser → Cloudflare Worker (Hono router)
                ↓ getSandbox('hermes')
          HermesSandbox DO
            onStart() → startProcess('start-hermes.sh')
                              ↓
                    Ubuntu 22.04 container
                    - /container-server/sandbox (port 3000, SDK control plane)
                    - hermes dashboard (port 9119, proxied by Worker)
                    - /home/hermes persisted via R2 backup/restore
```

## Deployed versions
| Hash | Change |
|------|--------|
| e207fcca | initial (wrong ENTRYPOINT, wrong uv path) |
| 883398c6 | fix ENTRYPOINT + WORKDIR — port 3000 working |
| 87a39da6 | intermediate |
| 9733a4bc | **HermesSandbox.onStart() — port 9119 working** |

## Key env vars (set via `wrangler secret put`)
- `OFOX_API_KEY` — OFOx.ai API key (base_url: https://api.ofox.ai/v1)
- `OFOX_MODEL` — model ID (default: openai/gpt-4o)
- `HERMES_GATEWAY_TOKEN` — random hex32, protects dashboard
- `DEV_MODE=true` — bypasses Cloudflare Access JWT check (dev only)

## Debug endpoints
- `GET /api/status` — `{"running": true/false}`
- `GET /api/debug` — runs ps, reads /tmp/hermes-start.log, lists processes (no auth)
- `GET /health` — quick health check

## Container startup flow
1. Container boots → `/container-server/sandbox` starts (port 3000 ready in ~12ms)
2. SDK calls `onStart()` → `startProcess('/usr/local/bin/start-hermes.sh')`
3. `start-hermes.sh`: gosu privilege drop → activate venv → patch config.yaml with OFOx creds → `hermes dashboard --host 0.0.0.0 --port 9119 --insecure`
4. Worker `/api/status` polls port 9119 until open
5. Browser loading page reloads → proxied to Hermes

## If things break
1. Check `npx wrangler tail --format pretty` for `[HermesSandbox] onStart` and `[hermes/out]` lines
2. Hit `/api/debug` to see container process list and startup log
3. Common failure: `start-hermes.sh` exits early due to `set -euo pipefail` — check `/tmp/hermes-start.log` via `/api/debug`
