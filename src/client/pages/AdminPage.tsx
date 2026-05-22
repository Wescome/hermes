import { useState, useEffect, useCallback } from 'react';
import {
  getStatus, getBackup, doRestart, doBackup,
  AuthError,
  type AgentStatus, type BackupInfo,
} from '../api';
import './AdminPage.css';

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AgentStatus['status'] }) {
  const map = {
    running:  { cls: 'pill-green',  label: 'Running'  },
    starting: { cls: 'pill-yellow', label: 'Starting' },
    stopped:  { cls: 'pill-red',    label: 'Stopped'  },
  };
  const { cls, label } = map[status] ?? { cls: 'pill-gray', label: status };
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

function formatUptime(ms: number | null) {
  if (ms === null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function formatDate(iso: string | null) {
  if (!iso) return 'Never';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// ── Card component ────────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="card-title">{title}</h2>
      {children}
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [status, setStatus]   = useState<AgentStatus | null>(null);
  const [backup, setBackup]   = useState<BackupInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [restarting, setRestarting] = useState(false);
  const [backing,    setBacking]    = useState(false);
  const [toast,      setToast]      = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    try {
      setError(null);
      const [s, b] = await Promise.all([getStatus(), getBackup()]);
      setStatus(s);
      setBackup(b);
    } catch (e) {
      if (e instanceof AuthError) {
        setError('Access denied. Make sure you\'re authenticated via Cloudflare Access.');
      } else {
        setError(e instanceof Error ? e.message : 'Failed to load status');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll every 10s so status stays fresh
  useEffect(() => {
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const handleRestart = async () => {
    if (!confirm('Restart Hermes? Active sessions will be interrupted.')) return;
    setRestarting(true);
    try {
      const r = await doRestart();
      showToast(r.message ?? 'Hermes restarted', true);
      setTimeout(load, 3000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Restart failed', false);
    } finally {
      setRestarting(false);
    }
  };

  const handleBackup = async () => {
    setBacking(true);
    try {
      const r = await doBackup();
      showToast(r.message ?? 'Backup created', true);
      const b = await getBackup();
      setBackup(b);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Backup failed', false);
    } finally {
      setBacking(false);
    }
  };

  if (loading) {
    return (
      <div className="center-msg">
        <span className="spinner" />
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-box">
        <strong>Error</strong>
        <p>{error}</p>
        <button className="btn-secondary" onClick={load} style={{ marginTop: '1rem' }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="admin-page">

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.ok ? 'toast-ok' : 'toast-err'}`}>
          {toast.msg}
        </div>
      )}

      {/* Agent status */}
      <Card title="Agent">
        <div className="info-grid">
          <div className="info-row">
            <span className="info-label">Status</span>
            <StatusBadge status={status?.status ?? 'stopped'} />
          </div>
          <div className="info-row">
            <span className="info-label">Uptime</span>
            <span className="info-val">{formatUptime(status?.uptimeMs ?? null)}</span>
          </div>
          {status?.model && (
            <div className="info-row">
              <span className="info-label">Model</span>
              <span className="info-val mono">{status.model}</span>
            </div>
          )}
          {status?.version && (
            <div className="info-row">
              <span className="info-label">Version</span>
              <span className="info-val mono">{status.version}</span>
            </div>
          )}
        </div>
        <div className="card-actions">
          <button className="btn-danger" onClick={handleRestart} disabled={restarting}>
            {restarting && <span className="spinner" />}
            Restart
          </button>
        </div>
      </Card>

      {/* Persistence */}
      <Card title="Backup">
        <div className="info-grid">
          <div className="info-row">
            <span className="info-label">Last backup</span>
            <span className="info-val">{formatDate(backup?.lastBackupAt ?? null)}</span>
          </div>
          {backup?.backupId && (
            <div className="info-row">
              <span className="info-label">Backup ID</span>
              <span className="info-val mono trunc">{backup.backupId}</span>
            </div>
          )}
        </div>
        <p className="hint">
          Backups persist <code>/home/hermes</code> — config, memories, sessions — to R2.
          They run automatically every minute via cron and on restart.
        </p>
        <div className="card-actions">
          <button className="btn-primary" onClick={handleBackup} disabled={backing}>
            {backing && <span className="spinner" />}
            Backup now
          </button>
        </div>
      </Card>

      {/* Quick links */}
      <Card title="Quick links">
        <div className="link-list">
          <a href="/" target="_blank" rel="noreferrer">Open Hermes dashboard ↗</a>
          <a href="/api/status" target="_blank" rel="noreferrer">API status ↗</a>
        </div>
      </Card>

    </div>
  );
}
