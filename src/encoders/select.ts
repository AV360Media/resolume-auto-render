import type { Codec, Quality, Unsatisfiable } from '../settings.js';
import type { Capabilities, Encoder } from './types.js';

export interface Probed {
  encoder: Encoder;
  caps: Capabilities;
}

export interface Want {
  codec: Codec;
  quality: Quality;
  alpha: boolean;
}

export interface Policy {
  /** Preferred backend id or 'auto'. */
  backend: string;
  onHqUnavailable: Unsatisfiable;
  onAlphaUnavailable: Unsatisfiable;
}

export type Selection =
  | { kind: 'encode'; encoder: Encoder; quality: Quality; alpha: boolean; warnings: string[] }
  | { kind: 'skip'; reason: string };

const fits = (c: Capabilities, w: Want) => c.available && c.codec === w.codec && c.qualities.includes(w.quality) && (!w.alpha || c.alpha);

/**
 * Picks the first available backend (in priority order, preferred one first) that satisfies the request.
 * If none does, applies the policy: downgrade with a warning, or skip.
 */
export function selectEncoder(probed: Probed[], want: Want, policy: Policy): Selection {
  const ordered = [...probed].sort((a, b) => (a.encoder.id === policy.backend ? -1 : b.encoder.id === policy.backend ? 1 : 0));
  const pool = ordered.filter((p) => p.caps.available && p.caps.codec === want.codec);
  if (!pool.length) {
    const why = probed.filter((p) => p.caps.codec === want.codec).map((p) => `${p.encoder.label}: ${p.caps.reason || 'unavailable'}`);
    return { kind: 'skip', reason: `No ${want.codec.toUpperCase()} encoder available. ${why.join('; ')}` };
  }
  const exact = pool.find((p) => fits(p.caps, want));
  if (exact) return { kind: 'encode', encoder: exact.encoder, quality: want.quality, alpha: want.alpha, warnings: [] };

  const warnings: string[] = [];
  let quality = want.quality;
  let alpha = want.alpha;
  if (alpha && !pool.some((p) => p.caps.alpha)) {
    if (policy.onAlphaUnavailable === 'skip') return { kind: 'skip', reason: 'Source has alpha and no installed encoder keeps alpha. Kept the original.' };
    alpha = false;
    warnings.push('Alpha dropped: no installed encoder keeps alpha. Transparent areas will be black.');
  }
  if (quality === 'high' && !pool.some((p) => p.caps.qualities.includes('high') && (!alpha || p.caps.alpha))) {
    if (policy.onHqUnavailable === 'skip') return { kind: 'skip', reason: 'High Quality requested and no installed encoder supports it. Kept the original.' };
    quality = 'normal';
    warnings.push('Encoded as Normal Quality: no installed encoder supports High Quality.');
  }
  const adjusted = { ...want, quality, alpha };
  const pick = pool.find((p) => fits(p.caps, adjusted));
  if (!pick) {
    // Alpha and HQ exist on different backends; prefer keeping alpha.
    const alphaOnly = pool.find((p) => fits(p.caps, { ...adjusted, quality: 'normal' }));
    if (alphaOnly) {
      warnings.push('Encoded as Normal Quality: the only encoder that keeps alpha has no High Quality.');
      return { kind: 'encode', encoder: alphaOnly.encoder, quality: 'normal', alpha, warnings };
    }
    return { kind: 'skip', reason: 'No installed encoder can handle this request.' };
  }
  return { kind: 'encode', encoder: pick.encoder, quality, alpha, warnings };
}
