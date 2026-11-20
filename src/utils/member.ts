/**
 * 把 LINE 名稱（常是全名，例如「張代杰」）對應回旅程成員（「代杰」）。
 * 規則與 Edge Function 的 `_shared/validate.ts` resolveMember 一致：
 * 完全相同 → 正規化後相同 → 唯一的子字串；有歧義或對不上就回 null。
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s\u3000._-]/g, '').trim();
}

export function resolveMember(name: string | null | undefined, members: string[]): string | null {
  if (!name) return null;
  if (members.includes(name)) return name;
  const target = normalizeName(name);
  if (!target) return null;
  const exact = members.find(m => normalizeName(m) === target);
  if (exact) return exact;
  const partial = members.filter(m => {
    const n = normalizeName(m);
    return n.length > 0 && (n.includes(target) || target.includes(n));
  });
  return partial.length === 1 ? partial[0] : null;
}
