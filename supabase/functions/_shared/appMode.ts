// 同一份 LINE 機器人程式服務兩個版本：
//   legacy：舊版「旅遊小本本」的耀西（line-webhook，資料在 public）
//   public：開放版「旅行小本本」的旅行喵喵（tlb-line-webhook，資料在 app）
//
// Supabase 的 secrets 是整個專案共用的，不能靠環境變數分辨是哪一支函式，
// 所以由進入點決定：tlb-line-webhook/index.ts 第一個 import 的 ./mode.ts 呼叫 setAppMode('public')，
// 之後才 import 機器人本體（ES module 依 import 順序執行，config 讀到的就是 public）。
// 沒設定就是 legacy —— 舊版的行為完全不變。

export type AppMode = 'legacy' | 'public'

const KEY = '__TLB_APP_MODE__'

export function setAppMode(mode: AppMode): void {
  (globalThis as Record<string, unknown>)[KEY] = mode
}

export function appMode(): AppMode {
  return (globalThis as Record<string, unknown>)[KEY] === 'public' ? 'public' : 'legacy'
}

export const isPublicApp = (): boolean => appMode() === 'public'
