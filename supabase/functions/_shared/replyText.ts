/**
 * 回覆排版：條列的地點＋地圖網址 → 結構化的「地點」項目（LINE 畫成 Flex 卡片）。
 * 與前端 src/features/chat/replyText.ts 同一份邏輯（Deno 無法 import 前端檔案），改一邊要同步另一邊。
 */

export const URL_PATTERN = /(https?:\/\/[^\s<>「」（）()]+)/g;
const BULLET = /^\s*(?:[・•\-*]|\d+[.、)])\s*/;

export const isUrl = (p: string): boolean => /^https?:\/\//.test(p);

export const isMapUrl = (u: string): boolean =>
  /(^https?:\/\/(www\.)?google\.[^/]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps)/.test(u);

/** 長網址不印出來：地圖連結寫「地圖」，其他寫網域 */
export function linkLabel(u: string): string {
  if (isMapUrl(u)) return '📍 地圖';
  try { return `🔗 ${new URL(u).hostname.replace(/^www\./, '')}`; } catch { return '🔗 連結'; }
}

export type ReplyLine = { kind: 'text'; text: string } | { kind: 'place'; label: string; url: string };

const urlsIn = (line: string): string[] => line.match(URL_PATTERN) ?? [];
const withoutUrls = (line: string): string => line.replace(URL_PATTERN, '').trim();

export function parseReply(text: string): ReplyLine[] {
  const out: ReplyLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const urls = urlsIn(line);
    const rest = withoutUrls(line);
    const prev = out[out.length - 1];
    // 這一行只有網址：接到上一個還沒有網址的條列項目
    if (urls.length === 1 && rest === '' && prev?.kind === 'text' && BULLET.test(prev.text) && urlsIn(prev.text).length === 0) {
      out[out.length - 1] = { kind: 'place', label: prev.text.replace(BULLET, '').trim(), url: urls[0] };
      continue;
    }
    // 條列項目後面直接帶一個網址
    const label = rest.replace(BULLET, '').replace(/[：:]\s*$/, '').trim();
    if (urls.length === 1 && BULLET.test(line) && label) {
      out.push({ kind: 'place', label, url: urls[0] });
      continue;
    }
    out.push({ kind: 'text', text: line });
  }
  return out;
}
