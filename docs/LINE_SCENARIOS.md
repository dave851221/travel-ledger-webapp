# LINE Bot 記帳情境總覽與回歸檢查表

這份文件列出「透過 LINE 記帳」的所有已知使用情境、每條情境目前的支援狀態，以及審視程式碼時發現的 bug 與修正規劃。

**它存在的原因**：Bot 的行為散在 `supabase/functions/line-webhook/index.ts` 兩千多行裡，
改 prompt、改路由、改 schema 時很容易把先前做好的功能蓋掉。這件事已經發生過兩次：

- 為了「修正草稿」加的 `supersedePendingDrafts()` 把「連續記多筆」擋掉了（每送一張新卡，舊卡就失效）。
- 為了擋「AI 假稱已刪除」加的 `detectRecordIntent()` 把自我介紹裡宣傳的「剛剛那筆改 500」攔到編輯清單去，永遠到不了 AI。

以後改 Bot 邏輯前，先掃過相關章節；改完後逐條驗證。要加新功能，先在這裡加情境再動手。

依據的程式版本：H1–H12、第 12 章的 Feature F、第 13 章的 T1–T4 都已實作完成（2026-09-04），
第 10.2 節的 **M1–M3、M5–M8、M10–M13、M16–M19 也已完成**（M2 隨 T2；其餘 2026-09-05）。
**只剩 M4、M14、M15 未修**，留在 [`ROADMAP.md`](ROADMAP.md)。
文中提到的行號來自修正前的 `index.ts`，現在已經漂移，請一律以函式名與註解關鍵字為準。

純函式現在集中在 `supabase/functions/line-webhook/guards.ts`（由 `guards.test.ts` 看守），
`index.ts` 只留路由、DB 存取與 LINE API 呼叫。

---

## 0. 圖例與程式進入點

| 圖例 | 意義 |
| :--- | :--- |
| ✅ | 已支援，行為符合預期 |
| 🟡 | 部分支援，或行為可接受但有明確缺口（附說明） |
| ❌ | 未支援 |
| 🐛 | 有 bug，見第 4 章對應編號（H = 高優先、M = 中低優先） |

`index.ts` 的處理順序（每個 webhook event 依序通過，命中就 `continue`）：

| 順序 | 進入點 | 關鍵字／函式 |
| :--- | :--- | :--- |
| P0 | 簽章驗證、取得發言者名稱、載入 `line_user_states`（含 pending 逾時清理、`last_active_at`） | `verifySignature`、`getChatMemberName`、`isPendingExpired` |
| P0.5 | 被加進群組／聊天室 | `join` event → `BOT_SELF_INTRODUCTION` |
| P1 | Postback（已綁定才處理） | `act: undo / del / save / cancel / cur` |
| P2 | 圖片訊息（已綁定才處理） | `ocrPrompt`、`OCR_RESPONSE_SCHEMA` |
| P3 | 群組觸發判斷 | `shouldProcess`、`isManagement`、`startsWithYoshi` |
| P4 | 說明、純呼叫 | `HELP_KEYWORDS`、`cleanText === ''` |
| P5 | 綁定與管理指令 | `ID:`、`取消綁定`、`斷開`、`模式:`、`設定?`、`設定:`、密碼驗證 |
| P6 | 草稿的取消／修正，以及已存檔紀錄的編輯／刪除／撤銷攔截 | `getOutstandingDrafts`、`CANCEL_DRAFT_KEYWORDS`、`cancelDraft`、`detectRecordIntent`、`EDIT_LIST_KEYWORDS`、`DELETE_LIST_KEYWORDS`、`UNDO_KEYWORDS` |
| P7 | 快捷查詢（直接查 DB） | `今日支出`、`本週支出`、`本月支出`、`結算`、`旅程總覽` |
| P8 | AI 核心 | `tripContext`（含【全趟彙總】與【尚未確認的草稿】）、`YOSHI_SYSTEM_INSTRUCTION`、`TEXT_RESPONSE_SCHEMA`（含 `corrects_draft`）、`getOutstandingDrafts`、`summarizeTripExpenses` |
| P9 | 未綁定時的其他訊息 | 提示輸入 `ID:` |

寫入前的共同防線（P2 與 P8 都會經過，全部在 `guards.ts`）：
`normalizeExpenseAmountMaps` → `resolveExpenseMembers` → `resolveCurrencyByRule` →
`normalizeCurrency` → `resolveCategory` → `normalizeDate` → `applyParticipantDefaults`
→ `calculateDistribution`；
存檔時（P1 save）再擋一次「付款人或分攤為空」與「有成員已不在旅程裡」，
並做 `Σ(付款) == Σ(分攤) == 總額` 的檢查。任何一關擋下來都會 `releaseNonce()`，
卡片的按鈕才不會跟著失效。

---

## 1. 綁定、切換旅程與說明

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| A1 | 綁定有密碼的旅程 | `ID:A1B2C3` → `1234` | 找到旅程 → 要求密碼 → 驗證後回成員清單與網址 | ✅ | P5 |
| A2 | 綁定免密碼的旅程 | `ID:A1B2C3` | 直接綁定成功，不問密碼 | ✅ | P5 `requiresAccessCode` |
| A3 | 密碼錯誤 | `ID:A1B2C3` → `0000` | 回「密碼錯誤」，維持等待狀態 | ✅ | P5 |
| A4 | 重複綁定同一旅程 | 已綁定後再輸入相同 `ID:` | 回「已綁定此旅程」，不重置狀態 | ✅ | P5 |
| A5 | 等密碼期間改傳另一個 ID | `ID:AAA` → `ID:BBB` | 改等 BBB 的密碼 | ✅ | P5 |
| A6 | 已綁定時輸入新 ID（切換） | `ID:BBB` | 要求新密碼；驗證成功才切換 | ✅ M1 已修：輸入 ID 只寫 `pending_trip_id`，`current_trip_id` 原封不動；切換中原旅程照常可用（打的不是新密碼就直接往下走正常流程） | P5 |
| A7 | 解除綁定 | `斷開`／`切換旅程` | 清除狀態，快速回覆只剩「使用說明」 | ✅ | P5 |
| A8 | 代碼不存在 | `ID:ZZZZZZ` | 回「找不到代碼」 | ✅ | P5 |
| A9 | 全形冒號、小寫 | `id：a1b2c3` | 視同 `ID:A1B2C3` | ✅ | P5 `toUpperCase` |
| A10 | 等密碼期間旅程密碼被移除 | 網頁清空密碼後才輸入任何字 | 直接放行綁定 | ✅ | P5 |
| A11 | 旅程被後台刪除後 | 執行 `delete_trip.sql` 後任何訊息 | `current_trip_id` 因 `ON DELETE SET NULL` 變空，視為未綁定並提示重綁 | ✅ | schema |
| A12 | 群組中綁定 | 群組內 `ID:A1B2C3` | 整個群組共用一份綁定（刻意設計） | ✅ | P3 `isIdCommand` 免觸發 |
| A13 | 群組等密碼期間其他人閒聊 | A 輸入 ID 後 B 說「今天好熱」 | 不應把閒聊當密碼 | ✅ M1 已修：群組裡只有 @提及或以「耀西」開頭才會回「密碼錯誤」，其餘靜默；輸對密碼仍然照常綁定 | P5 |
| A14 | 想放棄綁定 | 輸入 ID 後反悔 | 有指令可取消等待 | ✅ M1 已修：新增「取消綁定」／「放棄綁定」；另外 `pending_at` 超過 10 分鐘會自動放棄 | P5 |
| A15 | 綁定成功的回覆 | — | 列出成員、旅程網址、提示可以開始記帳 | ✅ | `buildBindSuccessText` |
| A16 | 切換旅程後舊草稿卡片還在 | 換旅程後按舊卡「確認存入」 | 應告知卡片已失效 | ✅ M13 已修：綁定成功（免密碼與密碼兩條路徑）與斷開時都呼叫 `supersedeAllDrafts()`，舊卡按下去會說「已被較新的記帳建議取代」 | P5、`supersedeAllDrafts` |

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| B1 | 設定偏好 | `設定:預設由我付款，大家均分`，或按「⚙️ 記帳偏好」開表單 | 存起來，之後 AI 參考 | ✅ 存在 `trips.ai_preference`，整趟旅程共用一份 | P5、`LiffPreference` |
| B2 | 查看偏好 | `設定?`／`設定？` | 顯示目前設定，並附可直接編輯的按鈕 | ✅ | P5 `preferenceQuickReply` |
| B3 | 空設定 | `設定:` | 提示不能為空 | ✅ | P5 |
| B4 | 用設定宣告身分 | `設定:我是代杰` | 之後「我付的」對應到代杰 | 🟡 仍是自由文字，但偏好已是**整趟旅程共用**，寫「我是誰」會誤導其他人；身分改由 H9 修好的傳訊者名稱判斷，文件與 placeholder 都已提醒 | P8 `tripContext` |
| B5 | 清除偏好 | `設定:清除`，或在編輯表單清空後儲存 | 清空偏好 | ✅ 「清除」／「清空」是保留字，存成 `NULL`；表單清空後儲存亦同 | P5、`LiffPreference` |
| B6 | 偏好在群組中是共用的 | 群組內 B1 | 整個群組一份設定（刻意設計） | ✅ 範圍已擴大成「整趟旅程」共用一份，不分管道；網頁設定頁看到的是同一份 | `trips.ai_preference` |
| B7 | 看使用說明 | `使用說明`／`說明`／`help`／`功能` | 回完整自我介紹 | ✅ | P4 `HELP_KEYWORDS` |
| B8 | 只是叫一聲 | `耀西`／純 @提及 | 一句話加快速回覆按鈕，不貼整篇說明 | ✅ | P4 |
| B9 | 未綁定時亂聊 | `晚餐 300`（未綁定） | 提示先輸入 `ID:` | ✅ | P9 |
| B10 | 切換群組回應模式 | `模式:全回應模式`／`模式:提及模式` | 更新 `mention_required`，快速回覆按鈕跟著換 | ✅ | P5 |
| B11 | 1:1 不該出現模式切換按鈕 | 一對一任何回覆 | 快速回覆沒有「開啟全回應模式」 | ✅ | `getQuickReply(bound, isGroup)` |
| B12 | 自我介紹與文件同步 | — | `BOT_SELF_INTRODUCTION` 與 `docs/LINE_BOT.md` 一字不差 | ✅ 內容一致，且「剛剛那筆改 500」在有草稿時真的到得了 AI（H2 已修） | — |
| B13 | 按按鈕編輯旅程 AI 偏好 | 快速回覆「⚙️ 記帳偏好」 | 開 LIFF 表單，預填目前偏好，存檔後網頁設定頁也看得到同一份 | ✅ | `src/pages/LiffPreference.tsx` |

---

## 2. 文字記帳

