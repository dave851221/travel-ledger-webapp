import { describe, it, expect } from 'vitest';
import { isSubmitEnter } from './keyboard';

describe('isSubmitEnter', () => {
  it('一般的 Enter 算送出', () => {
    expect(isSubmitEnter({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } })).toBe(true);
  });

  it('注音選字時的 Enter 不算', () => {
    expect(isSubmitEnter({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: true } })).toBe(false);
  });

  it('舊版 Safari 組字期間回報 keyCode 229，也不算', () => {
    expect(isSubmitEnter({ key: 'Enter', keyCode: 229 })).toBe(false);
  });

  it('其他按鍵不算', () => {
    expect(isSubmitEnter({ key: 'a', keyCode: 65 })).toBe(false);
  });
});
