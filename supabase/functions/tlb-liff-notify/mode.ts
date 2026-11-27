// 必須是 index.ts 的第一個 import：在 ../liff-notify 讀設定之前切到開放版（見 _shared/appMode.ts）
import { setAppMode } from "../_shared/appMode.ts"

setAppMode('public')