### 2.1 基本輸入形式

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| C1 | 描述加金額 | `晚餐 300` | 出卡片：預設幣別、預設分類、預設付款與分攤 | ✅ | P8 |
| C2 | 只有金額 | `300` | 描述用分類名代入或反問 | 🟡 交給 AI 自由發揮，不保證 | P8 |
| C3 | 只有描述沒金額 | `晚餐` | 反問金額，不出卡片 | 🟡 靠 schema `amount` 必填，AI 可能填 0 | P8 |
| C4 | 千分位 | `機票 12,800` | amount 12800 | ✅ AI 處理 | P8 |
| C5 | 中文數字與口語數字 | `三百`、`1千2`、`1.2k`、`兩萬五` | 正確換算成阿拉伯數字 | 🟡 靠 AI，未驗證 | P8 |
| C6 | 小數金額 | `咖啡 4.5 美金` | 依 `precision_config` 保留位數 | ✅ | `DEFAULT_PRECISION` |
| C7 | 描述本身含數字 | `7-11 55`、`2 杯咖啡 200` | 金額取 55／200，描述保留 | ✅ AI 處理（前端 quickAdd 有同樣規則） | P8 |
| C8 | 一句話多筆 | `午餐 300 晚餐 500` | 出兩張卡 | ❌ schema 只允許一筆，AI 會合併或只取一筆 | `TEXT_RESPONSE_SCHEMA` |
| C9 | 英文或日文輸入 | `dinner 3000 yen`、`ラーメン 1200円` | 正常解析，描述可保留原文 | 🟡 靠 AI | P8 |
| C10 | 純閒聊 | `今天好累` | 回 `chat`，不出卡片 | ✅ | P8 |
| C11 | 超長文字 | 貼一大段行程 | 不崩潰；回覆超過 4900 字截斷 | ✅ | P8 `safeContent` |
| C12 | 金額 0 或負數（退款） | `退款 -300`、`退了 300` | 記成負數或反向支出 | ❌ 無負數概念，AI 可能記成正 300 | — |
| C13 | 極大金額 | `包車 1000000` | 正常 | ✅ | — |
| C14 | 訊息只有表情符號 | `🍜` | 回 chat 或反問 | ✅ | P8 |
| C15 | 一則訊息帶多個空白／換行 | `晚餐\n300` | 正常解析 | ✅ | P8 |

### 2.2 幣別

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| D1 | 明講幣別 | `3000 日幣`、`¥3000`、`US$20`、`台幣 500`、`3000 円` | 對應 ISO 代碼 | ✅ AI 回 `currency_source: stated`，程式再用 `CURRENCY_HINTS` 驗一次文字裡真的有幣別字眼才採信（T3） | P8、`resolveCurrencyByRule` |
| D2 | 幣別在旅程 `rates` 內 | JPY 有匯率 | 直接放行 | ✅ | `normalizeCurrency` |
| D3 | 合法幣別但旅程沒設匯率 | 旅程只有 TWD、JPY，說 `20 美金` | 拒絕存入，列出可用幣別並教去設定頁加匯率 | ✅ | `normalizeCurrency.reject` |
| D4 | AI 幻想的幣別代碼 | AI 回 `YEN`、`NTD` | 退回旅程預設幣別並提醒 | ✅ | `normalizeCurrency.warning` |
| D5 | 沒提幣別 | `晚餐 300` | 用 `default_currency`，沒設就用 `base_currency` | ✅ 改由程式決定：`currency_source: none` 一律套預設，AI 填什麼都不算數（T3） | `resolveCurrencyByRule` |
| D6 | 偏好設定指定幣別 | `設定:預設用日幣` → `晚餐 300` | JPY | 🟡 仍靠 AI 讀設定（回 `currency_source: preference` 時程式無從驗證，只能採信） | P8 |
| D7 | 嚴禁自行換算 | `3000 日幣` 於主幣 TWD 旅程 | amount 3000、currency JPY，不可變成 TWD 660 | ✅ system instruction 明令 | `YOSHI_SYSTEM_INSTRUCTION` 規則 2 |
| D8 | 金額精度 | JPY 給 `1200.5` | 依 `precision_config` 四捨五入到 0 位 | ✅ | `toDecimalPlaces(precision)` |
| D9 | 主幣別本身沒在 `rates` | 舊旅程資料不完整 | 不該把主幣別當成「沒匯率」拒絕 | 🟡 `Home.tsx` 建旅程會放 `{base:1}`，舊資料未驗證 | `normalizeCurrency` |
| D10 | 沒提幣別時一律用預設幣別，與主幣別不同也一樣 | 主幣 TWD、預設 JPY 的旅程說 `夾娃娃300` | 卡片幣別是 JPY，不是 TWD | ✅ T3 已修：幣別改由 `resolveCurrencyByRule()` 決定，`none` 與「宣稱 stated 但文字沒有幣別字眼」都退回記帳預設；`tripContext` 也把「記帳預設」與「結算主幣」分開講 | `guards.ts`、P2、P8 |

### 2.3 付款人與分攤

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| E1 | 指定付款人 | `小明付了 Uber 300` | payer 小明，分攤依預設 | ✅ | P8 |
| E2 | 「我」在群組 | 群組內代杰說 `我付的晚餐 300` | 用 LINE 顯示名稱對應成員 | ✅ `getChatMemberName` 餵進 `傳訊者` | P0、P8 |
| E3 | 「我」在一對一 | 1:1 說 `我付的晚餐 300` | 同上 | ✅ 一對一走 `/v2/bot/profile/{userId}` 取名 | P0 `getChatMemberName` |
| E4 | 多人付款 | `我出 300 小明出 200 的晚餐` | payer_data 兩人，總額 500 | ✅ | P8 |
| E5 | 分攤子集 | `我跟小明平分 600` | split 兩人各 300 | ✅ | P8 |
| E6 | 排除某人 | `晚餐 900 除了小華` | split 其餘成員均分 | ✅ AI 處理 | P8 |
| E7 | 指定各自金額 | `晚餐 900，我 500 其他人平分` | 我 500，餘額均分（餘數給調整成員） | ✅ `calculateDistribution` 鎖定金額 | P8 |
| E8 | 請客 | `晚餐 900 我請客` | payer 我、split 只有我 | 🟡 靠 AI 理解「請客」語意 | P8 |
| E9 | 別人請客 | `小明請大家吃拉麵 3000` | payer 小明、split 只有小明 | 🟡 同上 | P8 |
| E10 | 份數 | `門票 1500，我算兩份` | 我 1000、另一人 500 | 🟡 靠 AI 算術 | P8 |
| E11 | 每人金額 | `門票每人 500` | 總額 = 500 × 分攤人數 | 🟡 靠 AI 算術 | P8 |
| E12 | 暱稱、簡稱、大小寫 | 成員「王小明」說成「小明」；「Amy」打成「amy」 | 對回正式名稱 | ✅ | `resolveMember` |
| E13 | 對不上的名字 | `阿花付的`（沒這人） | 回訊息列出成員請重說，不硬猜 | ✅ | `resolveExpenseMembers.unresolved` |
| E14 | 歧義名字 | 成員「小明」「小明哥」，說「明」 | 反問，不猜 | ✅ 只有唯一解才採用 | `resolveMember` |
| E15 | 旅程預設付款人／分攤生效 | 設定頁設了 `default_payer` | 未指定時採用 | ✅ | `tripContext` 優先權 |
| E16 | AI 回空的付款或分攤 | 少見，schema 允許空陣列 | 套預設而不是壞掉 | ✅ `applyParticipantDefaults` 補預設；存檔時仍為空則請使用者按「編輯」 | `guards.ts`、P1 |
| E17 | 同一人被指到兩次 | `我 200，代杰 300`（我＝代杰） | 金額相加成 500 | ✅ | `resolveExpenseMembers` |
| E18 | 成員名稱含空白或全形 | 「王 小明」 | 正規化比對 | ✅ | `normalizeName` |
| E19 | 付款人不在分攤名單 | 小明付、代杰與 Amy 分 | 餘數調整成員取分攤名單第一位 | ✅ | `adjustMember` |
| E20 | 分攤金額有餘數 | 1000 三人分 | 333／333／334，餘數給調整成員，總和相等 | ✅ 與前端契約測試一致 | `_shared/finance.ts` |
| E21 | 只有一位成員的旅程 | — | payer = split = 該成員 | ✅ | — |

### 2.4 日期與分類

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| F1 | 相對日期 | `昨天的晚餐 300`、`前天`、`9/2` | 以旅程時區的今天推算 | ✅ | `tripContext【今日】` |
| F2 | 日期超過今天前後一年 | AI 算錯年份 | 退回今天並提醒 | ✅ | `normalizeDate` |
| F3 | 日期格式壞掉 | AI 回 `2026/9/2` | 退回今天並提醒 | ✅ | `normalizeDate` |
| F4 | 旅程所在地與主幣別不同 | 日本旅程、主幣 TWD、日本時間 23:30 記帳 | 「今天」應是日本日期 | 🐛 M4 時區取主幣別 → 台北時間，跨日一小時內會差一天 | `getTripTimezone` |
| F5 | 明講分類 | `分類交通 計程車 300` | 採用 | ✅ | P8 |
| F6 | 沒提分類 | `拉麵 300` | AI 依描述挑，不確定用預設分類或「其他」 | ✅ | prompt 規則 4 |
| F7 | AI 給了清單外的分類 | AI 回「美食」但旅程只有「餐飲」 | 應對回清單或退回預設 | ✅ M18 已修：`resolveCategory()` 比照 `resolveMember` 做正規化與唯一子字串比對，對不上就退回旅程預設分類 →「其他」→ 清單第一個，並回一則提醒 | `guards.ts`、P2、P8 |
| F8 | 未來日期 | `明天的機票 5000` | 允許（一年內） | ✅ | `normalizeDate` |

---

