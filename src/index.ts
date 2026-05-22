/**
 * Hermes + Cloudflare Sandbox Worker
 *
 * Runs the Hermes AI agent (hermes-agent by Nous Research) in a Cloudflare
 * Sandbox container and proxies all traffic — HTTP and WebSocket — to it.
 *
 * Architecture mirrors MoltWorker (github.com/cloudflare/moltworker):
 *   Worker (this file) → Sandbox container (Hermes on port 9119)
 *                      ↕ R2 backup/restore for /home/hermes persistence
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions, type Process } from '@cloudflare/sandbox';
import type { AppEnv, HermesEnv } from './types';
import { GATEWAY_PORT, STARTUP_TIMEOUT_MS, BACKUP_DIR } from './config';

export { Sandbox };

// ── Loading / error pages ─────────────────────────────────────────────────────

const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Hermes — Starting…</title>
<meta http-equiv="refresh" content="5">
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; background: #0f0f0f; color: #eee; }
  .card { text-align: center; max-width: 400px; }
  .spinner { width: 48px; height: 48px; border: 4px solid #333;
             border-top-color: #7c3aed; border-radius: 50%;
             animation: spin 1s linear infinite; margin: 0 auto 24px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { color: #888; margin-top: 8px; font-size: 0.875rem; }
</style></head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>Hermes is starting…</h2>
    <p>This page will refresh automatically.</p>
  </div>
</body></html>`;

// ── Persistence (R2 backup/restore) ───────────────────────────────────────────

const HANDLE_KEY = 'backup-handle.json';
const RESTORE_SIGNAL_KEY = 'restore-needed';

let _restored = false; // per-isolate fast path

async function getHandle(bucket: R2Bucket): Promise<{ id: string; dir: string } | null> {
  const obj = await bucket.get(HANDLE_KEY);
  return obj ? obj.json() : null;
}

export async function restoreIfNeeded(sandbox: Sandbox, bucket: R2Bucket): Promise<void> {
  if (_restored) {
    const signal = await bucket.head(RESTORE_SIGNAL_KEY);
    if (!signal) return;
    console.log('[persist] Re-restore signal found');
    _restored = false;
  }

  const handle = await getHandle(bucket);
  if (!handle) {
    console.log('[persist] No backup handle — skipping restore');
    _restored = true;
    return;
  }

  try {
    await sandbox.exec(`umount ${BACKUP_DIR} 2>/dev/null; true`);
  } catch { /* not mounted */ }

  console.log(`[persist] Restoring backup ${handle.id}`);
  const t0 = Date.now();
  try {
    await sandbox.restoreBackup(handle);
    await bucket.delete(RESTORE_SIGNAL_KEY);
    _restored = true;
    console.log(`[persist] Restored in ${Date.now() - t0}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('BACKUP_EXPIRED') || msg.includes('BACKUP_NOT_FOUND')) {
      console.log('[persist] Backup expired/gone, clearing handle');
      await bucket.delete(HANDLE_KEY);
    } else {
      throw err;
    }
  }
}

export async function createSnapshot(sandbox: Sandbox, bucket: R2Bucket): Promise<void> {
  const old = await getHandle(bucket);
  if (old) {
    try {
      await sandbox.deleteBackup(old);
    } catch { /* already gone */ }
    await bucket.delete(HANDLE_KEY);
  }

  try {
    await sandbox.exec(`chmod -R a+rX ${BACKUP_DIR}`);
  } catch { /* non-fatal */ }

  const handle = await sandbox.createBackup(BACKUP_DIR);
  await bucket.put(HANDLE_KEY, JSON.stringify(handle));
  await bucket.delete(RESTORE_SIGNAL_KEY);
  _restored = true;
  console.log('[persist] Snapshot created:', handle.id);
}

// ── Gateway process management ────────────────────────────────────────────────

function buildContainerEnv(env: HermesEnv): Record<string, string> {
  const vars: Record<string, string> = {};

  const set = (k: string, v: string | undefined) => { if (v) vars[k] = v; };

  // AI provider
  set('CF_AI_GATEWAY_ACCOUNT_ID', env.CF_AI_GATEWAY_ACCOUNT_ID);
  set('CF_AI_GATEWAY_GATEWAY_ID', env.CF_AI_GATEWAY_GATEWAY_ID);
  set('CF_AI_GATEWAY_API_KEY', env.CF_AI_GATEWAY_API_KEY);
  set('CF_AI_GATEWAY_MODEL', env.CF_AI_GATEWAY_MODEL);
  set('OPENROUTER_API_KEY', env.OPENROUTER_API_KEY);
  set('OPENROUTER_MODEL', env.OPENROUTER_MODEL);

  // Messaging
  set('TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN);
  set('TELEGRAM_ALLOWED_CHATS', env.TELEGRAM_ALLOWED_CHATS);
  set('DISCORD_BOT_TOKEN', env.DISCORD_BOT_TOKEN);
  set('SLACK_BOT_TOKEN', env.SLACK_BOT_TOKEN);
  set('SLACK_APP_TOKEN', env.SLACK_APP_TOKEN);

  return vars;
}

export async function findHermesProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const procs = await sandbox.listProcesses();
    for (const proc of procs) {
      const isHermes =
        proc.command.includes('start-hermes.sh') ||
        proc.command.includes('hermes dashboard') ||
        proc.command.includes('hermes gateway');
      if (isHermes && (proc.status === 'running' || proc.status === 'starting')) {
        return proc;
      }
    }
  } catch (e) {
    console.log('[gateway] listProcesses failed:', e);
  }
  return null;
}

async function isPortOpen(sandbox: Sandbox): Promise<boolean> {
  try {
    const r = await sandbox.exec(`nc -z localhost ${GATEWAY_PORT}`);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

export async function killHermes(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.exec(
      [
        `kill -9 $(ss -tlnp sport = :${GATEWAY_PORT} 2>/dev/null | grep -oP "pid=\\K[0-9]+") 2>/dev/null`,
        'pkill -9 -f "hermes dashboard" 2>/dev/null',
        'pkill -9 -f "start-hermes.sh" 2>/dev/null',
        'true',
      ].join('; '),
    );
  } catch { /* process may not exist */ }

  const proc = await findHermesProcess(sandbox);
  if (proc) {
    try { await proc.kill(); } catch { /* already dead */ }
  }

  await new Promise((r) => setTimeout(r, 2000));
}

export async function ensureHermes(sandbox: Sandbox, env: HermesEnv): Promise<Process | null> {
  const existing = await findHermesProcess(sandbox);
  if (existing) {
    console.log('[gateway] Found existing Hermes process:', existing.id);
    try {
      await existing.waitForPort(GATEWAY_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      return existing;
    } catch {
      console.log('[gateway] Existing process not reachable, restarting');
      try { await existing.kill(); } catch { /* ignore */ }
    }
  }

  if (await isPortOpen(sandbox)) {
    console.log('[gateway] Port already open — Hermes running (undetected by listProcesses)');
    return null;
  }

  console.log('[gateway] Starting Hermes');
  const envVars = buildContainerEnv(env);
  let proc: Process;
  try {
    proc = await sandbox.startProcess('/usr/local/bin/start-hermes.sh', {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
  } catch (err) {
    console.error('[gateway] Failed to start process:', err);
    throw err;
  }

  try {
    await proc.waitForPort(GATEWAY_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[gateway] Hermes dashboard is ready');
  } catch (e) {
    const logs = await proc.getLogs().catch(() => ({ stdout: '', stderr: '' }));
    throw new Error(
      `Hermes failed to start. stderr: ${logs.stderr || '(empty)'}`,
      { cause: e },
    );
  }

  return proc;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isCrashedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('is not listening');
}

function buildSandboxOptions(env: HermesEnv): SandboxOptions {
  const sleep = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  return sleep === 'never' ? { keepAlive: true } : { sleepAfter: sleep };
}

function validateEnv(env: HermesEnv): string[] {
  const missing: string[] = [];
  const dev = env.DEV_MODE === 'true';

  if (!env.HERMES_GATEWAY_TOKEN) missing.push('HERMES_GATEWAY_TOKEN');
  if (!dev && !env.CF_ACCESS_TEAM_DOMAIN) missing.push('CF_ACCESS_TEAM_DOMAIN');
  if (!dev && !env.CF_ACCESS_AUD) missing.push('CF_ACCESS_AUD');

  const hasGateway = !!(
    env.CF_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  );
  const hasOpenRouter = !!env.OPENROUTER_API_KEY;
  if (!hasGateway && !hasOpenRouter) {
    missing.push('OPENROUTER_API_KEY or CF_AI_GATEWAY_* triple');
  }

  return missing;
}

// ── Cloudflare Access auth ─────────────────────────────────────────────────────

async function verifyAccess(req: Request, env: HermesEnv): Promise<boolean> {
  if (env.DEV_MODE === 'true') return true;

  const jwt = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt || !env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return false;

  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const certsUrl = `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
    const JWKS = createRemoteJWKSet(new URL(certsUrl));
    const { payload } = await jwtVerify(jwt, JWKS, { audience: env.CF_ACCESS_AUD });
    return !!(payload as { email?: string }).email;
  } catch {
    return false;
  }
}

