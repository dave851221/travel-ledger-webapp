import { describe, expect, it } from 'vitest';
import type { Expense, Trip } from '../../types';
import { changeAmount, changeCurrency, canGoSolo, soloDraft, toggleMember, draftToExpense } from './draftOps';
import { applyBlocks, lastSavedDraft, pendingDrafts } from './chatStore';
import { matchQuickCommand, runQuickCommand } from './quick';
import type { ChatItem, DraftExpense, WebDraft } from './types';

const trip: Trip = {
  id: 't1', name: '名古屋', members: ['代杰', '艷櫻', '小明'], categories: ['餐飲', '交通'],
  base_currency: 'TWD', rates: { TWD: 1, JPY: 0.21 }, precision_config: { TWD: 0, JPY: 0, USD: 2 },
  is_archived: false, created_at: '2026-11-01', timezone: 'Asia/Tokyo',
};

const exp = (over: Partial<DraftExpense> = {}): DraftExpense => ({
  d: '拉麵', a: 3000, c: 'JPY', dt: '2026-11-20', cat: '餐飲',
  p: { 代杰: 3000 }, s: { 代杰: 1000, 艷櫻: 1000, 小明: 1000 }, ...over,
});

const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

describe('draftOps', () => {
  it('改金額時付款與分攤照原本的人重新均分，Σ 一定等於總額', () => {
    const next = changeAmount(exp(), trip, 1000);
    expect(next.a).toBe(1000);
    expect(next.p).toEqual({ 代杰: 1000 });
    expect(sum(next.s)).toBe(1000);
    // 付款人也在分攤裡，尾差給他
    expect(next.s.代杰).toBe(334);
  });

  it('點成員加入或移出分攤，至少留一個人', () => {
    const two = toggleMember(exp(), trip, 's', '小明');
    expect(Object.keys(two.s)).toEqual(['代杰', '艷櫻']);
    expect(sum(two.s)).toBe(3000);
    const one = toggleMember(toggleMember(two, trip, 's', '艷櫻'), trip, 's', '代杰');
    expect(Object.keys(one.s)).toEqual(['代杰']);
  });

  it('只算我', () => {
    expect(soloDraft(exp(), trip, '艷櫻')).toMatchObject({ p: { 艷櫻: 3000 }, s: { 艷櫻: 3000 } });
    expect(canGoSolo(exp({ p: { 小明: 3000 }, s: { 小明: 3000 } }), trip, '小明')).toBe(false);
    expect(canGoSolo(exp(), trip, null)).toBe(false);
  });

  it('換幣別只換標籤不換算，精度變了照新精度重算', () => {
    const usd = exp({ c: 'USD', a: 10.5, p: { 代杰: 10.5 }, s: { 代杰: 3.5, 艷櫻: 3.5, 小明: 3.5 } });
    const twd = changeCurrency(usd, trip, 'TWD');
    expect(twd.c).toBe('TWD');
    expect(twd.a).toBe(11);
    expect(sum(twd.p)).toBe(11);
    expect(sum(twd.s)).toBe(11);
  });

  it('打開完整表單時是沒有 id 的新增，收據照片標成收據', () => {
    const draft: WebDraft = { nonce: 'n1', exp: exp(), photoIds: ['expenses/t1/a.jpg'], receipt: true, items: [] };
    const e = draftToExpense(draft, trip);
    expect(e.id).toBe('');
    expect(e.receipt_photo_urls).toEqual(['expenses/t1/a.jpg']);
    expect(e.split_data).toEqual(draft.exp.s);
  });
});

describe('chatStore', () => {
  const draft = (nonce: string): WebDraft => ({ nonce, exp: exp(), photoIds: [], receipt: false, items: [] });

  it('修正草稿時舊卡標成「已更新」，新卡接在後面', () => {
    let items = applyBlocks([], [{ type: 'draft', draft: draft('old'), title: '🤖' }], 1)
    items = applyBlocks(items, [
      { type: 'text', text: '好的' },
      { type: 'draft', draft: draft('new'), title: '🤖', replaces: 'old' },
    ], 2);
    expect(items.map(i => (i.kind === 'draft' ? `${i.draft.nonce}:${i.status}` : i.kind))).toEqual(['old:replaced', 'text', 'new:pending']);
    expect(pendingDrafts(items).map(d => d.nonce)).toEqual(['new']);
  });

  it('幣別沒有匯率的照片卡帶著可選的幣別', () => {
    const items = applyBlocks([], [{ type: 'currency', draft: draft('c'), text: '沒有 USD 的匯率', currencies: ['TWD', 'JPY'] }], 1);
    expect(items[0]).toMatchObject({ kind: 'text', text: '沒有 USD 的匯率' });
    expect(items[1]).toMatchObject({ kind: 'draft', currencies: ['TWD', 'JPY'], status: 'pending' });
  });

  it('「取消上一筆」找最近一張存入、還沒撤銷的', () => {
    const items: ChatItem[] = [
      { id: 'a', at: 1, role: 'bot', kind: 'draft', draft: draft('a'), title: '', status: 'saved', expenseId: 'e1' },
      { id: 'b', at: 2, role: 'bot', kind: 'draft', draft: draft('b'), title: '', status: 'undone', expenseId: 'e2' },
    ];
    expect(lastSavedDraft(items)?.expenseId).toBe('e1');
  });
});

describe('quick', () => {
  const e = (over: Partial<Expense>): Expense => ({
    id: Math.random().toString(), trip_id: 't1', date: '2026-11-20', category: '餐飲', description: '拉麵',
    amount: 1000, currency: 'JPY', payer_data: {}, split_data: {}, adjustment_member: null, photo_urls: [],
    is_settlement: false, deleted_at: null, created_at: '2026-11-20T10:00:00Z', ...over,
  });

  it('只認整句相符的關鍵字', () => {
    expect(matchQuickCommand('結算')).toBe('settle');
    expect(matchQuickCommand('結算好了嗎')).toBeNull();
    expect(matchQuickCommand(' 今日支出 ')).toBe('today');
  });

  it('今日支出用旅程時區的今天，不含結清，合計走 decimal', () => {
    const now = new Date('2026-11-20T15:30:00Z'); // 東京 11/21 00:30
    const rows = [
      e({ date: '2026-11-21', amount: 1200 }),
      e({ date: '2026-11-21', amount: 800 }),
      e({ date: '2026-11-21', amount: 500, is_settlement: true }),
      e({ date: '2026-11-20', amount: 9999 }),
    ];
    const card = runQuickCommand('today', trip, rows, {}, now);
    expect(typeof card).toBe('object');
    if (typeof card === 'object') {
      expect(card.sections[0].rows).toHaveLength(2);
      expect(card.totals[0]).toContain('2 筆');
      expect(card.totals[0]).toContain('¥2,000');
    }
  });

  it('沒有資料時回一句話；已結清時說不用轉帳', () => {
    expect(runQuickCommand('today', trip, [], {}, new Date('2026-11-20T00:00:00Z'))).toContain('尚無支出');
    expect(runQuickCommand('settle', trip, [], { 代杰: 0, 艷櫻: 0 })).toContain('已結清');
  });

  it('結算給出最少轉帳', () => {
    const card = runQuickCommand('settle', trip, [], { 代杰: 300, 艷櫻: -300, 小明: 0 });
    expect(typeof card === 'object' && card.sections[0].rows[0]).toMatchObject({ label: '艷櫻 → 代杰', value: 'NT$300' });
  });
});
