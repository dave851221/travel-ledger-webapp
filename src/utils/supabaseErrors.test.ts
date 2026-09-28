import { describe, it, expect } from 'vitest';
import { isNotFoundError } from './supabaseErrors';

describe('isNotFoundError', () => {
  it('.single() 查無資料（PGRST116）算不存在', () => {
    expect(isNotFoundError({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })).toBe(true);
  });

  it('id 不是合法 UUID（22P02）算不存在', () => {
    expect(isNotFoundError({ code: '22P02', message: 'invalid input syntax for type uuid' })).toBe(true);
  });

  it('網路斷線不算 —— 不能因此把使用者踢回首頁', () => {
    expect(isNotFoundError({ code: '', message: 'TypeError: Failed to fetch' })).toBe(false);
    expect(isNotFoundError(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('null / undefined 不算', () => {
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});