// ── Cron (backup on schedule) ──────────────────────────────────────────────────

async function handleScheduled(env: HermesEnv): Promise<void> {
  try {
    const sandbox = getSandbox(env.Sandbox, 'hermes', buildSandboxOptions(env));
    const proc = await findHermesProcess(sandbox);
    if (!proc) {
      console.log('[cron] Hermes not running — skipping backup');
      return;
    }
    await createSnapshot(sandbox, env.BACKUP_BUCKET);
    console.log('[cron] Backup complete');
  } catch (err) {
    console.error('[cron] Backup failed:', err);
  }
}

// ── Main Hono app ─────────────────────────────────────────────────────────────

const app = new Hono<AppEnv>();

// Attach sandbox stub and execution context to every request
app.use('*', async (c, next) => {
  const sandbox = getSandbox(c.env.Sandbox, 'hermes', buildSandboxOptions(c.env));
  c.set('sandbox', sandbox);
  await next();
});

// ── Public routes (no auth) ───────────────────────────────────────────────────

app.get('/health', (c) => c.json({ ok: true }));

app.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET);
  } catch { /* non-fatal */ }
  try {
    await ensureHermes(sandbox, c.env);
  } catch { /* non-fatal */ }
  const proc = await findHermesProcess(sandbox);
  return c.json({ running: !!proc, status: proc?.status ?? 'stopped' });
});

