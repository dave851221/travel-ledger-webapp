// Minimal LIFF SDK types covering only what LiffEdit uses.
// LIFF is auto-injected by LINE when opened via liff.line.me, or loaded via <script>
// from https://static.line-scdn.net/liff/edge/2/sdk.js as a fallback.
declare global {
  interface LiffSDK {
    init(config: { liffId: string }): Promise<void>;
    isLoggedIn(): boolean;
    login(): void;
    closeWindow(): void;
  }

  interface Window {
    liff?: LiffSDK;
  }
}

export {};