## 3. 收據照片（OCR）

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| G1 | 單張收據 | 傳一張超商發票 | 下載 → 上傳 Storage → OCR → 帶縮圖的卡片 | ✅ | P2 |
| G2 | 非收據照片 | 風景照 | 群組靜默刪除；一對一要回一句 | ✅ M8 已修：群組維持靜默（貼風景照不該每張被回），一對一回「這張看起來不是收據」並提示可以直接打字，或改傳付款完成畫面 | P2 `not_receipt` |
| G3 | 一次傳多張收據 | 相簿多選兩張 | 兩張卡都可各自確認 | ✅ OCR 路徑不再讓舊草稿失效 | P2 |
| G4 | 多頁收據（同一筆） | 長收據拍兩張 | 合成一筆 | ❌ LINE 的 `imageSet` 未處理，會變兩筆 | — |
| G5 | 外文店名格式 | 日本收據 | 描述「原文 (中文說明)」，如「肉の匠家 (和牛燒肉店)」 | ✅ | prompt 規則 3 |
| G6 | 收據含服務費、稅、折扣 | 餐廳帳單 | 總金額取「實付」 | 🟡 靠 AI 判讀 | P2 |
| G7 | 行動支付／信用卡通知截圖 | PayPay、LINE Pay、Suica 截圖 | 應視為記帳來源 | ✅ M7 已修：規則 7 改成「與消費無關的截圖」才是 not_receipt，並明列付款完成畫面、信用卡消費通知、轉帳成功、電子發票、訂單確認頁一律視為收據 | prompt 規則 7 |
| G8 | 模糊看不清金額 | 糊掉的收據 | 反問或以 0 出卡讓人編輯 | 🟡 可能回 not_receipt 靜默 | P2 |
| G9 | 收據幣別沒匯率 | 旅程沒設 USD，傳美金收據 | 拒絕並提示，但別讓人重傳照片 | ✅ M10 已修：照片保留，辨識結果存成 pending，回覆附「以 TWD 存入」「以 JPY 存入」等快速回覆（只列旅程 rates 內的幣別，最多 12 顆）＋「❌ 取消」；選了就換幣別重出卡片，**金額不換算**，分帳依新精度重算 | P2 `ocrCurrency.reject`、P1 `act:'cur'` |
| G10 | 封存旅程傳照片 | — | 回覆「已封存」 | ✅ 回「🔒 此旅程已封存，無法新增支出（照片未儲存）」 | P2 |
| G11 | 收據日期 | 收據印 2026/09/01 | 採用；沒有就用今天 | ✅ 再經 `normalizeDate` | P2 |
| G12 | 依偏好預測分攤 | `設定:預設我付大家分` 後傳收據 | 套用 | ✅ | prompt 規則 5 |
| G13 | 群組任何人傳照片 | 提及模式下傳風景照 | 一律下載、上傳、OCR，非收據再刪 | 🟡 **已確認維持現狀**；注意會消耗 Gemini 額度、照片會短暫進 Storage | P2 在 P3 之前 |
| G14 | OCR 模型全掛 | 429／5xx | 清掉照片、回額度提示 | ✅ | `askGemini` fallback、`isRateLimit` |
| G15 | AI 回非 JSON | — | 清掉照片、請重傳 | ✅ | P2 |
| G16 | 成員對不上 | 收據分攤出現不存在的人 | 不要刪照片 | ✅ M10 已修：對不上的名字直接拿掉，套旅程預設分攤後照常出卡，卡片前多一則「有對不上的名字…請按『✏️ 編輯』」的提醒 | P2、`applyParticipantDefaults` |
| G17 | 幣別或日期被修正 | AI 幣別看錯 | 卡片前多一則「已改用 XXX」提醒 | ✅ | `ocrWarnings` |
| G18 | 取消卡片 | 按「❌ 取消」 | 刪除 Storage 照片 | ✅ | P1 cancel |
| G19 | 確認存入 | 按「✅ 確認存入」 | `photo_urls` 存路徑 `expenses/{tripId}/{messageId}.jpg` | ✅ | P1 save |
| G20 | 照片下載失敗 | LINE CDN 錯誤 | 回「處理圖片時發生錯誤」 | ✅ | P2 catch |
| G21 | 同一張照片重傳 | 轉傳同一則圖片 | 新 messageId，視為新照片 | ✅ | — |
| G22 | OCR 太慢超過 reply token 時效 | 大圖 + 模型慢 | 改用 push 補送 | 🟡 目前 reply 失敗會 push 一則錯誤文字，卡片本身丟失 | `replyMessage` fallback |

---

## 4. 草稿卡片：確認、編輯、取消、修正

### 4.1 卡片按鈕

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| H1 | 確認存入 | 按「✅ 確認存入」 | 寫入 `expenses`，回「已存入」附撤銷按鈕 | ✅ | P1 save |
| H2 | 連點兩次確認 | — | 第二次回「已於先前成功存入」 | ✅ nonce 鎖 | `line_processed_actions` |
| H3 | 取消 | 按「❌ 取消」 | 失效 nonce，有照片就刪 | ✅ | P1 cancel |
| H4 | 先取消再確認 | — | 回「此操作已處理過」 | ✅ | nonce 鎖 |
| H5 | LIFF 編輯後存檔 | 按「✏️ 編輯」→ 改金額 → 存 | 佔用 nonce → INSERT → `liff-notify` 推播「已透過 LIFF 存入」（編輯既有支出則推播「已更新」，見 J11） | ✅ 網址改為只帶 `n` 與 `u`，草稿內容由 `LiffEdit` 自己去 `pending` 列撈（T2）；nonce 已被處理過就直接說明，不開表單 | `ExpenseModal.handleSubmit`、`liff-notify`、`buildDraftLiffUrl` |
| H6 | LIFF 存檔後再按確認 | — | 回「已處理過」，不重複寫入 | ✅ | nonce 鎖 |
| H7 | 群組裡 B 確認 A 的卡片 | — | 允許（共用同一本帳），訊息標明「由 B 記錄」 | ✅ 刻意設計 | `speakerLabel` |
| H8 | 兩張卡同時待確認 | 連續記兩筆 | 兩張都能確認 | ✅ 只有 AI 用 `corrects_draft` 指名的那一張會失效 | `supersedeDraft` |
| H9 | 確認時旅程已封存 | — | 回「已封存，無法新增」 | ✅ | P1 save |
| H10 | 確認時旅程已刪除 | — | 回「找不到旅程」 | ✅ | P1 save |
| H11 | 確認時成員已被移除或改名 | 卡片有「小華」，設定頁刪了小華 | 應告知並請重新編輯 | ✅ M12 已修：存檔前比對出已不在成員清單的名字就拒絕存入並列出來，請使用者按「✏️ 編輯」重新分攤；同時 `releaseNonce()` 把鎖放掉，那張卡片的按鈕才還能用 | P1 save |
| H12 | 按已失效的舊卡 | — | 說明「已被較新的卡片取代」 | ✅ 依 `action_type` 分別回覆取代／已存入／已取消 | P1 `describeProcessedAction` |
| H13 | 存入後的撤銷快速按鈕 | 按「↩️ 撤銷」 | 軟刪除，回「已撤銷」 | ✅ | P1 undo |
| H14 | 撤銷按鈕的描述太長 | 外文店名＋中文說明 | 按鈕仍可用 | ✅ postback 只帶 `eid`，描述由 undo 分支回查 | P1 save、`liff-notify` |
| H15 | 撤銷同一筆兩次 | 連按撤銷 | 第二次說「先前已撤銷」 | ✅ 先查 `deleted_at`，已刪就不再 UPDATE | P1 undo |
| H16 | 「🌐 查看網頁」 | — | 開 Dashboard | ✅ | — |
| H17 | 舊格式卡片（內嵌欄位） | 更新前發出的卡片 | 仍可存 | ✅ 相容分支保留 | P1 `exp_old / p_old` |
| H18 | 卡片內容顯示 | — | 描述、日期、分類、總額、付款人、分攤明細、縮圖 | ✅ | Flex bubble |

### 4.2 用文字修正尚未存檔的草稿

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| I1 | 改金額 | 卡片還沒確認 → `剛剛那筆改 500`、`剛剛那個改 250` | 出新卡 500，舊卡失效 | ✅ 有草稿時 edit 意圖直接進 AI，AI 用 `corrects_draft` 指名要修的那張；「那個」「剛剛」等說法也認得了（T1） | P6 → P8 |
| I2 | 改付款人 | `改成小明付` | 新卡 | ✅（沒有「那筆」字眼就能到 AI） | P8 |
| I3 | 改日期 | `日期改昨天` | 新卡 | ✅ | P8 |
| I4 | 改幣別 | `不對，是日幣` | 新卡 JPY，金額不換算 | ✅ | P8 |
| I5 | 改分類 | `分類改交通` | 新卡 | ✅ | P8 |
| I6 | 用文字取消草稿 | `取消`、`不要記`、`算了` | 失效草稿、刪照片，回「已取消」 | ✅ `CANCEL_DRAFT_KEYWORDS` → `cancelDraft()` | P6 |
| I7 | 收據逐項重新分帳 | 傳收據 → `A 是我吃的，B 小明吃` | AI 重讀收據品項重算，新卡沿用縮圖 | ✅ | `getOutstandingPhotoDraft` |
| I8 | 修正後舊卡失效 | I1 之後按舊卡 | 「已被取代」 | ✅ 訊息改為「已被較新的記帳建議取代，請改按新的那一張卡片」 | `describeProcessedAction` |
| I9 | 同時有兩張草稿時修正 | 兩張卡 → `剛剛那筆改 500` | AI 應知道指的是最新一張，或反問 | 🟡 `tripContext` 與歷史摘要都帶了 nonce，但最終仍由 AI 判斷指的是哪一張 | 【尚未確認的草稿】、`summarizeHistoryEntry` |
| I10 | 有收據草稿時打另一筆新支出 | 傳收據 → `計程車 200` | 新卡是獨立支出，收據卡保留 | ✅ 只有 `corrects_draft` 指向那張收據草稿時才沿用照片 | P8 `correctedDraft` |
| I11 | 修正時 AI 又換算匯率 | `改成 3000 日幣` | JPY 3000 | ✅ 規則明令 | system instruction |
| I12 | 修正後的付款人對不上 | `改成阿花付` | 反問 | ✅ | `resolveExpenseMembers` |

---

