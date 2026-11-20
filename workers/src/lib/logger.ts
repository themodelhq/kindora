/**
 * Minimal logger for worker processes — timestamped, level-tagged, zero deps.
 * Output goes to stdout/stderr which Render captures as logs.
 */

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  const extra = meta === undefined ? '' : ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
  if (level === 'error') console.error(line + extra);
  else if (level === 'warn') console.warn(line + extra);
  else console.log(line + extra);
}

export function logInfo(message: string, meta?: unknown): void {
  emit('info', message, meta);
}

export function logWarn(message: string, meta?: unknown): void {
  emit('warn', message, meta);
}

export function logError(message: string, meta?: unknown): void {
  emit('error', message, meta);
}
