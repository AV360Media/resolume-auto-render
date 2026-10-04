import { describe, it, expect } from 'vitest';
import { selectEncoder, type Probed } from '../../src/encoders/select.js';
import type { Capabilities, Encoder } from '../../src/encoders/types.js';

const enc = (id: string): Encoder => ({ id, label: id, probe: async () => ({}) as Capabilities, encode: async () => {}, expect: () => ({ codec: 'dxv' }) });
const p = (id: string, caps: Partial<Capabilities>): Probed => ({
  encoder: enc(id),
  caps: { available: true, codec: 'dxv', qualities: ['normal'], alpha: false, notes: [], ...caps },
});
const policy = { backend: 'auto', onHqUnavailable: 'downgrade' as const, onAlphaUnavailable: 'skip' as const };

describe('selectEncoder', () => {
  const ffmpeg = p('ffmpeg-dxv', {});
  const ame = p('ame', { qualities: ['normal', 'high'], alpha: true });
  const alleyOff = p('alley-cli', { available: false, qualities: ['normal', 'high'], alpha: true });

  it('picks the first available in priority order', () => {
    const s = selectEncoder([alleyOff, ffmpeg, ame], { codec: 'dxv', quality: 'normal', alpha: false }, policy);
    expect(s.kind === 'encode' && s.encoder.id).toBe('ffmpeg-dxv');
  });
  it('routes HQ and alpha to a better backend', () => {
    const s = selectEncoder([alleyOff, ffmpeg, ame], { codec: 'dxv', quality: 'high', alpha: true }, policy);
    expect(s.kind === 'encode' && s.encoder.id).toBe('ame');
    expect(s.kind === 'encode' && s.warnings).toEqual([]);
  });
  it('honors the preferred backend', () => {
    const s = selectEncoder([ffmpeg, ame], { codec: 'dxv', quality: 'normal', alpha: false }, { ...policy, backend: 'ame' });
    expect(s.kind === 'encode' && s.encoder.id).toBe('ame');
  });
  it('downgrades HQ with a warning when only ffmpeg exists', () => {
    const s = selectEncoder([ffmpeg], { codec: 'dxv', quality: 'high', alpha: false }, policy);
    expect(s.kind).toBe('encode');
    if (s.kind === 'encode') {
      expect(s.quality).toBe('normal');
      expect(s.warnings[0]).toMatch(/Normal Quality/);
    }
  });
  it('skips HQ when policy says skip', () => {
    const s = selectEncoder([ffmpeg], { codec: 'dxv', quality: 'high', alpha: false }, { ...policy, onHqUnavailable: 'skip' });
    expect(s.kind).toBe('skip');
  });
  it('skips alpha sources by default when alpha is impossible', () => {
    const s = selectEncoder([ffmpeg], { codec: 'dxv', quality: 'normal', alpha: true }, policy);
    expect(s.kind).toBe('skip');
    if (s.kind === 'skip') expect(s.reason).toMatch(/alpha/);
  });
  it('drops alpha with a warning when policy allows', () => {
    const s = selectEncoder([ffmpeg], { codec: 'dxv', quality: 'normal', alpha: true }, { ...policy, onAlphaUnavailable: 'downgrade' });
    expect(s.kind === 'encode' && s.alpha).toBe(false);
    expect(s.kind === 'encode' && s.warnings[0]).toMatch(/Alpha dropped/);
  });
  it('prefers keeping alpha over HQ when no backend does both', () => {
    const alphaNormal = p('x-alpha', { alpha: true });
    const hqNoAlpha = p('y-hq', { qualities: ['normal', 'high'] });
    const s = selectEncoder([hqNoAlpha, alphaNormal], { codec: 'dxv', quality: 'high', alpha: true }, policy);
    expect(s.kind === 'encode' && s.encoder.id).toBe('x-alpha');
    expect(s.kind === 'encode' && s.quality).toBe('normal');
  });
  it('skips when nothing is available for the codec', () => {
    const s = selectEncoder([alleyOff], { codec: 'dxv', quality: 'normal', alpha: false }, policy);
    expect(s.kind).toBe('skip');
    const h = selectEncoder([ffmpeg], { codec: 'hap', quality: 'normal', alpha: false }, policy);
    expect(h.kind).toBe('skip');
  });
});
