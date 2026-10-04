import { describe, it, expect } from 'vitest';
import {
  mediaKind, outputPathFor, uniquePath, partialPathFor, toFileUri, fromArenaPath, samePath, toLongPath,
  isProbablyNetworkPath, isInside, matchesIgnore,
} from '../../src/paths.js';

describe('mediaKind', () => {
  it('classifies by extension, case-insensitive', () => {
    expect(mediaKind('/a/b.MOV')).toBe('video');
    expect(mediaKind('/a/b.mp4')).toBe('video');
    expect(mediaKind('/a/b.png')).toBe('image');
    expect(mediaKind('/a/b.WAV')).toBe('audio');
    expect(mediaKind('/a/b.xyz')).toBe('other');
    expect(mediaKind('/a/b')).toBe('other');
  });
});

describe('outputPathFor', () => {
  it('defaults to <folder>/DXV/<name>.mov', () => {
    expect(outputPathFor('/clips/My Clip.mp4', { outputFolder: '', codec: 'dxv' }, 'darwin')).toBe('/clips/DXV/My Clip.mov');
    expect(outputPathFor('C:\\clips\\a b.avi', { outputFolder: '', codec: 'dxv' }, 'win32')).toBe('C:\\clips\\DXV\\a b.mov');
  });
  it('uses HAP folder for HAP and a shared folder when set', () => {
    expect(outputPathFor('/clips/x.mov', { outputFolder: '', codec: 'hap' }, 'linux')).toBe('/clips/HAP/x.mov');
    expect(outputPathFor('/clips/x.mov', { outputFolder: '/out', codec: 'dxv' }, 'linux')).toBe('/out/x.mov');
  });
  it('keeps unicode and dots in names', () => {
    expect(outputPathFor('/clips/Ünïcødé 日本.v2.mp4', { outputFolder: '', codec: 'dxv' }, 'linux')).toBe('/clips/DXV/Ünïcødé 日本.v2.mov');
  });
});

describe('uniquePath', () => {
  it('appends (n) until free', async () => {
    const taken = new Set(['/o/a.mov', '/o/a (1).mov']);
    expect(await uniquePath('/o/a.mov', async (p) => taken.has(p), 'linux')).toBe('/o/a (2).mov');
    expect(await uniquePath('/o/b.mov', async (p) => taken.has(p), 'linux')).toBe('/o/b.mov');
  });
});

describe('partialPathFor', () => {
  it('is a hidden sibling', () => {
    expect(partialPathFor('/o/a.mov', 'linux')).toBe('/o/.a.partial.mov');
  });
});

describe('toFileUri / fromArenaPath', () => {
  it('builds raw URIs like the Companion module', () => {
    expect(toFileUri('C:\\clips\\my clip.mov', 'raw', 'win32')).toBe('file:///C:/clips/my clip.mov');
    expect(toFileUri('/Users/me/my clip.mov', 'raw', 'darwin')).toBe('file:///Users/me/my clip.mov');
  });
  it('builds encoded URIs', () => {
    expect(toFileUri('C:\\clips\\my clip#1.mov', 'encoded', 'win32')).toBe('file:///C:/clips/my%20clip%231.mov');
    expect(toFileUri('/Users/me/日本.mov', 'encoded', 'darwin')).toBe('file:///Users/me/%E6%97%A5%E6%9C%AC.mov');
  });
  it('handles UNC paths', () => {
    expect(toFileUri('\\\\nas\\share\\a b.mov', 'raw', 'win32')).toBe('file://nas/share/a b.mov');
    expect(fromArenaPath('file://nas/share/a%20b.mov', 'win32')).toBe('\\\\nas\\share\\a b.mov');
  });
  it('round-trips', () => {
    for (const [p, plat] of [['C:\\a b\\ü.mov', 'win32'], ['/Users/x/a b/ü.mov', 'darwin']] as const) {
      expect(fromArenaPath(toFileUri(p, 'encoded', plat), plat)).toBe(p);
      expect(fromArenaPath(toFileUri(p, 'raw', plat), plat)).toBe(p);
    }
  });
  it('accepts plain paths and empty values', () => {
    expect(fromArenaPath('C:/clips/a.mov', 'win32')).toBe('C:\\clips\\a.mov');
    expect(fromArenaPath('', 'win32')).toBe('');
    expect(fromArenaPath(undefined)).toBe('');
  });
  it('normalizes unicode to NFC', () => {
    const nfd = '/x/Cafe\u0301.mov';
    expect(fromArenaPath(nfd, 'darwin')).toBe('/x/Caf\u00e9.mov');
  });
});

