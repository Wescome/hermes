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

// ── DO subclass: launches Hermes from the container lifecycle ─────────────────
//
// We override onStart() so Hermes is started by the Durable Object the moment
// the container is healthy. This is critical because:
//
//   - Previously we called `startProcess` from a Worker via `ctx.waitUntil()`.
//   - The Worker's RPC connection to the DO can be canceled when the HTTP
//     response is sent (DO logs showed `outcome: "canceled"`), so the process
//     never reliably started.
//   - `onStart` runs *inside* the DO's lifecycle, after the container is up.
//     No Worker timeout can cancel it.
//
// The Container base type declares `onStart(): void | Promise<void>` and the
// platform awaits it inside `blockConcurrencyWhile`, so an async override is
// safe — `startProcess` resolves as soon as the process is spawned, not when
// Hermes finishes booting (the port-check polling in /api/status handles that).
class HermesSandbox extends Sandbox<HermesEnv> {
  override onStart(): void {
    // Run the parent's sync side-effects (logger + version check) first.
    super.onStart();

    // Fire the actual Hermes launch async. We don't await here because the
    // platform awaits onStart() inside blockConcurrencyWhile, and we don't
    // want to hold the DO any longer than the spawn itself.
    void this.launchHermes();
  }

  private async launchHermes(): Promise<void> {
    // Guard: bail if a hermes process is already running (handles onStart racing on DO reset)
    try {
      const procs = await this.listProcesses();
      const already = procs.some(
        (p) =>
          (p.command.includes('start-hermes.sh') || p.command.includes('hermes dashboard')) &&
          (p.status === 'running' || p.status === 'starting'),
      );
      if (already) {
        console.log('[HermesSandbox] launchHermes: already running, skipping');
        return;
      }
    } catch { /* listProcesses failure is non-fatal — proceed with start attempt */ }

    const envVars = buildContainerEnv(this.env);
    try {
      await this.startProcess('/usr/local/bin/start-hermes.sh', {
        processId: 'hermes-dashboard',
        env: Object.keys(envVars).length > 0 ? envVars : undefined,
        onOutput: (stream, data) => console.log(`[hermes/${stream}]`, data.trim()),
        onExit: (code) => console.log('[hermes/exit] code:', code),
      });
      console.log('[HermesSandbox] onStart: Hermes launched');
    } catch (err) {
      console.error('[HermesSandbox] onStart: startProcess failed:', err);
    }
  }
}

// wrangler.jsonc binds `class_name: "Sandbox"`, so we must export under that name.
export { HermesSandbox as Sandbox };

// ── Loading / error pages ─────────────────────────────────────────────────────

const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Hermes — Starting…</title>
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
    <p id="msg">Waiting for container to boot (60–90 seconds)…</p>
  </div>
  <script>
    let attempts = 0;
    async function poll() {
      attempts++;
      try {
        const r = await fetch('/api/status');
        const d = await r.json();
        if (d.running) { location.reload(); return; }
      } catch {}
      document.getElementById('msg').textContent =
        'Still starting… (' + attempts * 5 + 's elapsed)';
      setTimeout(poll, 5000);
    }
    setTimeout(poll, 5000);
  </script>
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

  // Hermes auth — used to pin the ephemeral session token so the Worker can
  // inject it into proxied API/WebSocket requests (X-Hermes-Session-Token).
  set('HERMES_GATEWAY_TOKEN', env.HERMES_GATEWAY_TOKEN);

  // AI provider
  set('CF_AI_GATEWAY_ACCOUNT_ID', env.CF_AI_GATEWAY_ACCOUNT_ID);
  set('CF_AI_GATEWAY_GATEWAY_ID', env.CF_AI_GATEWAY_GATEWAY_ID);
  set('CF_AI_GATEWAY_API_KEY', env.CF_AI_GATEWAY_API_KEY);
  set('CF_AI_GATEWAY_MODEL', env.CF_AI_GATEWAY_MODEL);
  set('OPENROUTER_API_KEY', env.OPENROUTER_API_KEY);
  set('OPENROUTER_MODEL', env.OPENROUTER_MODEL);
  set('OFOX_API_KEY', env.OFOX_API_KEY);
  set('OFOX_MODEL', env.OFOX_MODEL);

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
    const r = await sandbox.exec(
      `bash -c 'echo >/dev/tcp/localhost/${GATEWAY_PORT}' 2>/dev/null`,
    );
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

