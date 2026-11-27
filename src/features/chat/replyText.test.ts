import { describe, expect, it } from 'vitest';
import { linkLabel, parseReply } from './replyText';

describe('parseReply', () => {
  it('turns a bullet followed by a map URL into a place card', () => {
    const lines = parseReply('附近有這幾家：\n\n・Muni（4.8★）走路 11 分\nhttps://maps.google.com/?cid=123\n・Umeda Stand（4.7★） https://maps.google.com/?cid=456');
    expect(lines).toEqual([
      { kind: 'text', text: '附近有這幾家：' },
      { kind: 'text', text: '' },
      { kind: 'place', label: 'Muni（4.8★）走路 11 分', url: 'https://maps.google.com/?cid=123' },
      { kind: 'place', label: 'Umeda Stand（4.7★）', url: 'https://maps.google.com/?cid=456' },
    ]);
  });
  it('keeps plain text and lone URLs as text', () => {
    expect(parseReply('看這裡 https://example.com/a')).toEqual([{ kind: 'text', text: '看這裡 https://example.com/a' }]);
  });
  it('labels links shortly', () => {
    expect(linkLabel('https://maps.google.com/?cid=1')).toBe('📍 地圖');
    expect(linkLabel('https://www.example.com/x')).toBe('🔗 example.com');
  });
});
