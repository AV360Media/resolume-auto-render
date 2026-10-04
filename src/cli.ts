#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { startApp } from './app.js';

/** Headless entry: `npm start`. Runs the service and control panel without the tray app. */
async function main() {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const dataArg = args.indexOf('--data-dir');
  const app = await startApp({
    port: portArg >= 0 ? Number(args[portArg + 1]) : undefined,
    dataDir: dataArg >= 0 ? args[dataArg + 1] : undefined,
  });
  if (args.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(cmd, [app.url], { detached: true, stdio: 'ignore' }).unref();
  }
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