// ── Admin API (protected — CF Access required) ────────────────────────────────

app.get('/api/admin/status', async (c) => {
  const sandbox = c.get('sandbox');
  const proc = await findHermesProcess(sandbox).catch(() => null);

  // Try to read the hermes version from the container
  let version: string | null = null;
  let model: string | null = null;
  if (proc) {
    try {
      const r = await sandbox.exec('hermes --version 2>/dev/null | head -1');
      version = r.stdout.trim() || null;
    } catch { /* non-fatal */ }
    try {
      // Read model from config.yaml inside the container
      const r = await sandbox.exec(
        `python3 -c "import yaml,os; c=yaml.safe_load(open(os.environ.get('HERMES_HOME','/home/hermes')+'/config.yaml')); print(c.get('model',{}).get('default',''))" 2>/dev/null`
      );
      model = r.stdout.trim() || null;
    } catch { /* non-fatal */ }
  }

  const uptimeMs = proc?.startedAt ? Date.now() - new Date(proc.startedAt).getTime() : null;

  return c.json({
    running: !!proc,
    status: proc?.status ?? 'stopped',
    uptimeMs,
    version,
    model,
  });
});

app.get('/api/admin/backup', async (c) => {
  const handle = await c.env.BACKUP_BUCKET.get('backup-handle.json').then(
    (o) => (o ? o.json<{ id: string; dir: string }>() : null),
    () => null,
  );
  const meta = handle
    ? await c.env.BACKUP_BUCKET.head(`backup-meta-${handle.id}`).catch(() => null)
    : null;
  return c.json({
    backupId: handle?.id ?? null,
    lastBackupAt: meta?.uploaded?.toISOString() ?? null,
  });
});

app.post('/api/admin/backup', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    await createSnapshot(sandbox, c.env.BACKUP_BUCKET);
    return c.json({ ok: true, message: 'Backup created successfully' });
  } catch (err) {
    return c.json({ ok: false, message: String(err) }, 500);
  }
});

app.post('/api/admin/restart', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Snapshot before killing so no state is lost
    const proc = await findHermesProcess(sandbox).catch(() => null);
    if (proc) {
      try { await createSnapshot(sandbox, c.env.BACKUP_BUCKET); } catch { /* non-fatal */ }
      await killHermes(sandbox);
    }
    // Fire-and-forget — next incoming request will waitForPort
    void ensureHermes(sandbox, c.env).catch(() => {});
    return c.json({ ok: true, message: 'Hermes is restarting' });
  } catch (err) {
    return c.json({ ok: false, message: String(err) }, 500);
  }
});

// ── Protected catch-all: proxy to Hermes ──────────────────────────────────────

// Validate env on all other routes
app.use('*', async (c, next) => {
  const missing = validateEnv(c.env);
  if (missing.length > 0) {
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      return c.html(
        `<h1>Configuration error</h1><p>Missing secrets: ${missing.join(', ')}</p>`,
        503,
      );
    }
    return c.json({ error: 'Configuration error', missing }, 503);
  }
  await next();
});

