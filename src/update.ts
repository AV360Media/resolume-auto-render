export const REPO = 'AV360Media/resolume-auto-render';

export interface UpdateInfo {
  current: string;
  latest?: string;
  available: boolean;
  url?: string;
  checkedAt?: number;
  error?: string;
}

/** Compares dotted versions, ignoring a leading v and any -prerelease suffix. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Unauthenticated check against the GitHub Releases API. Never downloads anything. */
export async function checkForUpdate(current: string, fetchImpl: typeof fetch = fetch): Promise<UpdateInfo> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'resolume-auto-render' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return { current, available: false, checkedAt: Date.now(), error: 'No releases published yet' };
    if (!res.ok) return { current, available: false, checkedAt: Date.now(), error: `GitHub returned ${res.status}` };
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    return { current, latest, available: !!latest && compareVersions(latest, current) > 0, url: data.html_url, checkedAt: Date.now() };
  } catch (e) {
    return { current, available: false, checkedAt: Date.now(), error: (e as Error).message };
  }
}
