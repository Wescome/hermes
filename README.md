# Hermes on Cloudflare

Run [Hermes](https://github.com/NousResearch/hermes-agent) (by Nous Research) in a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container — always-on, persistent across restarts, accessible from anywhere via browser or messaging apps.

Design mirrors [MoltWorker](https://github.com/cloudflare/moltworker): a Cloudflare Worker proxies all traffic to a Hermes container, with R2 backing up `/home/hermes` so nothing is lost on restart.

---

## Requirements

| Requirement | Notes |
|---|---|
| [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) | $5/mo — required for Sandbox containers |
| AI provider key | OpenRouter (recommended) or Cloudflare AI Gateway |
| Cloudflare account | Free tier sufficient for Access, R2, Browser Rendering |

---

## Cost estimate

Container runs on a `standard-1` instance (½ vCPU, 4 GiB RAM, 8 GB disk).

| Item | Cost |
|---|---|
| Workers Paid plan | $5/mo |
| Memory (4 GiB × 24/7) | ~$26/mo |
| CPU (~10% utilization) | ~$2/mo |
| Disk (8 GB × 24/7) | ~$1.50/mo |
| **Total (24/7)** | **~$34.50/mo** |

**Reduce to ~$5–6/mo:** set `SANDBOX_SLEEP_AFTER=10m` so the container hibernates when idle. Cold starts take ~60–90 seconds for Hermes (Python startup).

R2, Cloudflare Access, and Browser Rendering all have generous free tiers and won't add meaningful cost for personal use.

---

## Architecture

```
Browser / Telegram / Discord
         │
         ▼
 Cloudflare Worker (src/index.ts)
   ├── Cloudflare Access (JWT auth)
   ├── R2 backup/restore on every request
   ├── HTTP + WebSocket proxy → port 9119
   └── Admin UI at /_admin/
         │
         ▼
 Sandbox Container (Dockerfile)
   └── Hermes dashboard on 0.0.0.0:9119
       ├── Web chat UI
       ├── REST + WebSocket API
       └── Messaging gateway (Telegram, Discord, Slack…)
         │
         ▼
 R2 Bucket (hermes-data)
   └── /home/hermes snapshot — config, memories, sessions
```

---

## Setup

### 1. Install dependencies

```bash
cd hermes   # this repo
npm install
```

### 2. Create the R2 bucket

```bash
npx wrangler r2 bucket create hermes-data
```

### 3. Set required secrets

```bash
# Generate a random token — save it, you'll use it to access the dashboard
export HERMES_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Gateway token: $HERMES_GATEWAY_TOKEN"
echo "$HERMES_GATEWAY_TOKEN" | npx wrangler secret put HERMES_GATEWAY_TOKEN
```

**AI provider — choose one:**

```bash
# Option A: OFOx.ai — unified gateway for 100+ models (ofox.ai)
npx wrangler secret put OFOX_API_KEY
# Optionally pin a model (default: openai/gpt-4o)
npx wrangler secret put OFOX_MODEL   # e.g. anthropic/claude-sonnet-4-5, openai/gpt-4o

# Option B: OpenRouter
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put OPENROUTER_MODEL   # e.g. openai/gpt-4o, anthropic/claude-sonnet-4-5

# Option C: Cloudflare AI Gateway (analytics + caching)
npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID   # your Cloudflare account ID
npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID   # create one at dash.cloudflare.com → AI Gateway
npx wrangler secret put CF_AI_GATEWAY_API_KEY      # your upstream provider's key
npx wrangler secret put CF_AI_GATEWAY_MODEL        # e.g. "openrouter/openai/gpt-4o"
```

### 4. Set up Cloudflare Access (admin UI protection)

The admin UI at `/_admin/` and all authenticated routes are protected by [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/). Without this, anyone who knows your worker URL can reach it.

**4a. Enable Access on your worker:**

1. Go to [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Click your worker → **Settings** → **Domains & Routes**
3. In the `workers.dev` row, click `…` → **Enable Cloudflare Access**
4. Copy the dialog values — you'll need them next

**4b. Set the Access secrets:**

```bash
# Your team domain — e.g. "myteam.cloudflareaccess.com"
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN

# Application Audience (AUD) tag from the Access application settings
npx wrangler secret put CF_ACCESS_AUD
```

**4c. Allow your email:**

In [Zero Trust](https://dash.cloudflare.com/?to=/:account/zero-trust) → **Access** → **Applications** → find your worker → **Policies** → add your email or identity provider.

### 5. Deploy

```bash
npm run deploy
```

This builds the admin React SPA then deploys the Worker + container definition to Cloudflare.

---

## First boot

The first request after deploy triggers container startup. Hermes takes **60–120 seconds** to start (Python startup + venv activation + dashboard bind).

While it's starting, the Worker serves a loading page that auto-refreshes every 5 seconds. You don't need to do anything — just wait.

**Access your instance:**

```
https://hermes-sandbox.<your-subdomain>.workers.dev/?token=YOUR_GATEWAY_TOKEN
```

Or navigate directly — Cloudflare Access will prompt for login, then the Worker injects the token automatically on WebSocket connections.

**Admin UI:**

```
https://hermes-sandbox.<your-subdomain>.workers.dev/_admin/
```

Requires Cloudflare Access login. Shows agent status, uptime, model, and backup controls.

---

## Messaging platforms

Add bot tokens to connect Hermes to external platforms. The container's messaging gateway starts automatically when any of these secrets are set.

```bash
# Telegram
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Optionally restrict to specific chat IDs (comma-separated):
npx wrangler secret put TELEGRAM_ALLOWED_CHATS   # e.g. "123456789,-987654321"

# Discord
npx wrangler secret put DISCORD_BOT_TOKEN

# Slack
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_APP_TOKEN
```

After adding secrets, redeploy:

```bash
npm run deploy
```

For Telegram webhooks to reach the container, set your bot's webhook URL to your worker:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://hermes-sandbox.<subdomain>.workers.dev/webhook/telegram"
```

For this deployment, the webhook URL is:

```bash
https://hermes-sandbox.koales.workers.dev/webhook/telegram
```

If you want to restrict access to your own Telegram user or group, message the
bot once before setting the webhook, then run:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Copy the `message.chat.id` value into `TELEGRAM_ALLOWED_CHATS`.

---

## Persistence

`/home/hermes` is snapshotted to R2 on every cron tick (every minute) and before each restart. What's persisted:

- `config.yaml` — model, channel, and behavior settings
- `memories/` — Hermes's learning and user model
- `sessions/` — conversation history
- `skills/` — custom skills you add at runtime
- `cron/` — scheduled automations

If the container crashes or is restarted, the Worker restores the latest snapshot before starting Hermes again. You should never lose more than ~1 minute of state.

**Manual backup** — trigger one from the admin UI or:

```bash
curl -X POST https://hermes-sandbox.<subdomain>.workers.dev/api/admin/backup \
  -H "Cf-Access-Jwt-Assertion: <your-access-token>"
```

---

## Customizing Hermes

### Change the model at runtime

Inside Hermes (via web UI or Telegram), run:

```
hermes model
```

Or edit `config.yaml` via the web UI → restart.

### Add skills

Upload a skill directory to `/home/hermes/skills/` via the web UI or SSH into the container:

```bash
wrangler containers exec hermes-sandbox -- bash
```

### Set a persona (SOUL.md)

Edit `/home/hermes/SOUL.md` inside the container. Hermes loads it on every message — no restart needed.

### Adjust memory settings

Edit `config.yaml` → `memory` section. Changes take effect on the next message.

---

## Cost optimization

```bash
# Sleep after 10 minutes of inactivity (~$5–6/mo vs $34.50/mo)
npx wrangler secret put SANDBOX_SLEEP_AFTER   # enter: 10m
npm run deploy
```

Cold start after sleep: ~60–90 seconds. The Worker serves a loading page during this time.

---

## Upgrading Hermes

The Hermes version is pinned in `Dockerfile`:

```dockerfile
RUN uv pip install --no-cache 'hermes-agent[all,messaging]'
```

To upgrade to a specific version:

```dockerfile
RUN uv pip install --no-cache 'hermes-agent[all,messaging]==0.15.0'
```

Then redeploy — the new container image will be built and pushed:

```bash
npm run deploy
```

Your data in R2 is untouched. On next start, Hermes restores from the snapshot.

---

## Troubleshooting

### Container won't start / stuck on loading page

Check Worker logs:

```bash
npx wrangler tail
```

Look for `[gateway]` lines. Common causes:

- **Python import error** — rebuild the Docker image: `npm run deploy`
- **Missing secret** — the Worker returns a 503 with `missing` field listing what's needed
- **Port not open** — Hermes failed to bind 9119; check stderr in container logs

### Admin UI shows "Access denied"

Cloudflare Access JWT validation failed. Verify:

1. `CF_ACCESS_TEAM_DOMAIN` matches your team exactly (no `https://` prefix)
2. `CF_ACCESS_AUD` is the AUD tag from Access settings, not the client ID
3. You're logged in with an email allowed by your Access policy

### Backup not restoring

If container data seems reset after restart:

```bash
# Check R2 bucket contents
npx wrangler r2 object list hermes-data
```

If `backup-handle.json` is missing, no backup exists yet. The first backup runs on the next cron tick (~1 minute after startup).

### Telegram webhook not receiving messages

Confirm webhook is set to your worker URL:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

The URL should point to `https://hermes-sandbox.<subdomain>.workers.dev/...`. If it doesn't match, re-run the `setWebhook` command from the [messaging platforms](#messaging-platforms) section.

### High cost

Enable `SANDBOX_SLEEP_AFTER` — see [Cost optimization](#cost-optimization). Memory is the dominant cost and is billed on provisioned capacity regardless of usage.

---

## Local development

```bash
# Run worker locally (container runs in Cloudflare's cloud even in dev mode)
npm start

# Set DEV_MODE=true in .dev.vars to skip CF Access auth:
echo 'DEV_MODE=true' > .dev.vars
echo 'HERMES_GATEWAY_TOKEN=devtoken' >> .dev.vars
echo 'OPENROUTER_API_KEY=sk-...' >> .dev.vars
```

Create `.dev.vars` for local secrets (never commit this file):

```ini
DEV_MODE=true
HERMES_GATEWAY_TOKEN=devtoken
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o
```

---

## File reference

```
hermes/
├── Dockerfile              # Hermes container image
├── start-hermes.sh         # Container startup: config patch + launch
├── wrangler.jsonc          # Cloudflare deployment config
├── package.json
├── vite.config.ts          # Vite build for admin React SPA
├── tsconfig.json
├── index.html              # Admin SPA entry
└── src/
    ├── config.ts           # GATEWAY_PORT, timeouts, backup dir
    ├── types.ts            # HermesEnv + AppEnv types
    ├── index.ts            # Worker: routing, proxy, persistence, admin API
    └── client/             # React admin UI
        ├── main.tsx
        ├── App.tsx / App.css
        ├── index.css
        ├── api.ts          # Typed fetch client for /api/admin/*
        └── pages/
            ├── AdminPage.tsx
            └── AdminPage.css
```

---

## Credits

Architecture based on [MoltWorker](https://github.com/cloudflare/moltworker) by Cloudflare.  
Agent: [Hermes](https://github.com/NousResearch/hermes-agent) by Nous Research.
