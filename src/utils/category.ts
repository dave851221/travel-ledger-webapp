const KEYWORD_COLORS: Array<[RegExp, string]> = [
  [/食|飯|餐/, 'bg-orange-500 text-white'],
  [/住|宿|店/, 'bg-blue-500 text-white'],
  [/行|車|交通/, 'bg-emerald-500 text-white'],
  [/樂|玩|門票/, 'bg-purple-500 text-white'],
  [/買|物|街/, 'bg-rose-500 text-white'],
  [/結清/, 'bg-slate-700 text-white'],
];

const PALETTE = [
  'bg-indigo-500',
  'bg-cyan-500',
  'bg-teal-500',
  'bg-amber-500',
  'bg-pink-500',
  'bg-violet-500',
  'bg-sky-500',
  'bg-lime-500',
  'bg-fuchsia-500',
  'bg-orange-400',
  'bg-red-500',
  'bg-green-600',
];

function polyHash(str: string): number {
  let h = 0;
  for (const ch of str) {
    h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(h);
}

/**
 * Returns a Tailwind bg+text color pair for a category badge.
 * Pass the trip's full categories array so each custom category
 * gets a deterministically distinct color via its array index.
 */
export function getCategoryColor(category: string, categories?: string[]): string {
  for (const [re, color] of KEYWORD_COLORS) {
    if (re.test(category)) return color;
  }

  if (categories) {
    const idx = categories.indexOf(category);
    if (idx >= 0) return `${PALETTE[idx % PALETTE.length]} text-white`;
  }

  return `${PALETTE[polyHash(category) % PALETTE.length]} text-white`;
}
