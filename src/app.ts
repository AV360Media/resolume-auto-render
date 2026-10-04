import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from './service.js';
import { startServer, type UiServer } from './server.js';
import { defaultDataDir } from './settings.js';
import { Logger } from './log.js';

/** Repo root in development, app.asar root when packaged. Holds index.html and package.json. */
export function appRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export async function readVersion(root = appRoot()): Promise<string> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface RunningApp {
  service: Service;
  server: UiServer;
  url: string;
  stop(): Promise<void>;
}

/** Starts the companion service and the control panel. Used by both the CLI and the Electron shell. */
export async function startApp(opts: { dataDir?: string; port?: number; logger?: Logger } = {}): Promise<RunningApp> {
  const root = appRoot();
  const service = new Service({ dataDir: opts.dataDir || defaultDataDir(), version: await readVersion(root), logger: opts.logger });
  await service.start();
  const port = opts.port ?? service.getSettings().uiPort;
  let server: UiServer;
  try {
    server = await startServer(service, root, port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    service.log.warn(`Port ${port} is in use; picking a free port.`);
    server = await startServer(service, root, 0);
  }
  const url = `http://127.0.0.1:${server.port}/`;
  service.log.info(`Control panel: ${url}`);
  return {
    service,
    server,
    url,
    stop: async () => {
      await server.close();
      await service.stop();
    },
  };
}