## 5. 修改與刪除已存檔的支出

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| J1 | 撤銷上一筆 | `取消上一筆`／`撤銷上一筆`／`刪除上一筆` | 軟刪除最近一筆由 LINE 存入的支出 | ✅ | P6 `UNDO_KEYWORDS` |
| J2 | 連續兩次撤銷 | `取消上一筆` × 2 | 撤銷兩筆不同的支出 | ✅ 取最近 5 筆 `saved`，撤第一筆尚未刪除的 | P6 |
| J3 | 撤銷群組裡別人記的 | B 說 `取消上一筆`，最近是 A 記的 | 允許，訊息標明「原由 A 記錄」 | ✅ 刻意設計 | P6 |
| J4 | 刪除清單 | `刪除支出` | 列最近 8 筆，各一顆「🗑 刪除」 | ✅ | P6 `DELETE_LIST_KEYWORDS` |
| J5 | 編輯清單 | `編輯支出` | 列最近 6 筆，各一顆 LIFF「✏️ 編輯」 | ✅ 網址改為只帶 `id` 與 `u`（T2） | P6 `EDIT_LIST_KEYWORDS`、`replyEditPicker` |
| J6 | 自然語言刪除／修改已存檔 | `把昨天那筆刪掉`、`那筆帳改成 800`、`剛才那個刪掉` | 攔下並列清單，不進 AI | ✅ **沒有未確認草稿時**才攔（有草稿時走 I1／I6）；受詞已含「那個／這個／剛剛／剛才／上一個／最近一筆」（T1） | `detectRecordIntent` + `getOutstandingDrafts` |
| J7 | AI 假稱已刪除 | AI 回「已經幫您刪除了」 | 換成誠實說明 | ✅ | `claimsCompletedAction` |
| J8 | 要改的不在最近 6／8 筆 | 一週前的支出 | 能翻頁或搜尋 | ❌ 只能去網頁。清單依日期與建立時間倒序，剛存的一定在第一列 | `replyEditPicker` |
| J9 | 用描述定位 | `刪除昨天的拉麵` | 直接找到那筆 | ❌ 只會列清單 | — |
| J10 | 清單裡出現結清紀錄 | 網頁結清後 `編輯支出` | 結清紀錄不該出現 | ✅ 兩個清單都加了 `.not('is_settlement','is',true)`；`ExpenseModal` 也改為沿用原值 | P6 查詢、`ExpenseModal` |
| J11 | LIFF 編輯舊支出後說 `取消上一筆` | 編輯三天前的支出 → `取消上一筆` | 應撤最近「新增」的 | ✅ M11 已修：`ExpenseModal` 改帶 `mode: 'update' \| 'insert'`，`liff-notify` 只有 insert 才寫 `saved`；更新的推播文字改成「✏️ 已透過 LIFF 更新」且不附「撤銷」按鈕 | `liff-notify`、`ExpenseModal` |
| J12 | 刪除已刪除的 | 清單按兩次同一筆 | 第二次說「先前已經刪除了」 | ✅ | P1 del |
| J13 | `saved` 紀錄沒寫進去 | Edge Runtime 提早結束 | 撤銷仍指向正確那筆 | ✅ 這一筆改為 `await`，其餘背景工作走 `runInBackground`（`EdgeRuntime.waitUntil`） | P1 save |
| J14 | 編輯清單網址過長 | 多成員、多照片、長描述 | 清單正常送出 | ✅ T2 已修（M2 提前做）：網址只剩 `tripId`／`id`／`u`，固定百餘字元，與支出內容無關 | `buildEditLiffUrl` |
| J15 | 刪除清單裡的 LIFF 編輯已存支出 | 從清單開 LIFF 改金額 | UPDATE 而非 INSERT | ✅ payload 帶 `id` | `LiffEdit.decoded.id` |
| J16 | 刪除後還原 | 網頁垃圾桶 | 24 小時內可還原 | ✅（垃圾桶時效依客戶端時間，ROADMAP #2） | 前端 |
| J17 | 撤銷時支出已被網頁硬刪 | — | 回「找不到」而不是成功 | ✅ 兩處都先 SELECT 再決定回覆（查無 → 「找不到這筆支出」） | P1 undo、P6 |
| J18 | 沒草稿時用「那個」「剛剛」指稱要改 | 存檔後 `剛剛那個改250` | 列編輯清單，**不可以**多記一筆 | ✅ T1 已修，兩層防線：①`detectRecordIntent` 的受詞加了指示代名詞，路由層就攔下；②真的進了 AI 且它回 `expense` 時，若沒有任何未確認草稿、沒填 `corrects_draft`、`mentionsEditingExisting()` 又為 true，改列清單並加註「如果其實是要新記一筆，請不要用『改』來描述」 | `guards.ts`、P6、P8、`replyEditPicker` |
| J19 | 改完再按同一顆編輯看到新資料 | 從清單開 LIFF 改成 800 存檔 → 回 LINE 再按同一列的「✏️ 編輯」 | 表單顯示 800 | ✅ T2 已修：`LiffEdit` 每次開啟都用 `id` 直接查 DB。找不到或 `deleted_at` 非空就顯示「這筆支出已被刪除或不存在」 | `LiffEdit` |

---

## 6. 查詢

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| K1 | 今日支出 | `今日支出`／`今天支出` | 旅程時區的今天，逐筆列出＋各幣別合計 | ✅ | P7 |
| K2 | 本週支出 | `本週支出`／`近期支出` | 近 7 天，依日期分組，最多 30 筆 | ✅ | P7 |
| K3 | 本月支出 | `本月支出` | 本月，最多 50 筆，超過 4900 字截斷 | ✅ | P7 |
| K4 | 結算 | `結算` | 最少轉帳次數的結清建議（折合主幣別） | ✅ | P7、`calculateSettlements` |
| K5 | 旅程總覽 | `旅程總覽` | 名稱、狀態、成員、今日、主幣、各幣別總計 | ✅ | P7 |
| K6 | 合計的浮點誤差 | USD 旅程 `今日支出` | 合計 0.30 而非 0.30000000000000004 | ✅ `sumByCurrency` + `formatAmount` | `_shared/finance.ts` |
| K7 | 結算金額精度 | USD 主幣 | 依 `precision_config` 顯示 12.50 | ✅ 改用 `formatAmount` | P7 |
| K8 | 自由查詢：總額 | `這趟總共花多少` | 正確數字 | ✅ M6 已修：`tripContext` 多了【全趟彙總】，各幣別合計在伺服器端用 Decimal 算好 | `summarizeTripExpenses` |
| K9 | 自由查詢：個人 | `我付了多少`、`我還欠多少` | 正確 | ✅ M6 已修：彙總含每人「已付／應付／淨額」，且淨額有計入結清紀錄 | `summarizeTripExpenses` |
| K10 | 自由查詢：對象 | `小明欠我多少` | 正確 | ✅ M6 已修：兩人的淨額都在彙總裡；精確的「誰給誰」仍建議用快捷指令「結算」 | `summarizeTripExpenses` |
| K11 | 自由查詢：分類 | `交通花了多少`、`吃飯佔多少` | 正確 | ✅ M6 已修：彙總含各分類合計（分幣別） | `summarizeTripExpenses` |
| K12 | 自由查詢：時間 | `昨天花多少`、`第一天花多少` | 🟡 彙總只有日期範圍與筆數，沒有逐日切片；system instruction 已要求「彙總裡沒有的切片就照實說算不出來」，不再硬湊 | P8 |
| K13 | 自由查詢：排名 | `誰付最多`、`最貴的一筆` | 🟡 「誰付最多」可由彙總的每人已付看出來；「最貴的一筆」仍受限於近期 10 筆 | P8 |
| K14 | 最近一筆 | `最近一筆是什麼` | 描述最新一筆 | ✅ 在 10 筆內 | P8 |
| K15 | 追問收據明細 | `剛剛那張收據買了什麼` | `analyze_photo` 重新讀圖逐項翻譯 | ✅ AI 只回編號（`expense_ref`），照片由程式從近期清單取（T4） | P8 `analyze_photo`、`pickExpenseByRef` |
| K16 | 收據不在最近 10 筆 | `上週一蘭的收據有哪些品項` | 全庫列出有照片的支出讓 AI 挑 | ✅ 先在程式端用店名做子字串比對縮小範圍，唯一解就直接用；多筆或零筆才問 AI，且一樣只回編號（T4） | `matchExpensesByQuestion`、P8 |
| K17 | 問旅程設定 | `匯率多少`、`有哪些成員`、`分類有哪些` | 從 context 回答 | ✅ | `tripContext` |
| K18 | 結算與網頁不一致 | `rates[base] ≠ 1` 的旅程 | 兩邊相同 | 🟡 ROADMAP #5（M14） | P7 vs `useTripStats` |
| K19 | 查詢排除結清紀錄 | 網頁做過結清 | 今日／本月／總覽不含結清；結算要含 | ✅ | `.not('is_settlement', 'is', true)` |
| K20 | 查詢排除已刪除 | — | 不含 `deleted_at` 非空 | ✅ | `.is('deleted_at', null)` |
| K21 | 旅程被刪除後打快捷指令 | — | 回「找不到旅程」 | ✅ 五個快捷指令與 AI 核心都有 null 檢查（M5 已修：以前 AI 核心會丟例外 → 500 → LINE 重送同一則訊息） | P7、P8 |
| K22 | 查詢類回答格式 | — | 條列、簡短，適合手機 | ✅ | system instruction 規則 5 |
| K23 | 剛剛那筆（不指名店名） | 傳完收據存檔後問 `剛剛那筆買了什麼` | 分析日期最近且有照片的那一筆，回覆開頭標明是哪一筆 | ✅ T4 已修：近期支出清單改成有編號、標 📷 的格式且**不再放網址**；system instruction 明講「說『剛剛』『最新』又沒指名店名時選日期最近且有 📷 的那一筆」 | P8、`tripContext` |
| K24 | 多張照片的支出 | 長帳單拍兩張存成同一筆 → 追問品項 | 兩張都要看 | ✅ T4 已修：`analyzeReceiptPhoto(photoUrls[], question, expenseLabel)` 一次送出全部 `photo_urls`，prompt 開頭標明「這 N 張是同一筆支出的收據」。以前只看 `photo_urls[0]` | `analyzeReceiptPhoto` |
| K25 | 指名店名但不在最近 10 筆 | `上週 Lawson 的收據有哪些品項` | 找到正確那一筆，不可以分析成別筆 | ✅ T4 已修：全庫搜尋先用 `normalizeName()` 把問句與各筆 description（含括號前的原文）做子字串比對，唯一命中就直接用，不必再問 AI | `matchExpensesByQuestion`、P8 |

---

## 7. 群組專屬

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| L1 | 提及模式：@提及 | `@耀西 晚餐 300` | 處理，去掉 @ 前綴 | ✅ | P3 `isMentioned`、`cleanText` |
| L2 | 提及模式：名字開頭 | `耀西 晚餐 300`、`耀西晚餐 300` | 處理 | ✅ | `startsWithYoshi` |
| L3 | 句中提到耀西 | `晚上叫耀西記一下` | 不觸發 | ✅ 必須在開頭 | `startsWithYoshi` |
| L4 | 快捷指令免觸發 | 群組直接打 `今日支出` | 處理 | ✅ | `isManagement` |
| L5 | 全回應模式 | `模式:全回應模式` 後任何訊息 | 全部進 AI；閒聊會得到回覆 | ✅ 刻意設計 | P3 |
| L6 | 以「設定」開頭的閒聊 | `設定好了嗎` | 不觸發 | ✅ M3 已修：只認 `設定:`／`設定：`／`設定?`／`設定？` | `isManagement` |
| L7 | 多人同時記帳 | A `晚餐 300`、B 接著 `計程車 200` | 兩張卡互不影響 | ✅ 只失效被指名的那一張 | `supersedeDraft` |
| L8 | 顯示是誰做的 | 存入、刪除、撤銷 | 「由 X 記錄／刪除」 | ✅ | `speakerLabel` |
| L9 | 多人聊天室（room） | 非群組的多人聊天 | 取名走 room endpoint | ✅ | `getChatMemberName` |
| L10 | 群組非收據照片 | 風景照 | 靜默 | ✅ | P2 |
| L11 | 群組成員退出後 | — | 不影響狀態 | ✅ | — |
| L12 | 機器人被加入群組 | join event | 回自我介紹 | ✅ M19 已修：處理 `join` event，回 `BOT_SELF_INTRODUCTION` 並附快速回覆 | P0 |
| L13 | 群組裡的 `說明`／`功能` | 提及模式打 `功能` | 需 @ 才回 | ✅ 不在 `isManagement` | P3 |
| L14 | @提及其他人 | `@耀西 @小明 你付的晚餐 300` | 只拿掉提及機器人的那一段，`@小明` 要留著 | ✅ M16 已修：改用 `stripSelfMentions()` 依 `mentionees[].index/length` 只切 `isSelf` 的那幾段 | `stripSelfMentions` |
| L15 | 對話歷史在群組是共用的 | A 與 B 交錯講話 | AI 看到的是同一串歷史，附發言者 | ✅ M17 已修：歷史查詢一併撈 `speaker_name`，`summarizeHistoryEntry()` 把 user 訊息壓成「發言者：內容」 | `summarizeHistoryEntry` |

