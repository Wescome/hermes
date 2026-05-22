import type { Sandbox } from '@cloudflare/sandbox';

export interface HermesEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
  BACKUP_BUCKET: R2Bucket;

  // ── AI provider: Cloudflare AI Gateway (recommended) ──────────────────────
  CF_AI_GATEWAY_ACCOUNT_ID?: string;
  CF_AI_GATEWAY_GATEWAY_ID?: string;
  CF_AI_GATEWAY_API_KEY?: string;
  /** Format: "<upstream-provider>/<model-id>", e.g. "openrouter/openai/gpt-4o" */
  CF_AI_GATEWAY_MODEL?: string;

  // ── AI provider: direct OpenRouter fallback ────────────────────────────────
  OPENROUTER_API_KEY?: string;
  /** Default: "openai/gpt-4o" */
  OPENROUTER_MODEL?: string;

  // ── Security ───────────────────────────────────────────────────────────────
  /** Random hex32 — protects Hermes dashboard; generate: openssl rand -hex 32 */
  HERMES_GATEWAY_TOKEN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;

  // ── Messaging platforms ────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN?: string;
  /** Comma-separated Telegram chat IDs allowed to talk to the agent */
  TELEGRAM_ALLOWED_CHATS?: string;
  DISCORD_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;

  // ── Container lifecycle ────────────────────────────────────────────────────
  /** e.g. "10m", "1h" — how long before idle container sleeps. Default: keep alive */
  SANDBOX_SLEEP_AFTER?: string;

  // ── Browser Rendering ──────────────────────────────────────────────────────
  BROWSER?: Fetcher;

  // ── Dev / test ─────────────────────────────────────────────────────────────
  DEV_MODE?: string;
  DEBUG_ROUTES?: string;
}

export type AppEnv = {
  Bindings: HermesEnv;
  Variables: {
    sandbox: Sandbox;
  };
};
