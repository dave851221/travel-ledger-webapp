// 舊網址 /next/ 的 Service Worker 已經不用了（網站搬到 https://meowtrip.pages.dev/）：
// 裝好就把自己註銷，讓已經安裝過的手機不再拿舊的快取畫面，改走 index.html 的轉址。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
