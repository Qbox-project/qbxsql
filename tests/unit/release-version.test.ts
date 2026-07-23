import { describe, expect, test } from 'bun:test';

import { publicManifestVersion } from '../../scripts/release-lib.mjs';

describe('public manifest version', () => {
  test('exposes oxmysql until qbxsql surpasses its compatibility version', () => {
    expect(publicManifestVersion('0.3.0')).toBe('2.14.1');
    expect(publicManifestVersion('2.14.1')).toBe('2.14.1');
    expect(publicManifestVersion('2.14.2')).toBe('2.14.2');
    expect(publicManifestVersion('3.0.0')).toBe('3.0.0');
  });

  test('compares prereleases using semantic-version precedence', () => {
    expect(publicManifestVersion('2.15.0-rc.1')).toBe('2.15.0-rc.1');
    expect(() => publicManifestVersion('development')).toThrow('Invalid semantic version');
  });
});