// ensureHermes kicks off Hermes if it's not running, then returns immediately.
// It does NOT wait for port 9119 to open — the loading page polls /api/status for that.
// Use ctx.waitUntil(ensureHermes(...)) so it survives after the response is sent.
export async function ensureHermes(sandbox: Sandbox, env: HermesEnv): Promise<void> {
  const existing = await findHermesProcess(sandbox).catch(() => null);
  if (existing) {
    console.log('[gateway] Hermes already running:', existing.id);
    return;
  }

  if (await isPortOpen(sandbox).catch(() => false)) {
    console.log('[gateway] Port already open — Hermes running');
    return;
  }

  console.log('[gateway] Starting Hermes');
  const envVars = buildContainerEnv(env);
  try {
    await sandbox.startProcess('/usr/local/bin/start-hermes.sh', {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('[gateway] Hermes process launched');
  } catch (err) {
    console.error('[gateway] Failed to start process:', err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

function isCrashedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('is not listening');
}

function buildSandboxOptions(env: HermesEnv): SandboxOptions {
  const sleep = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  return sleep === 'never' ? { keepAlive: true } : { sleepAfter: sleep };
}

function validateEnv(env: HermesEnv): string[] {
  const missing: string[] = [];
  if (!env.HERMES_GATEWAY_TOKEN) missing.push('HERMES_GATEWAY_TOKEN');
  const hasGateway = !!(env.CF_AI_GATEWAY_API_KEY && env.CF_AI_GATEWAY_ACCOUNT_ID && env.CF_AI_GATEWAY_GATEWAY_ID);
  const hasOpenRouter = !!env.OPENROUTER_API_KEY;
  const hasOFOx = !!env.OFOX_API_KEY;
  if (!hasGateway && !hasOpenRouter && !hasOFOx) {
    missing.push('OFOX_API_KEY, OPENROUTER_API_KEY, or CF_AI_GATEWAY_* triple');
  }
  return missing;
}

// ── Cookie auth ───────────────────────────────────────────────────────────────
// Simple single-user auth: enter HERMES_GATEWAY_TOKEN once, get an HttpOnly
// cookie. No CF Access, no OAuth apps, no email OTPs.

const AUTH_COOKIE = 'hermes_auth';
const LOGIN_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const LOGIN_HTML = (error = '') => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Hermes — Login</title>
<style>
  body { font-family: system-ui, sans-serif; display:flex; align-items:center;
         justify-content:center; height:100vh; margin:0; background:#0f0f0f; color:#eee; }
  .card { width:340px; }
  h2 { margin:0 0 24px; font-size:1.25rem; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; background:#1a1a1a;
          border:1px solid #333; border-radius:6px; color:#eee; font-size:1rem; margin-bottom:12px; }
  button { width:100%; padding:10px; background:#7c3aed; border:none; border-radius:6px;
           color:#fff; font-size:1rem; cursor:pointer; }
  button:hover { background:#6d28d9; }
  .err { color:#f87171; font-size:0.85rem; margin-bottom:10px; }
</style></head>
<body><div class="card">
  <h2>Hermes</h2>
  ${error ? `<p class="err">${error}</p>` : ''}
  <form method="POST" action="/auth/login">
    <input type="password" name="token" placeholder="Access token" autofocus autocomplete="current-password" />
    <button type="submit">Sign in</button>
  </form>
</div></body></html>`;

function isAuthed(req: Request, env: HermesEnv): boolean {
  if (env.DEV_MODE === 'true') return true;
  const cookies = req.headers.get('cookie') ?? '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
  return !!match && match[1] === env.HERMES_GATEWAY_TOKEN;
}

function authCookieHeader(token: string): string {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${LOGIN_MAX_AGE}`;
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

// ── Login routes (no auth required) ──────────────────────────────────────────
app.get('/auth/login', (c) => c.html(LOGIN_HTML()));

app.post('/auth/login', async (c) => {
  const body = await c.req.parseBody();
  const token = String(body['token'] ?? '').trim();
  if (!token || token !== c.env.HERMES_GATEWAY_TOKEN) {
    return c.html(LOGIN_HTML('Invalid token — try again.'), 401);
  }
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': authCookieHeader(token),
    },
  });
});

app.get('/auth/logout', (c) => new Response(null, {
  status: 302,
  headers: {
    'Location': '/auth/login',
    'Set-Cookie': `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; Max-Age=0`,
  },
}));

app.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');
  // Restore-if-needed still runs in the Worker (it depends on the R2 binding,
  // which the DO doesn't touch). Hermes startup itself is now handled by
  // HermesSandbox.onStart() — no need to call ensureHermes from the Worker.
  c.executionCtx.waitUntil(
    restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET).catch(() => {}),
  );
  // Port open = Hermes is actually serving requests.
  const portOpen = await withTimeout(isPortOpen(sandbox).catch(() => false), 4_000, false);
  return c.json({ running: portOpen, status: portOpen ? 'running' : 'starting' });
});

// Public debug route — no auth, used to diagnose container startup without
// needing Cloudflare Access. Returns `ps`, the start-hermes.sh log, and the
// list of tracked processes inside the sandbox.
app.get('/api/debug', async (c) => {
  const sandbox = c.get('sandbox');
  const [log, procs, pyInfo, hermesInfo, asHermes] = await Promise.allSettled([
    sandbox.exec('cat /tmp/hermes-start.log 2>/dev/null || echo NO_LOG'),
    sandbox.listProcesses(),
    sandbox.exec(
      'ls -la /opt/hermes/.venv/bin/python /opt/hermes/.venv/bin/python3 /opt/hermes/.venv/bin/python3.13 2>&1; ' +
      'readlink -f /opt/hermes/.venv/bin/python 2>&1; ' +
      'ls -la $(readlink -f /opt/hermes/.venv/bin/python) 2>&1'
    ),
    sandbox.exec(
      'ls -la /opt/hermes/.venv/bin/hermes 2>&1; ' +
      'head -1 /opt/hermes/.venv/bin/hermes 2>&1; ' +
      'id hermes 2>&1'
    ),
    sandbox.exec(
      'gosu hermes /opt/hermes/.venv/bin/python --version 2>&1; ' +
      'gosu hermes /opt/hermes/.venv/bin/hermes --version 2>&1; ' +
      'gosu hermes /opt/hermes/.venv/bin/python -c "import yaml; print(yaml.__version__)" 2>&1'
    ),
  ]);
  return c.json({
    log: log.status === 'fulfilled' ? log.value.stdout : String(log.reason),
    procs: procs.status === 'fulfilled' ? procs.value : String(procs.reason),
    pyInfo: pyInfo.status === 'fulfilled' ? pyInfo.value.stdout : String(pyInfo.reason),
    hermesInfo: hermesInfo.status === 'fulfilled' ? hermesInfo.value.stdout : String(hermesInfo.reason),
    asHermes: asHermes.status === 'fulfilled' ? asHermes.value.stdout : String(asHermes.reason),
  });
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

  const uptimeMs = proc?.startTime ? Date.now() - proc.startTime.getTime() : null;

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

app.post('/api/admin/start-gateway', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const r = await sandbox.exec(
      `gosu hermes bash -c 'source /opt/hermes/.venv/bin/activate && nohup hermes gateway >/tmp/hermes-gateway.log 2>&1 &'`,
    );
    return c.json({ ok: true, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr });
  } catch (err) {
    return c.json({ ok: false, message: String(err) }, 500);
  }
});

app.post('/api/admin/exec', async (c) => {
  const sandbox = c.get('sandbox');
  const body = await c.req.json().catch(() => ({})) as { cmd?: string };
  if (!body.cmd) return c.json({ error: 'missing cmd' }, 400);
  try {
    const r = await sandbox.exec(body.cmd);
    return c.json({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
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
    c.executionCtx.waitUntil(ensureHermes(sandbox, c.env).catch(() => {}));
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

// Cookie auth — redirect to login page if not authenticated
app.use('*', async (c, next) => {
  if (!isAuthed(c.req.raw, c.env)) {
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) return c.redirect('/auth/login');
    return c.json({ error: 'Unauthorized' }, 401);
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

  // For browser navigations: show loading page if port 9119 isn't open yet.
  if (!isWS && wantsHtml) {
    const portOpen = await withTimeout(isPortOpen(sandbox).catch(() => false), 4_000, false);
    if (!portOpen) {
      // The DO's onStart() is responsible for launching Hermes — the Worker
      // only kicks off restore-if-needed here (which uses R2). The browser will
      // keep polling /api/status until the port opens.
      c.executionCtx.waitUntil(
        restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET).catch(() => {}),
      );
      return c.html(LOADING_HTML);
    }
  }

  // For API/asset requests: ensure port is open before proxying.
  if (!isWS && !wantsHtml) {
    const portOpen = await withTimeout(isPortOpen(sandbox).catch(() => false), 4_000, false);
    if (!portOpen) {
      c.executionCtx.waitUntil(
        restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET).catch(() => {}),
      );
      return c.json({ error: 'Hermes not ready' }, 503);
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  if (isWS) {
    // The Hermes session token (now fixed = HERMES_GATEWAY_TOKEN) is required as
    // ?token= in the WebSocket URL. Always inject it so both browser-supplied and
    // direct connections work — the browser's JS reads window.__HERMES_SESSION_TOKEN__
    // (set to HERMES_GATEWAY_TOKEN after our patch) and adds it, so this is idempotent.
    let wsReq = req;
    if (c.env.HERMES_GATEWAY_TOKEN) {
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
        await ensureHermes(sandbox, c.env).catch(() => {});
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
  // Inject the Hermes session token so the Worker can reach Hermes API endpoints
  // on behalf of the browser. Hermes is patched at startup to use HERMES_GATEWAY_TOKEN
  // as its _SESSION_TOKEN, so this header satisfies Hermes's auth middleware.
  let resp: Response;
  try {
    const hermesReq = c.env.HERMES_GATEWAY_TOKEN
      ? new Request(req, {
          headers: (() => {
            const h = new Headers(req.headers);
            h.set('X-Hermes-Session-Token', c.env.HERMES_GATEWAY_TOKEN);
            return h;
          })(),
        })
      : req;
    resp = await sandbox.containerFetch(hermesReq, GATEWAY_PORT);
  } catch (err) {
    if (isCrashedError(err)) {
      console.log('[http] Hermes crashed — restoring and restarting');
      await killHermes(sandbox);
      try { await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET); } catch { /* non-fatal */ }
      await ensureHermes(sandbox, c.env).catch(() => {});
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
