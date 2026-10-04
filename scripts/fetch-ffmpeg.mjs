// npm run fetch-ffmpeg [-- --platform darwin-arm64] [--from /dir/with/ffmpeg] [--force]
// Downloads a static ffmpeg + ffprobe (>= 7.0, with the dxv encoder) for this machine into vendor/ffmpeg/<platform>-<arch>/.
// Verifies it by running a real DXV encode and records hashes in SOURCE.json. The installer bundles that folder.
import { promises as fs, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const plat = opt('--platform') || `${process.platform}-${process.arch}`;
const dest = path.join(root, 'vendor', 'ffmpeg', plat);
const exe = (n) => (plat.startsWith('win32') ? `${n}.exe` : n);

// Candidate sources per platform, tried in order. Each entry is one archive holding both binaries,
// or a pair of archives (ffmpeg, ffprobe).
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const RIEDL = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos';
const SOURCES = {
  'linux-x64': [
    [`${BTBN}/ffmpeg-n7.1-latest-linux64-lgpl-7.1.tar.xz`],
    [`${BTBN}/ffmpeg-master-latest-linux64-lgpl.tar.xz`],
    ['https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'],
  ],
  'win32-x64': [
    [`${BTBN}/ffmpeg-n7.1-latest-win64-lgpl-7.1.zip`],
    [`${BTBN}/ffmpeg-master-latest-win64-lgpl.zip`],
    ['https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'],
  ],
  'darwin-arm64': [
    [`${RIEDL}/arm64/release/ffmpeg.zip`, `${RIEDL}/arm64/release/ffprobe.zip`],
  ],
  'darwin-x64': [
    [`${RIEDL}/amd64/release/ffmpeg.zip`, `${RIEDL}/amd64/release/ffprobe.zip`],
    ['https://evermeet.cx/ffmpeg/getrelease/zip', 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip'],
  ],
};

const sha256 = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'resolume-auto-render-build' } });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

function extract(archive, into) {
  // bsdtar (macOS, Windows 10+) reads zip and tar.xz; GNU tar on Linux reads tar.xz. No shell involved.
  const r = spawnSync('tar', ['-xf', archive, '-C', into], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr || r.error?.message}`);
}

async function findFile(dir, name) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

/** Runs the binaries: version, dxv encoder present, and a real 64x64 DXV encode that decodes back. */
export function verify(dir) {
  const ff = path.join(dir, exe('ffmpeg'));
  const fp = path.join(dir, exe('ffprobe'));
  const v = spawnSync(ff, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error(`ffmpeg does not run: ${v.stderr || v.error?.message}`);
  const version = v.stdout.split('\n')[0];
  const enc = spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout;
  if (!/^\s*V\S*\s+dxv\s/m.test(enc)) throw new Error(`${version}: no dxv encoder (needs ffmpeg >= 7.0)`);
  const tmp = path.join(os.tmpdir(), `rar-verify-${process.pid}.mov`);
  const e = spawnSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=0.2', '-vf', 'format=rgba', '-c:v', 'dxv', tmp], { encoding: 'utf8' });
  if (e.status !== 0) throw new Error(`test DXV encode failed: ${e.stderr}`);
  const p = spawnSync(fp, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_tag_string', '-of', 'csv=p=0', tmp], { encoding: 'utf8' });
  if (p.status !== 0 || !/dxv,DXD3/.test(p.stdout)) throw new Error(`ffprobe check failed: ${p.stdout} ${p.stderr}`);
  return { version, hap: /^\s*V\S*\s+hap\s/m.test(enc) };
}

async function install(urls) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'rar-ffmpeg-'));
  const archives = [];
  for (const [i, url] of urls.entries()) {
    const name = path.basename(new URL(url).pathname) || `a${i}`;
    const file = path.join(work, `${i}-${name}${/\.(zip|xz|gz)$/.test(name) ? '' : '.zip'}`);
    console.log(`  downloading ${url}`);
    await download(url, file);
    archives.push({ url, sha256: await sha256(file) });
    const out = path.join(work, `x${i}`);
    await fs.mkdir(out);
    extract(file, out);
  }
  const ff = await findFile(work, exe('ffmpeg'));
  const fp = await findFile(work, exe('ffprobe'));
  if (!ff || !fp) throw new Error('archive did not contain ffmpeg and ffprobe');
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  for (const [src, n] of [[ff, 'ffmpeg'], [fp, 'ffprobe']]) {
    await fs.copyFile(src, path.join(dest, exe(n)));
    await fs.chmod(path.join(dest, exe(n)), 0o755);
  }
  for (const lic of ['LICENSE', 'LICENSE.txt', 'COPYING.LGPLv2.1', 'COPYING.GPLv3']) {
    const hit = await findFile(work, lic);
    if (hit) await fs.copyFile(hit, path.join(dest, `FFMPEG-${lic}`));
  }
  await fs.rm(work, { recursive: true, force: true });
  return archives;
}

async function main() {
  console.log(`ffmpeg for ${plat} -> ${path.relative(root, dest)}`);
  if (!args.includes('--force')) {
    try {
      const info = verify(dest);
      console.log(`PASS  already present: ${info.version}`);
      return;
    } catch { /* fetch */ }
  }
  const from = opt('--from');
  let archives = [];
  if (from) {
    await fs.mkdir(dest, { recursive: true });
    for (const n of ['ffmpeg', 'ffprobe']) {
      await fs.copyFile(path.join(from, exe(n)), path.join(dest, exe(n)));
      await fs.chmod(path.join(dest, exe(n)), 0o755);
    }
    archives = [{ url: `local:${from}`, sha256: null }];
  } else {
    const candidates = SOURCES[plat];
    if (!candidates) throw new Error(`No ffmpeg source known for ${plat}. Use --from <dir>.`);
    let lastErr;
    for (const urls of candidates) {
      try {
        archives = await install(urls);
        verify(dest);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.log(`  failed: ${e.message}`);
      }
    }
    if (lastErr) throw lastErr;
  }
  const info = verify(dest);
  const record = {
    platform: plat,
    version: info.version,
    hapEncoder: info.hap,
    sources: archives,
    binaries: {
      ffmpeg: await sha256(path.join(dest, exe('ffmpeg'))),
      ffprobe: await sha256(path.join(dest, exe('ffprobe'))),
    },
    verifiedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dest, 'SOURCE.json'), JSON.stringify(record, null, 2));
  console.log(`PASS  ${info.version}\n      dxv encode verified; hap encoder: ${info.hap ? 'yes' : 'no'}\n      sha256 ffmpeg ${record.binaries.ffmpeg}`);
}

main().catch((e) => {
  console.error(`FAIL  ${e.message}`);
  if (args.includes('--optional')) {
    console.error('      Continuing: the app will look for ffmpeg >= 7.0 on PATH or the path set in Settings > Tools.');
    process.exit(0);
  }
  process.exit(1);
});
