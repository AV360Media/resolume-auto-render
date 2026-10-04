import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

const MAX_ENTRIES = 500;

/** Small in-memory logger. The UI reads the ring buffer and listens for new lines. */
export class Logger extends EventEmitter {
  readonly entries: LogEntry[] = [];
  constructor(private echo = true) {
    super();
  }

  log(level: LogLevel, msg: string): void {
    const entry = { t: Date.now(), level, msg };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    if (this.echo && level !== 'debug') {
      const line = `[${new Date(entry.t).toISOString()}] ${level.toUpperCase()} ${msg}`;
      if (level === 'error') console.error(line);
      else console.log(line);
    }
    this.emit('entry', entry);
  }

  debug(msg: string) { this.log('debug', msg); }
  info(msg: string) { this.log('info', msg); }
  warn(msg: string) { this.log('warn', msg); }
  error(msg: string) { this.log('error', msg); }
}
