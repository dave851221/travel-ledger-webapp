// 集中管理 Edge Function 的外部相依。
//
// 為什麼要有這一層：測試時 vitest 會透過 vitest.config.ts 的 resolve.alias
// 把這個檔案換成本機的 npm 套件，讓 Deno 專用的模組也能在 Node 下被測試。
// 直接在各處寫 https:// import 就做不到這件事。

export { default as Decimal } from 'https://esm.sh/decimal.js@10.4.3';
