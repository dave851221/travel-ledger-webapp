/**
 * LIFF 共用工具：載入／初始化 SDK、處理 liff.line.me 進來的網址、存檔後通知機器人。
 *
 * 為什麼要真的走 LIFF（2026-11-19）：存檔後的確認訊息以前一律由 liff-notify 推播，
 * 免費方案每月推播有上限（推給群組時每位成員各算一則），很快就用完。
 * 走 LIFF 開啟時可以用 liff.sendMessages() 以使用者名義送一句「✅ 已記帳」，
 * 機器人收到再用免費的 reply 回完整確認（流程見 supabase/functions/_shared/liffEcho.ts）。
 * 送不出去時退回推播，跟以前一樣。
 */
import { supabase } from '../api/supabase';
import { IS_PUBLIC } from '../config/mode';

/**
 * LIFF app 的 ID（不是密鑰，LINE Developers → LINE Login channel → LIFF）。可用 VITE_LIFF_ID 覆寫。
 * 開放版是另一個 LIFF app（掛在旅行小本本的 LINE Login channel 2012815845 底下，endpoint 是 /next/），
 * 跟 LINE 登入同一個 channel，LIFF 拿到的 access token 才能交給 auth-line 換成網站的登入。
 */
export const LIFF_ID: string = import.meta.env.VITE_LIFF_ID || (IS_PUBLIC ? '2012815845-0THqm2DV' : '2012713943-msELyw4c');

/** 存檔後通知機器人的 Edge Function：開放版是 tlb-liff-notify（要登入、是成員，寫 app schema、用旅行喵喵的金鑰） */
const NOTIFY_FN = IS_PUBLIC ? 'tlb-liff-notify' : 'liff-notify';

const SDK_URL = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

let ready: LiffSDK | null = null;

async function loadSdk(): Promise<LiffSDK | null> {
  if (!window.liff) {
    await new Promise<void>((resolve) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.onload = () => resolve();
      script.onerror = () => resolve(); // 載入失敗也繼續，後續以 window.close() 補底
      document.head.appendChild(script);
    });
  }
  return window.liff ?? null;
}

/**
 * 初始化 LIFF。沒設 LIFF_ID、SDK 載不到或 init 失敗都回 null（頁面照常能用，只是關不掉視窗、不能代送訊息）。
 * ⚠️ 只有在 LINE 的 LIFF 瀏覽器裡才會要求登入：舊卡片直接開 GitHub Pages 網址（LINE 內建瀏覽器）時
 *    isInClient() 是 false，硬叫 login() 會把人丟到 LINE 登入頁，編輯頁就打不開了。
 */
export async function initLiff(): Promise<LiffSDK | null> {
  if (ready) return ready;
  if (!LIFF_ID) return null;
  const liff = await loadSdk();
  if (!liff) return null;
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (e) {
    console.error('[LIFF] init error:', e);
    return null;
  }
  if (liff.isInClient() && !liff.isLoggedIn()) {
    liff.login();
    return null;
  }
  ready = liff;
  return liff;
}

/** 打開這個 LIFF 頁的人的 LINE 名稱。拿不到（不在 LINE 裡、沒開 profile scope）就回 null */
export async function getLiffDisplayName(liff: LiffSDK | null): Promise<string | null> {
  if (!liff || !liff.isInClient()) return null;
  try {
    const profile = await liff.getProfile();
    return profile?.displayName?.trim() || null;
  } catch (e) {
    console.warn('[LIFF] getProfile failed:', e);
    return null;
  }
}

/** 這個頁面能不能用 sendMessages 把話送進開啟它的那個聊天室 */
function canSendMessages(liff: LiffSDK | null): liff is LiffSDK {
  if (!liff) return false;
  try {
    const type = liff.getContext()?.type;
    return liff.isInClient() && (type === 'utou' || type === 'group' || type === 'room');
  } catch {
    return false;
  }
}

/**
 * liff.line.me 開進來的網址。卡片用 `https://liff.line.me/<LIFF_ID>?route=/liff/edit&tripId=…`：
 * - 第一次落地是 `?liff.state=%3Froute%3D…`：交給 SDK 的 init 轉到第二次落地；
 * - 第二次落地是 `?route=/liff/edit&tripId=…`：改寫成 HashRouter 認得的 `#/liff/edit?tripId=…`（不重新載入）。
 * 回傳 true 表示 SDK 正在轉頁，先不要 render。
 */
export async function resolveLiffEntryUrl(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const state = params.get('liff.state');
  if (state !== null) {
    if (LIFF_ID && await loadSdk()) {
      try {
        await window.liff!.init({ liffId: LIFF_ID });
        // init 會自己轉到 endpoint + liff.state；轉過去之前這頁不必畫
        if (new URLSearchParams(window.location.search).has('liff.state')) {
          rewriteToHash(new URLSearchParams(state.replace(/^[^?]*\?/, '')));
        }
        return false;
      } catch (e) {
        console.error('[LIFF] entry init error:', e);
      }
    }
    rewriteToHash(new URLSearchParams(state.replace(/^[^?]*\?/, '')));
    return false;
  }
  if (params.has('route')) rewriteToHash(params);
  return false;
}

function rewriteToHash(params: URLSearchParams) {
  const route = params.get('route');
  if (!route || !route.startsWith('/liff/')) return;
  const rest = new URLSearchParams();
  params.forEach((v, k) => { if (k !== 'route' && k !== 'liff.state') rest.append(k, v); });
  const query = rest.toString();
  window.history.replaceState(null, '', `${import.meta.env.BASE_URL}#${route}${query ? `?${query}` : ''}`);
}

export type LineNotifyResult = 'ok' | 'quota' | 'failed';

/**
 * 存檔後讓 LINE 聊天室收到確認訊息。
 * 在 LIFF 裡：liff-notify 準備好完整確認、回一句暗號 → sendMessages 以使用者名義送出 → 機器人免費 reply。
 * 不在 LIFF 裡、或送不出去：liff-notify 用推播送（每月有額度）。
 */
export async function notifyLineAfterSave(body: Record<string, unknown>): Promise<LineNotifyResult> {
  if (canSendMessages(ready)) {
    const { data, error } = await supabase.functions.invoke(NOTIFY_FN, { body: { ...body, deliver: 'client' } });
    if (!error && typeof data?.marker === 'string') {
      try {
        await ready.sendMessages([{ type: 'text', text: data.marker }]);
        return 'ok';
      } catch (e) {
        console.error('[LIFF] sendMessages error:', e);
      }
    }
    // 暗號那一列（與 saved 列）已經寫好了，推播補送時不要再寫一次 saved
    return push({ ...body, record: data ? false : undefined });
  }
  return push(body);
}

async function push(body: Record<string, unknown>): Promise<LineNotifyResult> {
  const { data, error } = await supabase.functions.invoke(NOTIFY_FN, { body });
  if (data?.reason === 'line_quota') return 'quota';
  if (error) {
    console.error('[LIFF] notify error:', error);
    return 'failed';
  }
  return 'ok';
}