---

## 8. 錯誤與邊界

| # | 情境 | 範例輸入 | 預期行為 | 現況 | 進入點 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| N1 | Gemini 全部 429 | 免費額度用盡 | 回「達到免費使用量上限」 | ✅ | `RATE_LIMIT_MSG` |
| N2 | Gemini 5xx／連線失敗／404／400 | — | 換下一個模型 | ✅ | `askGemini` |
| N3 | Gemini 回空內容 | 安全機制擋下 | 換模型 | ✅ | `askGemini` |
| N4 | AI 回的 JSON 壞掉 | — | 回「AI 處理時發生錯誤」 | ✅ | P8 catch |
| N5 | reply token 過期 | 處理超過 1 分鐘 | 改 push | 🟡 只 push 錯誤文字，原訊息丟失 | `replyMessage` |
| N6 | 貼圖、語音、位置、檔案、影片 | — | 跳過不回 | ✅（語音記帳 ❌ 未來可做，見 M15） | P2 之後 `[SKIP]` |
| N7 | 簽章錯誤 | 非 LINE 來源 | 401 | ✅ | `verifySignature` |
| N8 | 同一 webhook 多個 events | LINE 合併送 | 逐一處理，一個壞不影響其他 | 🟡 單一 event 未捕捉的例外會讓整批回 500 | `serve` 外層 try |
| N9 | 缺 `--no-verify-jwt` 部署 | — | 全部 401 | 已記錄於 CLAUDE.md | 部署 |
| N10 | `line_user_states` 建立失敗 | DB 異常 | `userState` 為 null 時不崩潰 | ✅ 全部用 `?.` | P0 |
| N11 | 使用者封鎖機器人後 | push 失敗 | 只記 log | ✅ | `pushMessage` |
| N12 | 對話歷史保留 | — | `line_chat_history` 14 天、`line_processed_actions` 7 天由 pg_cron 清 | ✅ | migration `cron_purge` |
| N13 | 歷史被清掉後按舊卡 | 8 天前的卡片 | 回「找不到待確認的支出資料」 | ✅ | P1 `getPendingExpense` |

---

## 9. 目前的硬性限制（改邏輯時不要忘記）

- **AI 沒有修改或刪除已存檔紀錄的能力**，只能提出新草稿、修正未存檔草稿、查詢。所有既有紀錄的異動都走清單按鈕或 LIFF。
- **AI 只看得到最近 10 筆支出與最近 8 輪對話**（`CHAT_HISTORY_TURNS`）。
  近期支出清單是**有編號、無網址**的格式（`#3 2026-09-04 Lawson (便利商店) 1280 JPY [餐飲] 📷×2`）；
  `analyze_photo` 要 AI 回的是那個編號（`expense_ref`），照片一律由程式自己找。
- **金額類的問題不靠 AI 算術**：`summarizeTripExpenses()` 在伺服器端用 Decimal 算好
  各幣別合計、每人已付／應付／淨額、各分類合計、筆數與日期範圍，以【全趟彙總】放進 context（M6）。
  但**沒有逐日切片，也沒有排名**（K12、K13 仍有缺口）。
- **一句話只能產生一筆**（schema 是單一 `data` 物件）。
- **Postback data 上限 300 bytes**；LINE `uri` action 上限 1000 字；文字訊息上限 5000 字（程式取 4900）。
  LIFF 編輯網址已改為只帶 `id`／`n` 的間接法（T2），長度固定，不再受支出內容影響。
- **reply token 只能用一次、時效約一分鐘**；之後只能 push（會計入推播額度）。
- **群組共用一份綁定、對話歷史與草稿**；發言者用來標記回覆、餵 prompt，
  也會以「發言者：內容」的形式進到對話歷史（M17）。
- **`current_trip_id` 與 `pending_trip_id` 可以同時有值**＝正在切換旅程；
  驗證成功才換過去，10 分鐘沒動作或輸入「取消綁定」就放棄（M1）。
- **AI 記帳偏好是旅程層級的**（`trips.ai_preference`），一趟旅程只有一份，不分管道；
  網頁設定頁、LIFF 偏好頁與「設定:」文字指令改的都是同一個欄位。
- **收據照片先上傳再判斷**，非收據才刪；群組提及模式下也是如此（已確認維持現狀）。
- **草稿存在 `line_chat_history` 的 `pending` 列**，卡片按鈕只帶 nonce；清理排程會在 14 天後讓舊卡失效。
- **卡片失效只發生在 AI 回了 `corrects_draft` 的時候**（只失效被指名的那一張）。
  連續記多筆、群組多人同時記帳、一次傳多張收據時，每張卡都各自保留。
- **金額運算一律 `Decimal`**，分攤走 `_shared/finance.ts` 且與前端有契約測試；改一邊必須改另一邊。
- **旅程已封存**：AI 與 OCR 都不得產生 expense；save postback 也會擋。

---

## 10. Bug 清單與修正規劃

> **狀態（2026-09-04）**：10.1 的 H1–H12 **已全部實作完成**，內容保留下來當作
> 「為什麼要這樣寫」的紀錄 —— 每一條都對應到 `index.ts` 或 `guards.ts` 裡的註解。
> 10.2 的 M1–M19 維持未修，已抄進 [`ROADMAP.md`](ROADMAP.md)。

以下依優先度分兩級。**高優先**是「會記錯帳」或「功能互相打架」的，中低優先只列出來，之後排程。
每條都寫了現象、原因、位置與修法，實作者可以直接照做。三個已與擁有者確認的產品決策：

1. 舊卡片失效：**只有 AI 判定「這句是在修正某張草稿」時才讓那張卡失效**；連續記多筆時每張卡都保留。
2. 群組提及模式下的照片：**維持一律自動 OCR**，不改。
3. 中低優先的 bug 這次不修，只記錄。

### 10.1 高優先（✅ 已完成）

#### H1　舊卡片失效太激進；有收據草稿時新支出被貼上收據

- **現象**：（a）`晚餐 300` → `計程車 200`，第一張卡按下去變「已處理過」。（b）一次傳兩張收據只剩最後一張有效。（c）群組 A、B 各記一筆，A 的卡被 B 的蓋掉。（d）傳收據後打 `計程車 200`，新卡帶著收據縮圖與 `photo_urls`，收據卡失效。
- **原因**：`supersedePendingDrafts()` 在文字路徑（約 1928 行）與 OCR 路徑（約 1218 行）**每次**送新卡都呼叫，失效該聊天室所有舊 nonce。另外 P8 只要 `getOutstandingPhotoDraft()` 有東西就把收據附給 AI，且結果一律 `photo_ids = reanalyzePhotoIds`（約 1904 行），不管 AI 回的是不是修正。
- **修法**：
  1. `TEXT_RESPONSE_SCHEMA` 加 `corrects_draft: { type: 'STRING', description: '若這句話是在修正某張尚未確認的記帳草稿，填該草稿的 nonce；否則留空字串' }`。
  2. 把 `getOutstandingPhotoDraft()` 一般化為 `getOutstandingDrafts(sourceId)`：回傳最近 5 張未處理草稿（nonce、exp、photoIds、tripId），不限有照片；原函式改成呼叫它再 filter。
  3. `tripContext` 加一段：
     ```
     【尚未確認的草稿】（使用者可能想修正其中一張；修正時 corrects_draft 填它的 nonce）
     - nonce=ab12cd34：晚餐 300 TWD（付款：代杰；分攤：代杰、Amy）
     ```
     `summarizeHistoryEntry()` 的摘要也附上 nonce（`[記帳建議]` 的 JSON 存檔時加 `nonce` 欄位）。
  4. 收據照片仍附給 AI（它要讀品項才能重算），但結果處理改為：`res.corrects_draft` 對應到一張**有照片**的草稿時才 `photo_ids` 沿用；否則視為無關的新支出，不附照片。
  5. `supersedePendingDrafts(sourceId, keepNonce)` 改為兩個函式：`supersedeDraft(sourceId, nonce)` 只失效指定那張（文字路徑在 `corrects_draft` 有效時呼叫），`supersedeAllDrafts(sourceId)` 保留原本邏輯給 M13 用。OCR 路徑的呼叫**移除**。
  6. P1 save／cancel 的「已處理過」訊息：查到 `action_type === 'superseded'` 時改回「這張卡片已被較新的記帳建議取代，請改按新的卡片」。
  7. `docs/LINE_BOT.md` 的「舊草稿會失效」「收據的逐項重新分帳」兩段同步改寫。
- **驗證**：情境 H8、G3、I7、I8、I10、L7。

#### H2　「剛剛那筆改 500」到不了 AI；文字無法取消草稿

- **現象**：卡片還沒確認，說 `剛剛那筆改 500`，得到的是「選擇要編輯的支出」清單（列的是已存檔的）。說 `取消` 則被當閒聊。
- **原因**：`detectRecordIntent()`（約 215-226 行）的 `RECORD_NOUN` 含「那筆」、`EDIT_VERB` 含 `改\s*\d`，命中後 P6（約 1456-1459 行）直接進編輯清單，不看有沒有草稿。自我介紹、`tripContext【回應方式】`、system instruction 都還在宣傳這功能。
- **修法**：
  1. P6 之前先呼叫 `getOutstandingDrafts()`。**有草稿時**：`recordIntent === 'edit'` → 跳過清單直接進 P8（AI 會回 `corrects_draft`）；`recordIntent === 'delete'` 或 `cleanText` 命中新常數 `CANCEL_DRAFT_KEYWORDS = ['取消', '不要記', '不用記', '算了', '取消這筆', '取消剛剛那筆']` → 失效最新一張草稿並刪照片（把 P1 cancel 的邏輯抽成 `cancelDraft(sourceId, draft)` 共用），回「已取消草稿：描述」。
  2. **沒有草稿時**維持現狀（進清單）。
  3. `BOT_SELF_INTRODUCTION` 的「修正記帳」改為「卡片還沒確認前，說『剛剛那筆改 500』或『取消』」，`docs/LINE_BOT.md` 一字不差同步。
  4. `detectRecordIntent` 本身不改（純函式層仍回 `edit`，由路由層決定攔不攔），並為它加測試固定行為。
- **驗證**：情境 I1、I6、J6（沒草稿時仍攔）。

#### H3　連續兩次「取消上一筆」撤同一筆，還刷新垃圾桶時效

