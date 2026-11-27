/**
 * 旅行喵喵的美術圖放在哪裡（開放版才用；舊版沒有）。
 * 圖由 David 另外請繪圖 AI 製作，放進 public/art/ 對應的檔名就會出現，不用改程式；
 * 還沒放的圖不會顯示（MascotArt 載入失敗就藏起來），版面照舊。
 * 規格（尺寸、內容、透明背景）見 docs/ART_PLAN.md。
 */
export const ART = {
  /** 頭貼：logo、網頁圖示、手機桌面圖示（已有，David 2026-11-27 提供） */
  avatar: 'art/avatar.png',
  /** 登入頁主視覺 */
  signinHero: 'art/signin-hero.png',
  /** 首頁：還沒有任何旅程 */
  emptyTrips: 'art/empty-trips.png',
  /** 帳目頁：還沒有任何支出 */
  emptyLedger: 'art/empty-ledger.png',
  /** LIFF：記帳成功 */
  saved: 'art/saved.png',
  /** 加入旅程（邀請連結打開時） */
  invite: 'art/invite.png',
  /** 升級／加購的視窗 */
  upgrade: 'art/upgrade.png',
  /** 找不到、出錯 */
  error: 'art/error.png',
} as const;

export type ArtSlot = keyof typeof ART;
