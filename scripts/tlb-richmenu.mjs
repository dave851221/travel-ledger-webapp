// 旅行喵喵的圖文選單（一對一聊天下面那排大按鈕；LINE 群組不會顯示，群組裡靠每則回覆的快速按鈕）。
//
// 用法：node scripts/tlb-richmenu.mjs
//   · 金鑰讀 local/supabase/.env 的 TLB_BOT_ACCESS_TOKEN（不進 git）
//   · 用本機的 Chrome 把 scripts/richmenu/tlb-richmenu.html 截成 2500×843 的 PNG
//   · 建立新選單 → 上傳圖片 → 設成所有人的預設 → 刪掉舊的同名選單（重跑就是更新）
// 按鈕送出的文字要跟 line-webhook 的指令一致（config.ts 的 QUICK_CMD_KEYWORDS 等、bind-public.ts 的「綁定」）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MENU_NAME = 'tlb-main';
const WEBAPP_URL = 'https://dave851221.github.io/travel-ledger-webapp/next/';
const W = 2500, H = 843, CW = Math.floor(W / 3), CH = Math.floor(H / 2);

// 左上 → 右上，再左下 → 右下（跟 HTML 的格子順序一樣）
const ACTIONS = [
  { type: 'message', label: '今日支出', text: '今日支出' },
  { type: 'message', label: '旅程總覽', text: '旅程總覽' },
  { type: 'message', label: '編輯支出', text: '編輯支出' },
  { type: 'message', label: '綁定旅程', text: '綁定' },
  { type: 'uri', label: '打開網頁', uri: WEBAPP_URL },
  { type: 'message', label: '使用說明', text: '使用說明' },
];

const env = Object.fromEntries(readFileSync('local/supabase/.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const TOKEN = env.TLB_BOT_ACCESS_TOKEN;
if (!TOKEN) throw new Error('local/supabase/.env 沒有 TLB_BOT_ACCESS_TOKEN');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome／Edge');
const png = join(mkdtempSync(join(tmpdir(), 'richmenu-')), 'menu.png');
execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`,
  `--screenshot=${png}`, pathToFileURL(resolve('scripts/richmenu/tlb-richmenu.html')).href], { stdio: 'ignore' });

const api = async (method, url, body, contentType = 'application/json') => {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': contentType } : {}) }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
};

const old = (await api('GET', 'https://api.line.me/v2/bot/richmenu/list')).richmenus.filter(m => m.name === MENU_NAME);
const { richMenuId } = await api('POST', 'https://api.line.me/v2/bot/richmenu', JSON.stringify({
  size: { width: W, height: H },
  selected: true,
  name: MENU_NAME,
  chatBarText: '記帳選單',
  areas: ACTIONS.map((action, i) => ({
    bounds: { x: (i % 3) * CW, y: Math.floor(i / 3) * CH, width: i % 3 === 2 ? W - 2 * CW : CW, height: i >= 3 ? H - CH : CH },
    action,
  })),
}));
await api('POST', `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, readFileSync(png), 'image/png');
await api('POST', `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`);
for (const m of old) await api('DELETE', `https://api.line.me/v2/bot/richmenu/${m.richMenuId}`);
console.log(`圖文選單已更新：${richMenuId}（刪掉舊的 ${old.length} 個）`);
