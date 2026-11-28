import React from 'react';
import { isChunkError, reloadOnce } from '../utils/reloadOnce';

/**
 * 整個 App 的最後一道防線（David 2026-11-28：偶爾整個畫面變白，下拉重整就好）。
 *
 * 最常見的原因：PWA 自動更新後，舊頁面還開著，點到還沒載入過的分頁（統計、行程、聊天都是 lazy chunk），
 * 去抓的是上一版的檔名，伺服器上已經沒有了 → import 失敗 → React 整棵樹卸載 → 白畫面。
 * 這種情況直接重新整理一次就會拿到新版；其他錯誤顯示一張卡片＋「重新載入」，不再整頁空白。
 * 重新整理有冷卻時間，避免新版本身有問題時無限重整。
 */
export default class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error('[App]', err);
    if (isChunkError(err)) reloadOnce();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-screen bg-canvas text-ink flex items-center justify-center p-6">
        <div className="bg-surface border border-line rounded-2xl px-6 py-8 max-w-sm w-full text-center space-y-3">
          <p className="text-lg font-bold">畫面出了點問題</p>
          <p className="text-sm text-muted">可能是網站剛更新，重新載入就好。資料都還在。</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center rounded-xl bg-primary text-on-primary font-bold px-5 h-11"
          >
            重新載入
          </button>
        </div>
      </div>
    );
  }
}
