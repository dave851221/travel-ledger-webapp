import { describe, expect, it } from 'vitest';
import { resolveMember } from './member';

describe('resolveMember', () => {
  const members = ['代杰', '賢佑', '文暄', '家蓉'];
  it('LINE 全名對到成員', () => {
    expect(resolveMember('張代杰', members)).toBe('代杰');
    expect(resolveMember('蕭賢佑', members)).toBe('賢佑');
    expect(resolveMember('文暄', members)).toBe('文暄');
  });
  it('對不上或有歧義回 null', () => {
    expect(resolveMember('路人', members)).toBeNull();
    expect(resolveMember('小明', ['王小明', '李小明'])).toBeNull();
    expect(resolveMember(null, members)).toBeNull();
  });
});