- **現象**：說兩次 `取消上一筆`，第二次仍回「已撤銷」，其實撤的是同一筆；`deleted_at` 被更新，垃圾桶 24 小時重算。撤銷按鈕連按兩次同理。
- **原因**：P6 撤銷（約 1576-1598 行）只取最新一筆 `saved` 列，不查 `expenses.deleted_at`；P1 undo（約 853 行）也不查。
- **修法**：撤銷文字指令取最近 5 筆 `saved`，依序查 `expenses.id, deleted_at`，撤第一筆尚未刪除的；全都刪過就回「最近由 LINE 存入的支出都已撤銷過了，請輸入『刪除支出』選擇其他筆」。P1 undo 先查 `deleted_at`，已刪就回「先前已經撤銷了」。兩處都要 `.eq('trip_id', 目前旅程)` 當保險。
- **驗證**：情境 J2、H15。

#### H4　結清紀錄出現在編輯／刪除清單；LIFF 編輯會把結清變成一般支出

- **現象**：網頁做過結清後打 `編輯支出`，清單有結清紀錄；用 LIFF 編輯存檔後它變成一筆支出，統計失真。
- **原因**：P6 兩個清單的查詢沒加 `.not('is_settlement', 'is', true)`；`src/components/ExpenseModal.tsx` 的 `record`（約 362-366 行）硬寫 `is_settlement: false`。
- **修法**：兩個查詢加條件；`ExpenseModal` 改為 `is_settlement: editData?.is_settlement ?? false`（前端改動，要 push `main` 才生效）。
- **驗證**：情境 J10。

#### H5　查詢的金額加總用原生浮點；結算忽略精度

- **現象**：USD 旅程 `今日支出` 合計顯示 `0.30000000000000004`；`結算` 把 12.5 USD 顯示成 13。
- **原因**：今日（約 1614 行）、本月（約 1666）、總覽（約 1719）用 `totals[c] += e.amount`；結算（約 1702）用 `Math.round`。違反 CLAUDE.md「金額一律 decimal.js」。
- **修法**：新增 `sumByCurrency(rows)` 回 `Record<string, Decimal>`，輸出時用 `_shared/finance.ts` 已有的 `formatAmount(amount, currency, precision_config)`（bot 端目前沒用到它）。結算查詢要多選 `precision_config`。
- **驗證**：情境 K6、K7。

#### H6　AI 回空的付款或分攤時，確認會得到「聯絡管理員」

- **現象**：卡片付款人區塊空白；按確認回「財務運算發生錯誤，請聯絡管理員」。
- **原因**：schema 允許空陣列；P8／P2 的 `if (payerMembers.length > 0)` 只是跳過分配；P1 save 對空物件跑 `calculateDistribution([], …)` 得 `{}`，總和 0 ≠ 總額。
- **修法**：新增 `applyParticipantDefaults(expense, trip, speakerName)`：`payer_data` 空 → `trip.default_payer`（過濾存在成員）→ `resolveMember(speakerName, members)` → `members[0]`；`split_details` 空 → `trip.default_split_members`（過濾）→ 全員。與前端 `src/utils/quickAdd.ts` 的 `buildQuickAddDraft` 規則一致。P2 與 P8 在 `calculateDistribution` 之前呼叫。P1 save 若過濾成員後仍為空，回「這筆沒有付款人或分攤成員，請按『編輯』補上」而非「聯絡管理員」。
- **驗證**：情境 E16、E21。

#### H7　一次傳多張收據只剩最後一張有效

隨 H1 第 5 點（OCR 路徑移除 supersede）一併解決。驗證情境 G3。

#### H8　封存旅程收到照片沒有任何回覆

- **位置**：P2 約 1074-1077 行 `if (trip?.is_archived) { continue }`。
- **修法**：回覆「🔒 此旅程已封存，無法新增支出（照片未儲存）」再 `continue`。此時尚未上傳，不需清理。`docs/LINE_BOT.md` 說的就是這個行為。
- **驗證**：情境 G10。

#### H9　一對一聊天抓不到發言者名稱

- **現象**：1:1 說 `我付的晚餐 300`，`tripContext` 的「傳訊者：未知」，AI 只能靠 `default_config` 猜。
- **位置**：P0 約 812-825 行只在 group／room 才打 API。
- **修法**：`getChatMemberName` 加第三種 endpoint `https://api.line.me/v2/bot/profile/{userId}`，`sourceType === 'user'` 時也取；`speakerLabel` 在 1:1 維持 `null`（回覆不需要「由 X 記錄」），只把 `memberName` 餵進 prompt。
- **驗證**：情境 E3。

#### H11　`saved` 紀錄用 fire-and-forget，撤銷可能指向錯的一筆

- **現象**：偶發 `取消上一筆` 撤到更早一筆。
- **原因**：P1 save（約 996-1004 行）的 `saved` insert 用 `.then(() => {})`，Supabase Edge Runtime 在回應送出後可能中止未完成的 promise。
- **修法**：這一個 insert 改為 `await`（撤銷依賴它）。其餘 fire-and-forget（歷史紀錄）改用 `EdgeRuntime.waitUntil(promise)`；`check:functions` 若不認得就在檔頭 `declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }`。
- **驗證**：情境 J13（用 MCP `query_logs` 觀察）。

#### H12　撤銷按鈕的 postback 可能超過 300 bytes

- **現象**：外文店名＋中文說明的支出存入後，整則「✅ 已存入」回覆發送失敗（帳其實已存），使用者收到「訊息發送失敗」。
- **位置**：P1 save 的 `undoItems`（約 1009 行）與 `liff-notify/index.ts` 第 47 行都把 `d: description` 塞進 postback。
- **修法**：postback 只帶 `{ act: 'undo', eid }`；P1 undo 改為用 `eid` 查 `expenses.description` 後再回覆。
- **驗證**：情境 H14。

### 10.2 中低優先

> **狀態（2026-09-05）**：M1–M3、M5–M8、M10–M13、M16–M19 **已全部完成**
> （M2 隨第 13 章的 T2 一起做掉）。完成內容留在下表當作「為什麼要這樣寫」的紀錄。
> **只剩 M4（旅程時區）、M14（結算彙總收斂）、M15（語音記帳）**，仍在 [`ROADMAP.md`](ROADMAP.md)。

| # | 問題 | 修法方向 |
| :-- | :-- | :-- |
| ~~M1~~ | ~~群組綁定：輸入 `ID:` 當下 `current_trip_id` 就清空；等密碼期間群組每句話都被當密碼回「密碼錯誤」；沒有放棄指令。~~ | ✅ **已完成**（2026-09-05）：驗證成功才切換；新增「取消綁定」；`pending_at` 逾時 10 分鐘自動放棄（migration `20260905_line_pending_bind.sql`）；群組閒聊不再收到「密碼錯誤」；`last_active_at` 改為每次事件背景更新。 |
| ~~M2~~ | ~~`buildEditLiffUrl()` 把整筆支出塞進 URL，LINE `uri` 上限 1000 字，多成員多照片會讓整張清單發不出去。~~ | ✅ **已完成**（隨 T2 一起做，2026-09-04）：編輯既有支出只帶 `id`，`LiffEdit` 自行查 `expenses`；草稿帶 nonce 與 sourceId 查 `line_chat_history` 的 pending 列；舊的 `data=` 格式保留。 |
| ~~M3~~ | ~~`isManagement` 用 `userText.startsWith('設定')`，群組「設定好了嗎」會被送進 AI。~~ | ✅ **已完成**（2026-09-05）：改為 `/^設定[:：]/` 加上 `設定?`／`設定？` 的精確比對。 |
| M4 | `getTripTimezone()` 先看 `base_currency`，主幣 TWD 的日本旅程「今天」是台北時間。 | 旅程設定加時區欄位，或改為優先看非主幣別的 rates。 |
| ~~M5~~ | ~~AI 核心在 `trip` 為 null 時直接存取欄位 → 500 → LINE 重送。~~ | ✅ **已完成**（2026-09-05）：AI 核心查完旅程就先檢查 null，回「找不到這個旅程」並 `continue`。 |
| ~~M6~~ | ~~AI context 只有最近 10 筆，自由查詢（K8–K13）會答錯。~~ | ✅ **已完成**（2026-09-05）：`summarizeTripExpenses()` 在伺服器端用 Decimal 算好各幣別合計、每人已付／應付／淨額、各分類合計、筆數、日期範圍，放進 `tripContext` 的【全趟彙總】；system instruction 明令不得自己加總。逐日切片（K12）與「最貴的一筆」（K13）仍未涵蓋，長期改 function calling（見 `MCP_SERVER_DESIGN.md`）。 |
| ~~M7~~ | ~~OCR prompt 把「截圖」列為 not_receipt，行動支付與信用卡通知截圖記不了。~~ | ✅ **已完成**（2026-09-05）：規則 7 改為「與消費無關的截圖」，並明列付款完成畫面、信用卡消費通知、轉帳成功、電子發票、訂單確認頁一律視為收據。 |
| ~~M8~~ | ~~1:1 傳非收據照片完全沒回應。~~ | ✅ **已完成**（2026-09-05）：一對一回一句說明並提示可以直接打字；群組維持靜默。 |
| ~~M10~~ | ~~收據幣別沒匯率或成員對不上時照片被刪，要重傳。~~ | ✅ **已完成**（2026-09-05）：幣別沒匯率 → 照片保留、辨識結果存成 pending，附「以 XXX 存入」快速回覆（`act:'cur'` postback 換幣別重出卡，金額不換算、分帳依新精度重算）；成員對不上 → 拿掉對不上的名字、套預設分攤後照常出卡並加註提醒。 |
| ~~M11~~ | ~~`liff-notify` 把 LIFF 的 UPDATE 也記成 `saved`，`取消上一筆` 會刪掉剛編輯的舊支出；推播文字寫「存入」。~~ | ✅ **已完成**（2026-09-05）：`ExpenseModal` 帶 `mode`，`liff-notify` 只有 insert 才寫 `saved`，更新的推播改「✏️ 已透過 LIFF 更新」且不附撤銷按鈕。 |
| ~~M12~~ | ~~確認時成員已被移除，`calculateDistribution` 把該人份額默默加給調整成員。~~ | ✅ **已完成**（2026-09-05）：存檔前比對出已不在成員清單的名字就拒絕存入並列出來；同時 `releaseNonce()` 放掉剛佔用的 nonce，卡片的「✏️ 編輯」才不會跟著失效。 |
| ~~M13~~ | ~~綁定、斷開、切換旅程時舊草稿沒失效。~~ | ✅ **已完成**（2026-09-05）：A1／A2／A7 三條成功路徑都呼叫 `supersedeAllDrafts(sourceId)`。 |
| M14 | ROADMAP #5：結算匯率換算兩邊不一致。 | 把餘額彙總收進 `_shared/finance.ts`，納入契約測試。 |
| M15 | 語音訊息不支援。 | Gemini 可直接吃音訊：下載 `audio/m4a` 後走與文字相同的 schema。 |
| ~~M16~~ | ~~`cleanText` 的 `@\S+` 會把 `@小明` 也刪掉（L14），AI 看不到付款人。~~ | ✅ **已完成**（2026-09-05）：`stripSelfMentions()` 依 `mentionees[].index/length` 只切 `isSelf` 的那幾段（由後往前刪避免錯位）；沒有 mention 資料時原樣回傳。 |
| ~~M17~~ | ~~對話歷史沒把發言者帶進 prompt（L15）。~~ | ✅ **已完成**（2026-09-05）：歷史查詢一併撈 `speaker_name`，`summarizeHistoryEntry()` 對 user 訊息加上「發言者：」前綴。 |
| ~~M18~~ | ~~AI 回的分類不驗證（F7），會存進旅程裡不存在的分類。~~ | ✅ **已完成**（2026-09-05）：`resolveCategory()`（`guards.ts` 並有測試），對不上退回旅程預設 →「其他」→ 清單第一個並提醒。 |
| ~~M19~~ | ~~機器人加入群組不打招呼（L12）。~~ | ✅ **已完成**（2026-09-05）：處理 `join` event，回 `BOT_SELF_INTRODUCTION`。 |

