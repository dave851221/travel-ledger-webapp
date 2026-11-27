// Minimal LIFF SDK types covering only what the LIFF pages use.
// LIFF is auto-injected by LINE when opened via liff.line.me, or loaded via <script>
// from https://static.line-scdn.net/liff/edge/2/sdk.js as a fallback.
declare global {
  interface LiffSDK {
    init(config: { liffId: string }): Promise<void>;
    isLoggedIn(): boolean;
    isInClient(): boolean;
    login(): void;
    closeWindow(): void;
    getContext(): { type?: string; userId?: string } | null;
    /** 需要 LIFF app 開 profile scope；沒開或不在 LINE 裡會丟錯 */
    getProfile(): Promise<{ userId: string; displayName: string }>;
    sendMessages(messages: { type: 'text'; text: string }[]): Promise<void>;
    /** LIFF 的 access token（開放版拿去 auth-line 換成網站登入） */
    getAccessToken(): string | null;
  }

  interface Window {
    liff?: LiffSDK;
  }
}

export {};
