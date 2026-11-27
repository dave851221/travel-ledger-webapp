import { describe, expect, it } from 'vitest';
import { quotaMessage } from './quotaErrors';

describe('quotaMessage', () => {
  it('maps the database limit codes', () => {
    expect(quotaMessage({ message: 'entry_limit' })).toContain('記帳筆數');
    expect(quotaMessage(new Error('database error, code: P0001'))).toContain('照片');
    expect(quotaMessage(new Error('photo_limit'))).toContain('照片');
  });
  it('leaves other errors alone', () => {
    expect(quotaMessage(new Error('new row violates row-level security policy'))).toBeNull();
    expect(quotaMessage('boom')).toBeNull();
  });
});
