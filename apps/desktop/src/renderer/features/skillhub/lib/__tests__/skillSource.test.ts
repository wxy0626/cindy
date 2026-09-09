import { describe, expect, it } from 'vitest';

import { deriveSkillSource } from '../skillSource';

describe('deriveSkillSource', () => {
  it('treats explicit installed origin as internal', () => {
    // 显式 origin 优先,不受 registry/isMine 影响
    expect(deriveSkillSource('installed', true, false)).toBe('internal');
    expect(deriveSkillSource('installed', true, true)).toBe('internal');
  });

  it('treats explicit published origin as external', () => {
    // 自己发布的本地目录是 dev 副本,没走 SkillHub 安装
    expect(deriveSkillSource('published', true, true)).toBe('external');
  });

  it('treats explicit learned origin as external', () => {
    expect(deriveSkillSource('learned', true, false)).toBe('external');
  });

  it('treats explicit imported origin as external', () => {
    expect(deriveSkillSource('imported', true, false)).toBe('external');
    expect(deriveSkillSource('imported', true, true)).toBe('external');
  });

  it('treats pre-origin registry records as external', () => {
    // 历史遗留:有 registry 记录、origin 缺失,server 明确判定不是我的 → 他人历史安装
    expect(deriveSkillSource(undefined, true, false)).toBe('external');
    expect(deriveSkillSource(null, true, false)).toBe('external');
  });

  it('treats pre-origin own / unknown registry records as external', () => {
    // 我的历史记录(reconcile 会回填为 published);isMine 未知时保守判 local
    expect(deriveSkillSource(undefined, true, true)).toBe('external');
    expect(deriveSkillSource(undefined, true, null)).toBe('external');
    expect(deriveSkillSource(undefined, true, undefined)).toBe('external');
  });

  it('treats hand-authored skills without registry as external', () => {
    // 纯本地手写:无 registry 记录,即便 server 恰好判定 foreign 也不算 skillhub
    expect(deriveSkillSource(undefined, false, null)).toBe('external');
    expect(deriveSkillSource(undefined, false, false)).toBe('external');
  });
});