---

## 11. 給實作者的順序與驗證流程

> **狀態（2026-09-04）**：這一節的步驟 1–7 都已執行完畢，保留下來當作
> 「當初是照什麼順序做的」紀錄。下面的「驗證」清單仍然有效 ——
> 真機測試（第 3 點）與 SQL 抽查（第 4 點）**尚未執行**。

### 建議順序

1. **先抽純函式並加測試**（不改行為）：新檔 `supabase/functions/line-webhook/guards.ts`，搬入 `extractJSON`、`toAmountMap`、`normalizeName`、`resolveMember`、`resolveExpenseMembers`、`KNOWN_CURRENCIES`、`normalizeCurrency`、`normalizeDate`、`detectRecordIntent`、`claimsCompletedAction`、`summarizeHistoryEntry`。這些沒有 Deno 專屬 import。`index.ts` 改為 import。
   新檔 `supabase/functions/line-webhook/guards.test.ts`（`vitest.config.ts` 已 include `supabase/**/*.test.ts`）。至少涵蓋：
   - `detectRecordIntent`：`剛剛那筆改 500` → `edit`；`把昨天那筆刪掉` → `delete`；`這筆帳我改天再處理` → `null`；`取消行程` → `null`。
   - `claimsCompletedAction`：「已經幫您刪除了」true；「我沒辦法刪除」false。
   - `resolveMember`：完全相同、大小寫、子字串唯一解、兩個候選 → null、空字串 → null。
   - `normalizeCurrency`：在 rates 內、合法但無匯率（reject）、亂碼（warning + fallback）、空字串（fallback 無警告）。
   - `normalizeDate`：合法、格式錯、超過一年、無效日期（2026-02-30）。
   - `toAmountMap`：陣列形式、物件形式、同名相加。
   `check:functions` 只列 `index.ts`，`guards.ts` 透過 import 一起被檢查，不必改 script。
2. H1 + H7 + M13 的函式改名（`supersedeDraft` / `supersedeAllDrafts`）與 schema 欄位。
3. H2（依賴 H1 的 `getOutstandingDrafts`）。
4. H3、H11、H12（都在撤銷路徑，一起改）。
5. H5、H6、H8、H9（彼此獨立）。
6. H4（含前端 `ExpenseModal.tsx`）。
7. 文件：`docs/LINE_BOT.md` 對應段落、`BOT_SELF_INTRODUCTION`、`CLAUDE.md` LINE Bot 段落提到 `guards.ts`、`ROADMAP.md` 加 M1–M19、本文件的「現況」欄改成 ✅。

### 驗證

1. `npm run lint && npm test && npm run check:functions && npm run build`（CI 四關）。
2. 部署：`npm run fn:deploy`（`line-webhook` 已帶 `--no-verify-jwt`；`liff-notify` 改了 H12 也要一起部署）。`ExpenseModal.tsx` 是前端，要 push `main`。
3. 真機測試（用 MCP `query_logs` 看 Edge Function log），至少跑：
   - `晚餐 300` → `計程車 200` → 兩張卡都能確認（H1）。
   - 傳收據 → `剛剛那筆改 500` → 新卡帶縮圖、舊卡按下去顯示「已被取代」（H1、H2）。
   - 傳收據 → `計程車 200` → 新卡**沒有**縮圖，收據卡仍可確認（H1）。
   - 傳收據 → `取消` → 回「已取消草稿」且 Storage 照片被刪（H2）。
   - 沒有草稿時 `剛剛那筆改 500` → 仍列編輯清單（H2 反向）。
   - 存兩筆 → `取消上一筆` × 2 → 兩筆不同的支出被撤（H3）。
   - USD 旅程 `今日支出` 合計無浮點尾數；`結算` 顯示兩位小數（H5）。
   - 1:1 說 `我付的晚餐 300` → 付款人是自己（H9）。
   - 封存旅程傳照片 → 收到「已封存」（H8）。
   - 網頁結清後 `編輯支出` → 清單無結清紀錄（H4）。
4. 用 MCP `execute_sql` 確認 `line_processed_actions` 的 `superseded` 列只在修正時出現，且 `saved` 列每次存入都有。

---

## 12. Feature F：旅程層級的 AI 記帳偏好（LINE 按鈕 + 網頁設定頁）

> **狀態（2026-09-04）**：✅ 已實作。
> DB 欄位 `trips.ai_preference`（migration `20260904_trip_ai_preference.sql`，含舊資料搬遷）、
> `SettingsModal` 的「🤖 AI 記帳偏好」區塊、`src/pages/LiffPreference.tsx`（路由 `#/liff/preference`）、
> LINE 的「⚙️ 記帳偏好」快速回覆按鈕與改寫後的 `設定:` / `設定?` 指令都已完成。
> 下面的設計說明保留為實作紀錄。

### 動機

目前偏好只能靠打對前綴的 `設定:` 文字指令設定，不直覺，也沒人記得格式。
而且它存在 `line_user_states.default_config`，是「每個 LINE 綁定各一份」：同一趟旅程若有人在群組綁、有人 1:1 綁，
偏好互不相通；網頁上完全看不到、也改不了。

擁有者的期望：**一趟旅程只有一份 AI 記帳偏好**，在 LINE 裡像「編輯支出」那樣按一顆按鈕就跳出頁面編輯，
網頁的旅程設定頁也顯示並可編輯同一份。

### 設計

**資料**

- `trips` 新增 `ai_preference TEXT`（可為 NULL）。語意就是現在的「個人偏好設定」，只是範圍變成整趟旅程。
- 兩處都要改：`supabase/schema/01_tables_core.sql` 加欄位（跑 `npm run db:build`），
  以及新 migration `supabase/migrations/2026MMDD_trip_ai_preference.sql`。
- migration 順手搬資料：每個 `trips.ai_preference` 為 NULL 的旅程，若有 `line_user_states.current_trip_id` 指向它且 `default_config` 非空，
  把那段文字複製過去；多個綁定文字不同時取 `created_at` 最新的一筆（`last_active_at` 從未被更新，不能用）。
  舊欄位 `line_user_states.default_config` **保留不刪**，只是程式不再讀寫。

**網頁（`src/components/SettingsModal.tsx`）**

- 新增一個「🤖 AI 記帳偏好」區塊：一個 textarea，說明文字「耀西在 LINE 解析你說的話或收據時會參考這段描述，整趟旅程共用一份」，
  placeholder 給範例「預設由代杰付款，大家均分；日幣一律不換算；我是代杰」。
- 存檔走既有的 trip update 流程，空字串存成 `NULL`（與 `access_code` 同樣的正規化慣例）。
- `src/types/index.ts` 的 `Trip` 加 `ai_preference?: string | null`。

**LINE 端（`supabase/functions/line-webhook/index.ts`）**

- `getQuickReply()` 已綁定的按鈕列加一顆 `⚙️ 記帳偏好`，型別 `uri`，
  網址 `${WEBAPP_URL}/#/liff/preference?tripId=${tripId}`。
  注意 `getQuickReply` 目前不知道 tripId，簽章要多帶一個參數；呼叫端都在 `boundQR` 附近。
- `設定:`／`設定：` 文字指令**保留**當快速捷徑，但寫入目標改成 `trips.ai_preference`。
- `設定?` 改讀 `trips.ai_preference`，回覆末尾附一顆同樣的 LIFF 按鈕（quick reply 即可）。
- 讀取偏好的兩處都改：OCR prompt 的 `使用者設定：${userState.default_config}` 與
  `tripContext` 的 `【使用者設定】${userState.default_config}` → 改為 `trip.ai_preference`（兩處的 `trip` 查詢都已是 `select('*')`，不必改查詢）。
- `BOT_SELF_INTRODUCTION` 的「⚙️ 個人偏好設定」段改寫成「⚙️ AI 記帳偏好（整趟旅程共用）：按下方『記帳偏好』按鈕編輯，或輸入『設定:...』」；
  `docs/LINE_BOT.md` 一字不差同步，並更新「群組成員共用偏好」的說明為「整趟旅程共用，不分管道」。

**LIFF 頁（新檔 `src/pages/LiffPreference.tsx`）**

- 路由 `#/liff/preference?tripId=...`，註冊方式比照 `src/App.tsx` 第 72 行的 `<Route path="/liff/edit" …>`。
- 流程照抄 `LiffEdit.tsx`：動態載入 LIFF SDK → 有 `VITE_LIFF_ID` 才 `liff.init` → 讀 `trips` → 顯示 textarea（預填 `ai_preference`）→
  儲存按鈕直接 `supabase.from('trips').update({ ai_preference })`（本專案 LIFF 頁本來就直接寫 DB，RLS 全開，見 ROADMAP 風險 1）→
  成功畫面與關閉視窗邏輯（`closeLiffWindow`、`canCloseWindow`）整段沿用。
- 不需要 nonce／postback／`liff-notify`：這是覆寫單一欄位，重複送出沒有副作用。
- 它是**前端**，改完要 push `main` 才會生效（見 CLAUDE.md 部署一節）。

### 影響到的情境

- B1、B2、B4、B5、B6、B13（第 1 章）已標注。B5「清除偏好」在表單裡清空後儲存即可，原本的 ❌ 一併解掉。
- E3（1:1「我」對不上）：偏好裡若寫了「我是代杰」，搬到旅程層級後群組裡每個人都會看到這句，
  語意會變成「這趟旅程的『我』預設是代杰」。文件與 placeholder 要提醒使用者這是共用的，
  身分請用 H9 修好的傳訊者名稱，不要靠偏好。

### 驗證

1. 網頁設定頁改偏好 → LINE 說「晚餐 300」→ 卡片依新偏好分攤。
2. LINE 按「⚙️ 記帳偏好」→ LIFF 改字 → 儲存 → 網頁設定頁重新整理後看到同一份。
3. `設定:預設由我付款` 仍可用，且網頁看得到。
4. `設定?` 顯示旅程層級內容並附按鈕。
5. 升級前用 `設定:` 存過的旅程，升級後 `設定?` 仍看得到原本內容（migration 搬資料）。
6. `npm run lint && npm test && npm run check:functions && npm run build`。

---

## 13. 第一輪真機測試發現的 bug（T1–T4）與修法

