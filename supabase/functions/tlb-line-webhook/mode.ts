// 必須是 index.ts 的第一個 import：在機器人本體（../line-webhook）讀設定之前切到開放版。
// 見 _shared/appMode.ts。
import { setAppMode } from "../_shared/appMode.ts"

setAppMode('public')
