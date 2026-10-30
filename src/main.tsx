import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Service Worker 由 App.tsx 的 useRegisterSW 註冊（只能註冊一次，
// 以前這裡也叫了一次 registerSW，等於掛了兩個 Workbox 實例）

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
