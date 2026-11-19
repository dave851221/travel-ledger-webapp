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
    getContext(): { type?: string } | null;
    sendMessages(messages: { type: 'text'; text: string }[]): Promise<void>;
  }

  interface Window {
    liff?: LiffSDK;
  }
}

export {};