高優先修正（第 10.1 節）上線後，擁有者實測回報四個問題。都是**設計上的漏洞**而不是筆誤，
修法寫得比較細，實作者請照做；行號以 commit `834bce5` 為準，仍以函式名為主。

> **狀態（2026-09-04）**：T3 → T1 → T4 → T2 **已全部實作完成**，每個 T 都跑過
> `lint / test / check:functions / build` 四關。下面的修法內容保留下來當作
> 「為什麼要這樣寫」的紀錄。對應的情境列（含新增的 J18、J19、D10、K23、K24、K25）已更新。
> ⚠️ **尚未部署**：T1／T3／T4 只動 Edge Function，T2 前端與 Edge Function 必須同時上線。

### T1　「剛剛那個改 250」沒有草稿時被當成新支出，重複記了一筆

- **現象**：`剛剛那筆改 235`（有「那筆」）正確列出編輯清單；`剛剛那個改250`（「那個」）直接進 AI，
  AI 回了一張「計程車 250」的新卡片。使用者要的是：有草稿 → 修草稿；沒草稿 → 編輯清單。
- **原因**：兩層都漏了。
  1. `detectRecordIntent()` 的 `RECORD_NOUN` 只認「支出／花費／帳／紀錄／這筆／那筆／上一筆」，「那個」「這個」「剛剛」「剛才」都不算受詞。
  2. 進了 AI 之後沒有第二道防線：system instruction 只用文字叫它「回 chat 請使用者輸入編輯支出」，
     但 schema 允許它回 `expense`，它就回了。
- **修法**（兩層都做）：
  1. `guards.ts`：`RECORD_NOUN` 加 `那個|這個|剛剛|剛才|剛才那|上一個|前一個|最後一筆|最近一筆|最新一筆`。
     `EDIT_VERB` 維持要「改＋數字」或「改成／改為／改到／改一下」，所以「剛剛那個改天再說」仍不會誤判。
     `guards.test.ts` 加：`剛剛那個改250` → `edit`、`剛才那個刪掉` → `delete`、`剛剛那個改天再說` → `null`。
  2. 新增純函式 `mentionsEditingExisting(text)`：只要出現 `EDIT_VERB` 或 `不對|錯了|打錯|記錯|更正`，就回 true。
     在 P8 收到 AI 的 `expense` 回覆後、產生卡片之前加一道判斷：
     **沒有任何未確認草稿、AI 沒填 `corrects_draft`、且 `mentionsEditingExisting(cleanText)` 為 true** →
     不出卡片，改列編輯清單（重用既有清單程式碼，抽成 `replyEditPicker()`），並在清單標題下加一句
     「看起來你想改已經存入的紀錄。如果其實是要新記一筆，請不要用『改』來描述」。
  3. 編輯清單本身已依日期與建立時間倒序，剛存的那筆會在第一列，不必另做「直接開最新一筆」。
- **驗證**：情境 I1、J6、J8；新增 J18「沒草稿時用『那個』『剛剛』指稱要改」。

### T2　從編輯清單改完再按同一顆「編輯」，LIFF 顯示的還是舊資料

- **現象**：LIFF 存檔成功，網頁看到新金額，但回到 LINE 再按清單上同一列的「✏️ 編輯」，表單填的是修改前的值。
- **原因**：就是第 10.2 節的 **M2**。`buildEditLiffUrl()` 把整筆支出 base64 塞進網址，清單訊息發出去的那一刻資料就凍結了。
  同時也是 LINE `uri` 上限 1000 字的隱患。
- **修法**（把 M2 提前做）：
  1. `LiffEdit.tsx` 支援三種進入方式，優先順序：
     - `?tripId=…&id=<expenseId>&u=<sourceId>`：直接 `supabase.from('expenses').select('*').eq('id', id).single()`，
       每次開啟都拿到最新內容。找不到或 `deleted_at` 非空就顯示「這筆支出已被刪除或不存在」。
     - `?tripId=…&n=<nonce>&u=<sourceId>`：草稿。查 `line_chat_history` where `line_user_id = u` and `role = 'pending'`
       （RLS 對匿名開放，見 `05_policies.sql`），取最近 10 列在前端 parse `content`，找 `n` 相符的那一列，
       欄位對應與現在 `decoded` 的 `d/a/c/dt/cat/p/s/pi` 相同。找不到就提示「這張卡片已過期，請重新記帳」。
       另外查 `line_processed_actions` 是否已有這個 nonce，有的話直接顯示「這張卡片已處理過」，不要開表單。
     - `?data=<base64>`：舊格式，保留給已經發出去的卡片，行為不變。
  2. `index.ts`：`buildEditLiffUrl()` 改為只組 `id` 與 `u`；兩個草稿卡片（OCR 與文字路徑）的「✏️ 編輯」網址改為只帶 `n` 與 `u`。
     `liffData` 那兩段 base64 編碼可以整段刪除。
  3. `ExpenseModal` 不用改：它已經靠 `editData.id` 決定 UPDATE，靠 `nonce`／`line_user_id` 決定鎖與通知。
  4. 這是**前端**改動，要 push `main`；Edge Function 也要重新部署，兩邊要一起上，否則舊網址格式對不上。
- **驗證**：情境 J5、J14、H5；新增 J19「改完再按同一顆編輯看到新資料」。

### T3　「夾娃娃300」預設幣別是 JPY，卻出了 TWD 的卡片

- **現象**：旅程主幣 TWD、預設幣別 JPY。使用者沒提幣別，AI 有時填 JPY、有時填 TWD。
- **原因**：幣別完全交給 AI 決定。`tripContext` 同時給了「主幣：TWD」與「預設：JPY」，判斷優先權只是一行文字，
  小模型（`gemini-*-flash-lite`）常把「主幣」當成該填的值。`normalizeCurrency()` 只擋「不存在」的幣別，TWD 在 rates 裡所以放行。
- **修法**（改成程式決定，不靠 prompt 記性）：
  1. `TEXT_RESPONSE_SCHEMA` 與 `OCR_RESPONSE_SCHEMA` 的 `data` 加欄位
     `currency_source: { type: 'STRING', enum: ['stated', 'preference', 'none'] }`：
     `stated` ＝ 使用者這句話（或收據上）明確出現幣別字眼或符號；`preference` ＝ 記帳偏好指定；`none` ＝ 都沒有。
     `currency` 的 description 改為「只在 currency_source 不是 none 時才有意義」。
  2. `guards.ts` 新增 `resolveCurrencyByRule(aiCurrency, source, text, trip)`：
     - `source === 'none'` → 一律回 `trip.default_currency || trip.base_currency`，忽略 AI 填的值。
     - `source === 'stated'` → 再用程式驗一次：文字裡有沒有幣別字眼（新常數 `CURRENCY_HINTS`：
       `日幣|日圓|円|¥|JPY|台幣|新台幣|NT|TWD|美金|美元|USD|\$|韓元|₩|KRW|歐元|€|EUR|港幣|HKD|泰銖|฿|THB|人民幣|RMB|CNY|新幣|SGD|馬幣|MYR|越南盾|VND`）。
       有 → 採 AI 的值；沒有 → 視同 `none`（AI 說謊），並記 log。OCR 路徑沒有文字可驗，直接信 `stated`。
     - `source === 'preference'` → 採 AI 的值（偏好是自由文字，程式驗不了）。
     - 回傳值再交給既有的 `normalizeCurrency()` 做 rates／白名單檢查，流程不變。
  3. `tripContext` 的【幣別】那行改寫成：
     `【幣別】記帳預設：JPY（使用者沒明講就填這個）｜結算主幣：TWD（只用於統計，不要拿來當記帳幣別）｜可用：{rates}`。
     `YOSHI_SYSTEM_INSTRUCTION` 規則 2 補一句：「沒有出現幣別字眼時 currency_source 填 none，currency 填旅程的記帳預設幣別」。
  4. `guards.test.ts`：`none` 強制預設、`stated` 但文字沒有幣別字眼退回預設、`stated` 且有「日幣」採 JPY、`preference` 照用。
- **驗證**：情境 D1、D5、D6；新增 D10「沒提幣別時一律用預設幣別，與主幣別不同也一樣」。

### T4　問「剛剛 Lawson 那筆買了什麼」，分析的是另一張收據

- **現象**：AI 回 `analyze_photo`，但 `url` 指到之前另一筆的照片，回答內容完全不對。
- **原因**：現在是把最近 10 筆的**完整照片網址**塞進 `tripContext`，要 AI 逐字抄回來。網址長、只差幾個數字，
  小模型抄錯或抄成上一輪對話裡出現過的那個。全庫搜尋那條路也是同樣做法。此外只分析 `photo_urls[0]`，多張收據只看第一張。
- **修法**（AI 只回「編號」，程式自己找照片）：
  1. `expensesSummary` 改成有編號的清單：`#3 2026-09-04 Lawson (便利商店) 1,280 JPY [餐飲] 📷×2`。**不再放網址**（也省 token）。
  2. `TEXT_RESPONSE_SCHEMA` 移除 `url`，改為 `expense_ref: { type: 'STRING', description: 'analyze_photo 時填近期支出的編號，例如 #3；不在清單裡就留空字串' }`。
     `question` 維持。system instruction 加一句：「使用者說『剛剛』『最新』又沒指名店名時，選清單裡日期最近且有 📷 的那一筆」。
  3. P8 的 `analyze_photo` 分支改為：
     - 先用 `expense_ref` 在剛剛查出的 `expenses` 陣列裡找（同一次查詢的結果，不要再查一次）。
     - 找不到 → 全庫查 `photo_urls` 非空的支出（已有這段），**先在程式端縮小範圍**：把 `question` 與各支出的 `description`
       用 `normalizeName()` 做子字串比對，命中一筆就直接用；命中多筆或零筆才交給 AI，但 AI 一樣只回編號
       （`selectPrompt` 改成帶 `#n` 的清單，回 `{ found, ref }`）。
     - 決定了那一筆之後，把它**所有** `photo_urls` 都下載（重用 `fetchPhotoPart`），一次交給 `analyzeReceiptPhoto()`。
       函式簽章改為 `analyzeReceiptPhoto(photoUrls: string[], question, expenseLabel)`，prompt 開頭標明
       「以下 N 張是同一筆支出『{description} {amount} {currency}』的收據」。
  4. 回覆訊息開頭附上是哪一筆：`🔍 {date} {description} {amount} {currency}` 再接分析內容；
     寫進 `line_chat_history` 的 model 內容前面加 `[收據分析 #{id前8碼}]`，下一輪追問（「那第二項是什麼」）才有指代對象。
  5. `getPublicUrl` 那些在 context 組網址的程式碼可以刪掉。
- **驗證**：情境 K15、K16；新增 K23「剛剛那筆（不指名）」、K24「多張照片的支出」、K25「指名店名但不在最近 10 筆」。

### 建議順序

T3 → T1 → T4 → T2。前三個只動 Edge Function，可以一起部署驗證；T2 牽涉前端與 Edge Function 要同時上線，最後做。
每個 T 做完都要把本文件對應的情境列更新（現況欄與新增的情境），並跑四關。