// CF Access auth on all routes except public ones above
app.use('*', async (c, next) => {
  const ok = await verifyAccess(c.req.raw, c.env);
  if (!ok) {
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      return c.html('<h1>Access denied</h1><p>Cloudflare Access required.</p>', 403);
    }
    return c.json({ error: 'Access denied' }, 403);
  }
  await next();
});

// Catch-all proxy
app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const req = c.req.raw;
  const url = new URL(req.url);
  const isWS = req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const wantsHtml = req.headers.get('Accept')?.includes('text/html');

  // For browser navigations: serve loading page if Hermes not yet ready
  if (!isWS && wantsHtml) {
    const proc = await findHermesProcess(sandbox).catch(() => null);
    if (!proc) {
      return c.html(LOADING_HTML);
    }
  }

  // For API/asset requests: ensure Hermes is up before proxying
  if (!isWS && !wantsHtml) {
    try { await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET); } catch { /* non-fatal */ }
    try {
      await ensureHermes(sandbox, c.env);
    } catch (err) {
      return c.json({ error: 'Hermes not ready', details: String(err) }, 503);
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  if (isWS) {
    // Inject gateway token if the user lost it through a CF Access redirect
    let wsReq = req;
    if (c.env.HERMES_GATEWAY_TOKEN && !url.searchParams.has('token')) {
      const u = new URL(url.toString());
      u.searchParams.set('token', c.env.HERMES_GATEWAY_TOKEN);
      wsReq = new Request(u.toString(), req);
    }

    let containerResp: Response;
    try {
      containerResp = await sandbox.wsConnect(wsReq, GATEWAY_PORT);
    } catch (err) {
      if (isCrashedError(err)) {
        console.log('[ws] Hermes crashed — restoring and restarting');
        await killHermes(sandbox);
        try { await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET); } catch { /* non-fatal */ }
        await ensureHermes(sandbox, c.env);
        try {
          containerResp = await sandbox.wsConnect(wsReq, GATEWAY_PORT);
        } catch (retryErr) {
          return new Response('Gateway unavailable after restart', { status: 503 });
        }
      } else {
        return new Response('WebSocket proxy error', { status: 502 });
      }
    }

    const containerWs = containerResp.webSocket;
    if (!containerWs) return containerResp;

    const [clientWs, serverWs] = Object.values(new WebSocketPair());
    serverWs.accept();
    containerWs.accept();

    serverWs.addEventListener('message', (e) => {
      if (containerWs.readyState === WebSocket.OPEN) containerWs.send(e.data);
    });
    containerWs.addEventListener('message', (e) => {
      if (serverWs.readyState === WebSocket.OPEN) serverWs.send(e.data);
    });
    serverWs.addEventListener('close', (e) => containerWs.close(e.code, e.reason));
    containerWs.addEventListener('close', (e) => {
      const reason = e.reason.length > 123 ? e.reason.slice(0, 120) + '...' : e.reason;
      serverWs.close(e.code, reason);
    });
    serverWs.addEventListener('error', () => containerWs.close(1011, 'client error'));
    containerWs.addEventListener('error', () => serverWs.close(1011, 'container error'));

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  // ── HTTP proxy ─────────────────────────────────────────────────────────────
  let resp: Response;
  try {
    resp = await sandbox.containerFetch(req, GATEWAY_PORT);
  } catch (err) {
    if (isCrashedError(err)) {
      console.log('[http] Hermes crashed — restoring and restarting');
      await killHermes(sandbox);
      try { await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET); } catch { /* non-fatal */ }
      await ensureHermes(sandbox, c.env);
      try {
        resp = await sandbox.containerFetch(req, GATEWAY_PORT);
      } catch {
        return wantsHtml ? c.html(LOADING_HTML) : c.json({ error: 'Gateway unavailable' }, 503);
      }
    } else if (wantsHtml) {
      return c.html(LOADING_HTML);
    } else {
      return c.json({ error: 'Proxy error', details: String(err) }, 502);
    }
  }

  // Guard against empty body on fresh HTML loads
  if (wantsHtml) {
    const body = await resp.text();
    if (!body || body.length < 50) return c.html(LOADING_HTML);
    return new Response(body, { status: resp.status, headers: resp.headers });
  }

  return new Response(resp.body, { status: resp.status, headers: resp.headers });
});

// ── Exports ───────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_: ScheduledController, env: HermesEnv, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};
