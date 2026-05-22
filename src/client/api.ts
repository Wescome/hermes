const BASE = '/api/admin';

export class AuthError extends Error {}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 401 || res.status === 403) throw new AuthError('Access denied');
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentStatus {
  running: boolean;
  status: 'running' | 'starting' | 'stopped';
  uptimeMs: number | null;
  version: string | null;
  model: string | null;
}

export interface BackupInfo {
  lastBackupAt: string | null;
  backupId: string | null;
}

// ── API calls ──────────────────────────────────────────────────────────────────

export const getStatus  = ()  => req<AgentStatus>('/status');
export const getBackup  = ()  => req<BackupInfo>('/backup');
export const doRestart  = ()  => req<{ ok: boolean; message?: string }>('/restart',  { method: 'POST' });
export const doBackup   = ()  => req<{ ok: boolean; message?: string }>('/backup',   { method: 'POST' });
