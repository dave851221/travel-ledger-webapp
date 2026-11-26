// 一定要排第一個：開放版 LINE 登入回來的 ?code= 要在 Supabase client 建立前收走（見檔案開頭說明）
import './features/auth/lineCallback'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { resolveLiffEntryUrl } from './utils/liff'

// Service Worker 由 App.tsx 的 useRegisterSW 註冊（只能註冊一次，
// 以前這裡也叫了一次 registerSW，等於掛了兩個 Workbox 實例）

// liff.line.me 開進來的網址要先轉成 HashRouter 的路徑（見 utils/liff.ts）；一般網址不會等待
const needsLiffEntry = /[?&](liff\.state|route)=/.test(window.location.search)
const render = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
if (needsLiffEntry) resolveLiffEntryUrl().then(render, render)
else render()
