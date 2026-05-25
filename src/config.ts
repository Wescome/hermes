/** Port Hermes dashboard listens on inside the container */
export const GATEWAY_PORT = 9119;

/** Port Hermes messaging gateway listens on inside the container */
export const MESSAGING_GATEWAY_PORT = 9000;

/** Max time to wait for Hermes to start — Python startup is slower than Node */
export const STARTUP_TIMEOUT_MS = 240_000;

/** Directory persisted to R2 — must be under /home, /workspace, /tmp, or /var/tmp */
export const BACKUP_DIR = '/home/hermes';
