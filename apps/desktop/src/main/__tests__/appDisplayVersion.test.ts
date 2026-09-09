import { describe, expect, it } from 'vitest';

import { normalizeAppVersionTag, resolveDevelopmentAppVersion } from '../appDisplayVersion';

describe('app display version', () => {
  it('优先使用上游主线标签', () => {
    expect(
      resolveDevelopmentAppVersion({
        packagedVersion: '0.0.0',
        upstreamTag: 'v0.1.76-beta',
        headTag: 'v0.1.70-beta',
      }),
    ).toBe('0.1.76-beta');
  });

  it('没有上游标签时回退当前 checkout 标签，再回退包内版本', () => {
    expect(
      resolveDevelopmentAppVersion({
        packagedVersion: '0.0.0',
        upstreamTag: null,
        headTag: 'v0.1.70-beta',
      }),
    ).toBe('0.1.70-beta');
    expect(
      resolveDevelopmentAppVersion({
        packagedVersion: '0.0.0',
        upstreamTag: 'not-a-version',
        headTag: null,
      }),
    ).toBe('0.0.0');
  });

  it('支持稳定版和预发布标签，并拒绝额外文本', () => {
    expect(normalizeAppVersionTag('v1.2.3')).toBe('1.2.3');
    expect(normalizeAppVersionTag('1.2.3-rc.1')).toBe('1.2.3-rc.1');
    expect(normalizeAppVersionTag('v1.2')).toBeNull();
    expect(normalizeAppVersionTag('v1.2.3-')).toBeNull();
  });
});
