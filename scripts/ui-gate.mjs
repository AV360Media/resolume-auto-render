// UI test gate. Usage: node scripts/ui-gate.mjs [index.test.html]
// Checks: HTML validation, inline script syntax, ESLint, headless Playwright smoke test against a mock companion.
// Exit code 0 only when every check passes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function extractInlineScripts(html) {
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\ssrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue;
    const line = html.slice(0, m.index).split('\n').length;
    out.push({ code: m[2], line });
  }
  return out;
}

async function checkHtml(file) {
  const { HtmlValidate } = await import('html-validate');
  const hv = new HtmlValidate({ extends: ['html-validate:recommended'], rules: { 'no-inline-style': 'off', 'long-title': 'off' } });
  const report = await hv.validateFile(file);
  if (report.valid) return { ok: true, detail: 'valid' };
  const msgs = report.results.flatMap((r) => r.messages.map((m) => `line ${m.line}:${m.column} ${m.ruleId}: ${m.message}`));
  return { ok: false, detail: msgs.slice(0, 20).join('\n') };
}

async function checkSyntax(scripts) {
  if (!scripts.length) return { ok: false, detail: 'no inline script found' };
  for (const s of scripts) {
    try {
      new vm.Script(s.code, { filename: `inline-script@line${s.line}` });
    } catch (e) {
      return { ok: false, detail: `script at line ${s.line}: ${e.message}` };
    }
  }
  return { ok: true, detail: `${scripts.length} script(s) parse` };
}

async function checkLint(scripts) {
  const { ESLint } = await import('eslint');
  const js = (await import('@eslint/js')).default;
  const globals = (await import('globals')).default;
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      js.configs.recommended,
      {
        languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: { ...globals.browser } },
        rules: { 'no-unused-vars': ['error', { args: 'none' }], eqeqeq: ['error', 'smart'], 'no-implicit-globals': 'error' },
      },
    ],
  });
  const problems = [];
  for (const s of scripts) {
    const [res] = await eslint.lintText(s.code, { filePath: path.join(root, 'inline.js') });
    for (const m of res.messages) problems.push(`line ${s.line + m.line - 1}: ${m.ruleId || 'parse'}: ${m.message}`);
  }
  return problems.length ? { ok: false, detail: problems.slice(0, 20).join('\n') } : { ok: true, detail: 'no lint errors' };
}

async function smokeTest(file) {
  const { chromium } = await import('playwright');
  const { startMockCompanion } = await import('./mock-companion.mjs');
  const mock = await startMockCompanion(file);
  const errors = [];
  const browser = await chromium.launch();
  const steps = [];
  const step = (name) => steps.push(name);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });

    await page.goto(mock.url, { waitUntil: 'load' });
    step('page loads');
    for (const sel of ['header h1', '#conn-status', '#queue', '#logs', '#open-settings', '#add-form']) {
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 });
    }
    step('key elements render');
    await page.waitForSelector('body[data-ws="open"]', { timeout: 5000 });
    await page.waitForSelector('#conn-status[data-state="connected"]', { timeout: 5000 });
    const connText = await page.textContent('#conn-text');
    if (!/Connected to Arena/.test(connText || '')) throw new Error(`status text was "${connText}"`);
    step('WebSocket connects and status shows Arena');

    const progressSeen = [];
    const run = mock.runFakeJob({ stepMs: 120 });
    await page.waitForSelector('.job[data-state="encoding"]', { timeout: 5000 });
    for (let i = 0; i < 20; i++) {
      const w = await page.$eval('.job .fill', (el) => parseFloat(el.style.width) || 0).catch(() => 0);
      progressSeen.push(w);
      if (w >= 50) break;
      await page.waitForTimeout(60);
    }
    await run;
    await page.waitForSelector('.job[data-state="done"]', { timeout: 5000 });
    const done = await page.$eval('.job[data-state="done"] .fill', (el) => el.style.width);
    if (!progressSeen.some((w) => w > 0 && w < 100)) throw new Error(`progress bar never moved between 0 and 100 (${progressSeen.join(',')})`);
    if (done !== '100%') throw new Error(`done job progress is ${done}`);
    if ((await page.textContent('#count-done'))?.trim() !== '1') throw new Error('done counter not 1');
    step('fake queue item progresses to done');

    await mock.runFakeJob({ source: '/clips/broken.mp4', fail: true, stepMs: 30 });
    await page.waitForSelector('.job[data-state="failed"] [data-action="retry"]:not([hidden])', { timeout: 5000 });
    await page.click('.job[data-state="failed"] [data-action="retry"]');
    await page.waitForTimeout(200);
    if (!mock.calls.some((c) => c.method === 'POST' && /\/retry$/.test(c.url))) throw new Error('retry did not call the API');
    step('failed item shows error and retry works');

    await page.click('#open-settings');
    await page.waitForSelector('#settings-drawer.open', { timeout: 3000 });
    const port = await page.inputValue('#s-arenaPort');
    if (port !== '8080') throw new Error(`settings not filled (port=${port})`);
    if ((await page.locator('#backends tr').count()) < 1) throw new Error('backend table empty');
    await page.fill('#s-concurrency', '3');
    await page.click('#save-settings');
    await page.waitForTimeout(200);
    const put = mock.calls.find((c) => c.method === 'PUT' && c.url === '/api/settings');
    if (!put || JSON.parse(put.body).concurrency !== 3) throw new Error('settings save did not send concurrency=3');
    await page.click('#close-settings');
    step('settings drawer opens, fills and saves');

    mock.log('warn', 'gate test log line');
    await page.waitForFunction(() => document.getElementById('logs').textContent.includes('gate test log line'), null, { timeout: 3000 });
    step('logs stream');

    mock.setStatus({ state: 'disconnected', lastError: 'connect ECONNREFUSED' });
    await page.waitForSelector('#conn-status[data-state="disconnected"]', { timeout: 3000 });
    step('disconnected state renders');

    if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
    step('zero console errors');
    await browser.close();
    await mock.close();
    return { ok: true, detail: steps.join('; ') };
  } catch (e) {
    await browser.close().catch(() => {});
    await mock.close().catch(() => {});
    const extra = errors.length ? `\n${errors.join('\n')}` : '';
    return { ok: false, detail: `after [${steps.join('; ')}]: ${e.message}${extra}` };
  }
}

/** Runs every check on one HTML file. Never modifies anything. */
export async function runGate(fileArg = 'index.test.html', { quiet = false } = {}) {
  const file = path.resolve(root, fileArg);
  const html = await fs.readFile(file, 'utf8');
  const scripts = extractInlineScripts(html);
  const checks = [
    ['HTML validation', () => checkHtml(file)],
    ['Inline JS syntax', () => checkSyntax(scripts)],
    ['Inline JS lint', () => checkLint(scripts)],
    ['Playwright smoke test', () => smokeTest(file)],
  ];
  const results = [];
  for (const [name, fn] of checks) {
    let r;
    try {
      r = await fn();
    } catch (e) {
      r = { ok: false, detail: e.stack || e.message };
    }
    results.push({ name, ...r });
    if (!quiet) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}${r.ok ? `: ${r.detail}` : `\n      ${String(r.detail).replace(/\n/g, '\n      ')}`}`);
  }
  const ok = results.every((r) => r.ok);
  return { ok, results, file: path.relative(root, file) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] || 'index.test.html';
  console.log(`UI gate: ${target}\n`);
  const { ok } = await runGate(target);
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: UI gate for ${target}`);
  process.exit(ok ? 0 : 1);
}