describe('samePath', () => {
  it('is case-insensitive on Windows and macOS only', () => {
    expect(samePath('C:\\A\\b.mov', 'c:/a/B.MOV', 'win32')).toBe(true);
    expect(samePath('/A/b.mov', '/a/b.mov', 'darwin')).toBe(true);
    expect(samePath('/A/b.mov', '/a/b.mov', 'linux')).toBe(false);
  });
  it('treats NFC and NFD as equal', () => {
    expect(samePath('/x/Caf\u00e9.mov', '/x/Cafe\u0301.mov', 'darwin')).toBe(true);
  });
  it('is false for empty', () => {
    expect(samePath('', '', 'linux')).toBe(false);
  });
});

describe('toLongPath', () => {
  it('prefixes long Windows paths only', () => {
    const long = 'C:\\' + 'a'.repeat(300) + '\\x.mov';
    expect(toLongPath(long, 'win32')).toBe('\\\\?\\' + long);
    expect(toLongPath('C:\\short.mov', 'win32')).toBe('C:\\short.mov');
    expect(toLongPath('/' + 'a'.repeat(300), 'darwin')).toBe('/' + 'a'.repeat(300));
    const unc = '\\\\nas\\share\\' + 'b'.repeat(300);
    expect(toLongPath(unc, 'win32')).toBe('\\\\?\\UNC\\nas\\share\\' + 'b'.repeat(300));
  });
});

describe('network and containment', () => {
  it('flags UNC and /Volumes', () => {
    expect(isProbablyNetworkPath('\\\\nas\\x', 'win32')).toBe(true);
    expect(isProbablyNetworkPath('D:\\x', 'win32')).toBe(false);
    expect(isProbablyNetworkPath('/Volumes/NAS/x', 'darwin')).toBe(true);
    expect(isProbablyNetworkPath('/Users/x', 'darwin')).toBe(false);
  });
  it('isInside', () => {
    expect(isInside('/a/b/c.mov', '/a', 'linux')).toBe(true);
    expect(isInside('/ab/c.mov', '/a', 'linux')).toBe(false);
    expect(isInside('C:\\A\\b.mov', 'c:\\a', 'win32')).toBe(true);
  });
});

describe('matchesIgnore', () => {
  it('matches exact paths and patterns', () => {
    const pats = ['/shows/keep.mov', '*.webm', '/archive/**', 'loop_??.mp4'];
    expect(matchesIgnore('/shows/keep.mov', pats, 'linux')).toBe(true);
    expect(matchesIgnore('/x/y/z.webm', pats, 'linux')).toBe(true);
    expect(matchesIgnore('/archive/deep/a.mov', pats, 'linux')).toBe(true);
    expect(matchesIgnore('/x/loop_01.mp4', pats, 'linux')).toBe(true);
    expect(matchesIgnore('/x/loop_001.mp4', pats, 'linux')).toBe(false);
    expect(matchesIgnore('/x/a.mov', pats, 'linux')).toBe(false);
  });
  it('handles Windows separators and case', () => {
    expect(matchesIgnore('C:\\Shows\\A.MOV', ['c:/shows/*.mov'], 'win32')).toBe(true);
  });
});
