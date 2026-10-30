# LINE Bot (耀西) 運作與架構說明

本文件深入說明 Travel Ledger WebApp 專屬 LINE Bot（耀西）的行為邏輯、架構設計與程式碼說明。

實作位於 `supabase/functions/line-webhook/`（模組清單見 [`../CLAUDE.md`](../CLAUDE.md) 的架構段）。
開發者若修改機器人邏輯或自我介紹，請務必同步更新本文件與對應的模組。

## 1. 核心行為與功能
- **自然語言記帳**: 透過 Gemini AI 解析使用者的自然語言輸入（例如：「午餐 500 迪哥付的」），自動轉化為結構化的記帳資料。
  支援追溯性指令，如「剛剛那筆改 500」，AI 會參考尚未確認的草稿清單進行修正（見下方「草稿的修正與取消」）。
  **一句話可以記多筆**（「午餐 300 晚餐 500」出兩張卡，上限 4 筆）。
- **自然語言修改／刪除既有支出**（Feature G）: 「把昨天的拉麵改成 300」「刪除 9/3 那筆計程車」
  會由 AI 定位到那一筆並送出一張確認卡（「✏️ 修改預覽」或「🗑 確認刪除？」），
  **按下確認才會真的動到帳本**。要改的那筆不在最近 10 筆裡時，AI 會先呼叫 `list_expenses` 去查；
  找不到唯一一筆就反問，不會猜。清單式的「編輯支出」「刪除支出」仍然保留。
- **問行程、天氣、當地資訊**（2026-10-29）: 綁定的旅程有行程頁時，AI 讀得到同一份行程
  （網頁 build 時輸出的 `itinerary/<tripId>.json`）。context 只放**一行**今天的行程（第幾天、城市、今晚住哪），
  其餘由模型用工具查需要的那一段：
  - `search_itinerary`：關鍵字（「水明館 停車」「租車」「check-in」），回最相關的最多 12 段。
  - `get_itinerary_day`：某一天的完整內容與當晚住宿須知（一天約 600 token）。
  - `get_itinerary_overview`：每天一行 + 航班、住宿、預訂與待預訂提醒。
  - `get_weather`：Open-Meteo 免費預報（16 天內），不給地點就用那天行程的座標；問天氣不會上網搜尋。
  - `web_search`（只有 Claude）：行程與帳本回答不了、需要即時資訊（營業時間、票價、交通、附近推薦）時才上網，
    一則訊息最多 2 次，回答附 1–2 個來源網址。搜尋關鍵字不放成員名字與金額。
  回答提到地點、店家、住宿或車票時，行程裡有附網址（地圖、訂位、車票連結）就一起附上；工具輸出只保留 160 字以內的網址。
  行程頁的客製區塊（`extra`）是畫面元件，Bot 看不到。沒有行程頁的旅程照實說沒有行程表。
- **群組裡的來回對話**（2026-10-29）: 提及模式下，除了 @耀西 與「耀西」開頭，還有兩種情況也會處理：
  - 對機器人的訊息按 LINE 的「回覆」（引用回覆）—— 等同 @提及。
  - 機器人剛回覆過的**同一個人**，3 分鐘內的下一句話（接話）。每次回覆往後延 3 分鐘，所以可以一直聊下去。
    接話可能只是在跟別人講話，AI 判斷不是在問它就**不回**（`stay_silent`），那句話也不寫進對話歷史；
    接話不會上網搜尋，出錯也不回錯誤訊息。其他人插話不會延長任何人的接話時間。
- **改由備援回答時會說一聲**: `AI_PROVIDER=claude` 而 Claude 額度用完或連不上時，改用 Gemini 免費版回答，
  回覆最前面多一句「⚠️ Claude 本月額度已用完，這次改用免費版 Gemini 回覆」（或「暫時連不上」）。
  額度用完之後 10 分鐘內直接用 Gemini，不再每則先試一次 Claude。
  一對一聊天在等 AI 時會顯示「輸入中…」動畫（LINE 只支援一對一）。
- **收據 OCR 智慧辨識**: 
  - **自動流程**: 使用者上傳照片後，機器人會自動下載並同步存儲至 Supabase Storage (`expenses/{tripId}/{messageId}.jpg`)。
  - **AI 解析**: 使用 Gemini 視覺模型辨識商店、金額、幣別、日期與品項。
  - **預設值參考**: AI 會優先參考旅程設定的「預設幣別」與「預設類別」，結合「AI 記帳偏好」（`trips.ai_preference`）預測分帳比例。
  - **封存旅程**: 若旅程已封存，照片不會上傳，直接回覆「🔒 此旅程已封存，無法新增支出（照片未儲存）」。
  - **付款畫面也算收據**（M7）：行動支付（LINE Pay、街口、PayPay、Suica）的付款完成畫面、
    信用卡消費通知、轉帳成功畫面、電子發票、訂單確認頁都會照常解析。
    只有「與消費無關」的照片（人物、風景、無關截圖）才回 `not_receipt`。
  - **照片記帳（不是收據的品項照片）**：食物、飲料、商品、紀念品、門票、店面、菜單這類
    「拍的是可以記帳的東西、但不是收據」的照片回 `item_photo`。AI 判斷這是什麼當作描述
    （外文照樣保留原文加中文說明），挑分類、日期填今天，**金額留空**（草稿裡以 0 占位，
    就算照片上看得到價格也不猜）。卡片標題是「📷 照片記帳」，總金額顯示「尚未填寫」，
    **沒有「✅ 確認存入」按鈕**，只有「✏️ 填金額」（LIFF 編輯頁，金額欄空白、付款人與分攤名單照預設勾好）
    與「❌ 取消」。舊卡片或自己拼的 postback 按「存入」也會被 `commitExpense` 以 `invalid_amount` 擋下。
    群組也會出卡（群組傳照片本來就不需要 @ 機器人）。
  - **收據還是商品照片**（網頁「相簿」分兩區）：pending 草稿帶 `rc: true` 代表照片是收據
    （機器人讀出了金額），存入時寫進 `expenses.receipt_photo_urls`。在 LIFF 改過再存、
    選幣別（`cur`）、打字修正那張草稿都會沿用；📷 照片記帳不帶 `rc`，存進去是商品照片。
  - **認不出是什麼、或 AI 沒回應時照片也不丟**（2026-10-29，使用者要求，取代 M8 的「刪照片」）：
    `not_receipt`、AI 回壞掉的格式、所有模型都失敗（額度、忙碌、逾時、其他錯誤）都會出一張
    描述與金額都空白的「📷 照片記帳」卡（`buildExpenseCard({ unidentified: true })`，
    描述顯示「（還沒填內容）」，按鈕是「✏️ 填寫內容」與「❌ 取消」）。AI 沒回應時卡片前多一句原因。
    **群組也一樣會出卡**（以前群組靜默刪除）。只有下載或上傳 Storage 本身失敗才會回錯誤訊息。
  - **辨識結果有問題時不刪照片**（M10）：
    - 幣別在這趟旅程沒有匯率 → 照片留著，辨識結果存成 `pending`，
      回覆附「以 TWD 存入」「以 JPY 存入」等快速回覆（只列 `trip.rates` 內的幣別，最多 12 顆）
      加上「❌ 取消」。按下去走 `act: 'cur'` postback：**只換幣別標籤、金額不換算**
      （與 prompt 的「嚴禁換算匯率」一致），分帳依新幣別的精度用
      `calculateDistribution` 重算，餘數由調整成員吸收，Σ 仍等於總額。
      舊 nonce 會被鎖成 `superseded`，同一則訊息連按兩次不會出兩張卡。
    - 分帳出現對不上的成員 → 把那些名字拿掉、套旅程預設分攤後照常出卡，
      卡片前多一則提醒請使用者按「✏️ 編輯」。
    以前這兩種情況都是刪照片要人重傳，只為了改一個幣別或一個名字。
  - **一次多張**: 相簿多選送出的每張收據各自產生一張卡片，彼此獨立，都可以分別確認。
  - **預覽確認**: 解析後會回傳包含收據縮圖的 Flex Message，使用者確認後才正式寫入資料庫；若取消，系統會自動刪除 Storage 中的照片。
- **雙重綁定機制**: 
  - 使用者在 LINE 輸入 `ID:短碼` 啟動綁定流程（寫入 `pending_trip_id` 與 `pending_at`）。
  - 系統要求輸入旅程的 `access_code` 進行驗證，成功後正式綁定 (`current_trip_id`)。
  - 若該旅程未設定密碼（`access_code` 為 NULL 或空白），則略過驗證步驟，輸入 `ID:短碼` 後直接綁定成功。
  - **切換旅程時不會先斷開**（M1）：輸入新的 `ID:` 只寫 `pending_trip_id`，
    `current_trip_id` 原封不動，**驗證成功才切換**。因此這兩個欄位可以同時有值 = 切換中。
    切換途中打的不是新旅程的密碼時，訊息會直接往下走正常流程（原旅程照常記帳、查詢），
    不會回「密碼錯誤」把使用者鎖住。
  - **放棄與逾時**（M1）：輸入「取消綁定」／「放棄綁定」清掉 `pending_trip_id`（保留原綁定）；
    `pending_at` 超過 **10 分鐘**（`PENDING_BIND_TTL_MS`）下一次收到事件時自動放棄。
    `pending_at` 為 NULL 的舊資料一律視為過期。
  - **群組等密碼期間不吵人**（A13）：密碼不對時，只有 @提及機器人或以「耀西」開頭
    才回「密碼錯誤」，其他人的閒聊靜默略過；輸對密碼仍然照常綁定。
  - **綁定、斷開、切換都會讓舊草稿失效**（M13，`supersedeAllDrafts()`）——
    草稿 payload 裡帶著舊的 `tid`，換旅程後再按那張卡會把支出寫進上一趟旅程。
- **群組喚醒邏輯**:
  - 單對單聊天：機器人會回應所有訊息。
  - 群組聊天（預設「提及模式」）：必須提及 (Tag) 機器人、以「耀西」開頭、或執行系統指令
    （`ID:`、`設定:` / `設定：` / `設定?` / `設定？`、`斷開`、`切換旅程`、`取消綁定`、`模式:`、
    以及下方的快捷查詢指令）才會喚醒。
    注意「耀西」必須位於訊息開頭才算觸發，這是為了避免閒聊提到就被喚醒。
    ⚠️ 偏好指令是**精確比對**而不是 `startsWith('設定')`（M3）——
    以前群組裡的「設定好了嗎」會被當成管理指令送進 AI。
  - **三種模式可切換**（快速回覆會列出目前以外的另外兩種）：

    | 模式 | 指令 | 照片 | 文字 | 語音 |
    | :-- | :-- | :-- | :-- | :-- |
    | 提及模式（預設） | `模式:提及模式` | 都處理 | 要 @ 或「耀西」開頭（另有引用回覆與接話） | 不處理 |
    | 全回應模式 | `模式:全回應模式` | 都處理 | 全部處理 | 處理 |
    | 靜音模式（2026-10-30） | `模式:靜音模式` | **不處理**（不下載、不回覆） | 同提及模式 | 不處理 |

    存在 `line_user_states` 的 `mention_required` 與 `photos_muted` 兩欄，由 `groupModeOf()`（guards.ts）合成 `GroupMode`。
    群組訊息進 AI 時 context 會帶一行【群組模式】，有人問「照片怎麼沒反應」時耀西能回答是靜音模式、怎麼切回來。
    名稱與說明文字都在 `messages.ts` 的 `GROUP_MODE_INFO`。
  - 狀態以 `sourceId`（群組為 groupId）為單位，**同群組成員共用同一份綁定** —— 這是刻意的設計，
    讓群組內任何人都能對同一本帳記錄、查詢與撤銷。
- **發言者名稱**: 群組、聊天室與一對一都會呼叫 LINE API 取得發言者的顯示名稱
  （`getChatMemberName`，三種來源三個 endpoint），餵進 prompt 讓 AI 把「我付的」對應到成員。
  群組的回覆會標明「由 X 記錄」，一對一則不贅述。
  **對話歷史也帶發言者**（M17）：群組整串歷史是共用的，`summarizeHistoryEntry()`
  會把 user 訊息壓成「發言者：內容」，否則多輪對話裡別人講的「我付的」會被算到當下這位頭上。
- **只移除提及機器人的那一段**（`stripSelfMentions`，M16）: 依 `mentionees[].index/length`
  只切掉 `isSelf` 的片段（由後往前刪，index 才不會錯位），其他人的 `@名字` 原封不動留著。
  以前是把所有 `@開頭的詞` 一律刪光，「@耀西 @小明 你付的晚餐 300」的付款人整個消失（L14）。
  ⚠️ index 是相對於**未 trim 的**原始 `message.text`，所以要拿原文去切。
- **被加進群組時自我介紹**（M19）: 處理 `join` event，回 `BOT_SELF_INTRODUCTION`。
- **AI 記帳偏好（整趟旅程共用）**: 存在 `trips.ai_preference`，
  **一趟旅程只有一份**，不分 LINE 綁定、不分管道 —— 網頁的旅程設定頁、
  LINE 的「⚙️ 記帳偏好」LIFF 頁（`#/liff/preference?tripId=...`）、
  以及文字指令「設定: ...」編輯的都是同一個欄位。
  - 查看：輸入「設定?」或「設定？」，回覆末尾附一顆可直接編輯的按鈕。
  - 清除：輸入「設定:清除」，或在表單裡清空後儲存（空字串一律存成 `NULL`）。
  - 舊的 `line_user_states.default_config` 已不再讀寫，僅保留舊資料
    （migration `20260904_trip_ai_preference.sql` 已把內容搬到 `trips.ai_preference`）。
  - ⚠️ 因為是整趟旅程共用，偏好裡**不要**寫「我是○○」—— 群組裡每個人看到的都是同一句。
    身分請靠上面的發言者名稱判斷。
- **財務完整性校驗**: 
  - **高精度運算**: 內建與前端一致的 `decimal.js` 邏輯處理餘數分配。
  - **最終防線**: 在 `expenses` 表格寫入前，系統會強制校驗 `Σ(付款人金額) == 總額` 且 `Σ(分帳金額) == 總額`。若不符則拒絕寫入。
  - **餘額彙總與匯率換算只有一份規則**（M14）: `getRate()` / `convertToBase()` /
    `calculateMemberBalances()` 在 `_shared/finance.ts` 與 `src/utils/finance.ts` 各一份，
    由 `finance.parity.test.ts` 的契約測試比對。「結算」與網頁的 `useTripStats` 呼叫的是同一套。
    **主幣別一律以 1 換算**，不管 `rates` 裡寫什麼 —— 幣別對自己的匯率是定義而不是設定值。
    以前 Bot 寫 `currency === base ? 1 : rates[...]`、前端寫 `rates[...] || 1`，
    `rates[base]` 不等於 1 時兩邊會算出不同的結算結果，而且看起來都很合理。
    漏設匯率的幣別會被回報：結算訊息明講「已當成 1:1 折算，結果會失真」。
- **待確認卡片只有一份實作**（`buildExpenseCard()`）: OCR、文字記帳、以及 M10 的
  「以 XXX 存入」三條路徑送出的 Flex 卡片完全一樣，只差標題與有沒有收據縮圖。
  以前是三份幾乎相同的 JSON 散在流程裡，改一顆按鈕要記得改三個地方。
- **防重複提交 (Idempotency)**: 
  - 每個 Flex Message 確認按鈕皆帶有唯一的 `nonce`。
  - 點擊後會紀錄於 `line_processed_actions` 表，防止因連點或網路延遲產生的重複帳務。
- **編輯與刪除既有支出**: 輸入「編輯支出」或「刪除支出」會列出近期紀錄，
  每列右側一顆固定文字的按鈕（描述放在左邊的文字列，不塞進按鈕，否則按鈕寬度會爆掉）。
  編輯是 LIFF `uri` 按鈕，網址**只帶 expense id 與 sourceId**
  （`?tripId=…&id=<expenseId>&u=<sourceId>`，`buildEditLiffUrl()`）——
  `LiffEdit` 每次開啟都拿 id 直接查 DB，`ExpenseModal` 看到 id 就走 UPDATE，
  少了它會變成新增一筆重複的。
- **LIFF 編輯頁的三種進入方式**（`src/pages/LiffEdit.tsx`，優先序 `id` > `n` > `data`）:
  1. `?tripId=…&id=<expenseId>&u=<sourceId>` —— 既有支出，直接
     `select('*').eq('id', id)`，每次開啟都是最新內容；查無或 `deleted_at` 非空
     就顯示「這筆支出已被刪除或不存在」。
  2. `?tripId=…&n=<nonce>&u=<sourceId>` —— 尚未確認的草稿，從
     `line_chat_history` 的 `pending` 列（最近 10 筆）找 `n` 相符的那一列；
     同時檢查 `line_processed_actions`，已處理過就直接說明而不開表單。
     RLS 對匿名完全開放，前端讀得到（`supabase/schema/05_policies.sql`）。
  3. `?data=<base64>` —— **舊格式，必須保留**，已經發出去的卡片還帶著它。
  ⚠️ 舊格式的問題正是要改掉它的原因：整筆資料在訊息送出的那一刻就凍結了，
  從清單改完金額再按同一顆「編輯」看到的還是舊值；而且 LINE 的 `uri` action
  上限 1000 字，多成員長描述時整張清單會直接發不出去。
  ⚠️ **這是前端改動，要 push `main`；Edge Function 也要同時重新部署**，
  否則新網址格式對不上（前端與 Edge Function 是兩條獨立的部署路徑）。
- **用自然語言講的刪除／修改不再被路由層攔截**（Feature G）。以前有一支 `detectRecordIntent()`
  會在「沒有待確認草稿」時把這類句子攔下來直接列清單，因為當時的 AI 沒有修改既有紀錄的能力。
  現在它有了（`propose_expense_update` / `propose_expense_delete`），那道攔截連同函式與測試一併移除 ——
  留著只會把該進 AI 的句子擋在門外。**精確關鍵字**（`編輯支出`、`刪除支出`、`取消上一筆`…）維持不進 AI。
- **第二道防線：AI 提議新記一筆，但現場沒有草稿可修**（`mentionsEditingExisting`）。
  模型偶爾會把「改成 250」當成一筆新支出而不是改既有的那一筆，照著出卡片就憑空多記一筆。
  所以在產生卡片之前再判斷一次：
  **沒有任何未確認草稿 + AI 沒填 `corrects_draft` + 這句話有「改／不對／錯了／打錯／記錯／更正」**
  → 不出卡片，改列編輯清單（`replyEditPicker()`），並在標題下加一句
  「看起來你想改已經存入的紀錄。如果其實是要新記一筆，請不要用『改』來描述。」
  清單依日期與建立時間倒序，剛存的那一筆必定在第一列。
- **編輯／刪除清單不含結清紀錄**（`.not('is_settlement', 'is', true)`）。
  結清是網頁「結算」功能寫進去的特殊紀錄，被當成一般支出編輯會讓統計失真。
- **假完成宣稱的防線**: 修改與刪除只是「提議」，要使用者按確認卡才生效，但 AI 仍可能回
  「已經幫您刪除了」。送出前以 `claimsCompletedAction` 攔截並換成
  「我可以幫你提議修改或刪除，但要你按了確認卡片才會真的生效」——
  讓使用者以為帳已經改掉，比直說還沒生效更糟。
  ⚠️ regex 只認**過去式**：「確認後就會修改好了」「按下去才會更新」是我們**要**模型講的話，
  攔掉它等於逼它改口說謊（見 `guards.test.ts` 的「未來式的說明不能被誤殺」）。
- **嚴禁自行換算匯率**: 兩個 prompt 都明令 `amount` 與 `currency` 必須照抄收據／使用者的原始幣別。
  換算只在統計時由前端依 `trip.rates` 進行；AI 先換過會讓原始金額永久遺失。
- **幣別由程式決定，不靠 prompt 記性**（`resolveCurrencyByRule`，位於 `guards.ts`）:
  兩個 schema 都要求 AI 回一個 `currency_source`（`stated` / `preference` / `none`），
  程式再據此決定真正要用的幣別 ——
  `none` 一律套旅程的記帳預設幣別（完全忽略 AI 填的值）；
  `stated` 還要文字裡真的出現幣別字眼或符號（`CURRENCY_HINTS`）才採信，沒有就視同 `none`；
  `preference` 因為是自由文字驗不了，直接採用。OCR 沒有文字可驗，`stated` 直接採信。
  結果仍會再過一次 `normalizeCurrency()` 的 rates／白名單檢查。
  ⚠️ 原因：`tripContext` 同時有「主幣」與「預設」兩個數字時，小模型常把主幣當成該填的值，
  主幣 TWD／預設 JPY 的旅程打「夾娃娃300」就會出一張 TWD 的卡片。
  兩個 prompt 的幣別區塊因此也改寫成「記帳預設（沒明講就填這個）」與
  「結算主幣（只用於統計，不要拿來當記帳幣別）」兩行，不再只給一個 rates 物件。
- **外文店名的描述格式**: 保留原文並在括號補上簡短中文說明「這是什麼店」，
  例如「肉の匠家 (和牛燒肉店)」，而不是逐字直譯，也不是只留原文。
- **草稿的修正與取消**: 「草稿」＝已送出 Flex 卡片但使用者還沒按確認或取消的那一筆，
  存在 `line_chat_history` 的 `pending` 列（`getOutstandingDrafts()` 掃最近 10 列，回未處理的）。
  ⚠️ 同一張表也放 AI 的修改／刪除提議卡（`kind: 'update'` / `'delete'`），
  但那些**不算草稿**，`getOutstandingDrafts()` 只回 `kind` 為空或 `'expense'` 的列 ——
  否則使用者打「取消」會取消到一張修改卡，AI 也會拿它的 nonce 去填 `corrects_draft`。
  - 每張草稿的 **nonce 會一起餵進 `tripContext` 的【尚未確認的草稿】**，
    AI 修正時必須用 `corrects_draft` 欄位指名它在修哪一張。
  - **只有被指名的那一張會失效**（`supersedeDraft()` 把它的 nonce 寫進 `line_processed_actions`，
    重用既有的防重複點擊鎖）。連續記多筆、群組裡多人同時記帳、一次傳多張收據時，
    每張卡片都各自保留 —— 早期版本每送一張新卡就作廢先前全部，是明確的 bug。
  - 舊卡片被按下時會依 `action_type` 回覆原因：`superseded` 說「已被較新的記帳建議取代」，
    `save` 說「先前已成功存入」，`cancel` 說「先前已取消」。
  - 文字取消：`取消`／`不要記`／`不用記`／`算了`／`取消這筆`／`取消剛剛那筆`
    （`CANCEL_DRAFT_KEYWORDS`，精確比對）會取消最新一張草稿並刪掉已上傳的收據照片。
- **收據的逐項重新分帳**: 聊天室裡若還有一張未確認／未取消的收據草稿，
  後續的文字訊息會**連同那張收據一起**送給 AI。
  所以使用者可以說「A 是我吃的，小明吃 B」，AI 重新閱讀收據品項後重算分攤，
  再送出一張新卡片；光靠文字是分不出各品項金額的。
  - 新卡片**只有在 `corrects_draft` 指向那張收據草稿時**才沿用它的 photo_ids。
    否則視為無關的新支出，不附照片 —— 傳完收據再打「計程車 200」，
    計程車那筆不該掛著別人的發票。
  - 帶圖時自動切換到視覺模型清單。
- **紀錄保留**: 由資料庫的 pg_cron 每天清理（`purge-line-records`，03:17 UTC）——
  `line_chat_history` 留 14 天、`line_processed_actions` 留 7 天。
  原本在 Edge Function 內以 10% 機率順手清理，沒人講話就不會清，已移除。
- **快捷查詢指令**: 以下為精確字串比對，會直接查詢資料庫而不經過 AI，因此結果保證正確
  （**只有這些精確字串**會被攔下來；其餘的自然語言 —— 包含記帳、查詢、修改與刪除 —— 一律進 AI）：
  （結果是 Flex 卡片，見 `summary-cards.ts`；快速回覆按鈕只留今日支出、編輯、刪除、旅程總覽、記帳偏好、使用說明，
  本月支出與結算改成打字）
  `今日支出` / `今天支出`、`本週支出` / `近期支出`、`本月支出`、`結算`、`旅程總覽`、
  `取消上一筆` / `撤銷上一筆`（軟刪除最近一筆存檔的支出）。
  金額一律以 `Decimal` 加總（`sumByCurrency`）並依旅程的 `precision_config` 格式化
  （`formatAmount`），不會出現浮點尾數，結算也不會把 12.50 顯示成 13。
- **撤銷的去重**: `取消上一筆` 會取最近 5 筆 `saved` 紀錄，撤第一筆**尚未被刪除**的。
  連說兩次會撤到兩筆不同的支出；全部都撤過了則明講並建議改用「刪除支出」。
  卡片上的「↩️ 撤銷」按鈕同理，已撤銷過就回「先前已經撤銷了」，
  不會重新 UPDATE `deleted_at`（那會讓網頁垃圾桶的 24 小時保留期重算）。
  撤銷按鈕的 postback **只帶 `eid`**，描述由 `undo` 分支回查 —— 塞描述進去會超過 300 bytes。
- **全趟彙總餵給 AI**（`summarizeTripExpenses`，位於 `guards.ts`）: AI 的 context 只放得下
  最近 10 筆支出，所以「這趟總共花多少」「我還欠多少」「交通花了多少」以前一律答錯 ——
  它只能把看得到的那 10 筆加一加（M6）。現在在伺服器端用 **Decimal** 算好，
  模型呼叫 `get_trip_summary` 時回給它（2026-10-29 以前是每則訊息都附在 `tripContext` 的【全趟彙總】，
  記帳、問行程這些用不到它的訊息也要付那幾百個 token）：
  - 筆數、日期範圍、各幣別合計、各分類合計（分幣別）—— **不含結清紀錄**，與快捷查詢一致（K19）。
  - 每人的已付／應付／淨額（分幣別）—— **含結清紀錄**，否則「我還欠多少」永遠不會歸零。
    淨額為正代表這個人先墊了錢，別人要還他。
  - system instruction 規則 7 明令：金額類問題先呼叫 get_trip_summary、引用它的數字，不得自己加總近期支出；
    彙總裡沒有的切片（例如「第一天花多少」）就照實說算不出來，不要硬湊。
  - 這支查詢刻意**不設 limit**：只看到一部分算出來的總額是錯的，比不答更糟。
  - **逐日合計**（K12）：分幣別列出每一天的合計，「第一天花多少」「昨天花多少」都問得到。
    超過 30 天的旅程只留最早一天與最近 29 天，中間明講省略了幾天，讓 AI 知道那段答不出來。
  - **金額最大的 3 筆**（K13）：跨幣別會先用 `getRate()` 折合主幣別再排序 ——
    3000 JPY 與 900 TWD 直接比數字是錯的。列出日期、描述、原幣金額與折合金額。
  - 彙總仍是「事先算好固定幾種切片」，但問到沒被涵蓋的角度時（某兩人之間的往來、某個關鍵字），
    模型現在可以自己呼叫 `list_expenses` / `get_balance` / `get_settlement_plan` 去查（Feature G）。
    彙總留著是因為它便宜又準：常見的金額問題不必多跑一輪工具呼叫。
- **收據照片再分析 (`analyze_receipt`)**: 若使用者針對某筆已有收據照片的支出追問細節（品項明細、外文翻譯等），
  AI 會呼叫 `analyze_receipt`，系統重新取回該筆的收據交給 Gemini 逐項解析後作答。
  - **AI 只回 ref，照片由程式自己找**：近期支出清單是有 ref、標 📷 的格式
    （`ref=1a2b3c4d 2026-09-04 Lawson (便利商店) 1280 JPY [餐飲] 📷×2`），**不再放照片網址**。
    ref 是 uuid 前 8 碼，由 `resolveExpenseRef()` 換回那一筆（**唯一命中才算**，
    而且擋掉垃圾桶裡的與結清紀錄）。同一個 ref 也用在 `propose_expense_update` / `propose_expense_delete`。
    ⚠️ 以前是把完整網址塞進 context 要它逐字抄回來 —— 網址長又只差幾個字元，
    小模型常抄錯或抄成上一輪對話裡的另一張，使用者問 A 店卻拿到 B 店的收據。
    順帶也省掉每筆一長串網址的 token。
  - **不在近期 10 筆時的全庫搜尋**：先在程式端用 `matchExpensesByQuestion()`
    把問句與各筆 description（含「括號前的原文」，因為描述格式是「Lawson (便利商店)」）
    做 `normalizeName()` 子字串比對；唯一命中就直接用，多筆或零筆才交給 AI 二選一。
    那一次額外呼叫仍是 JSON mode（沒有工具要用，只是從清單裡挑一個），
    回的是 `#編號`，由 `pickExpenseByRef()` 換回那一筆 —— 所以那支函式**保留著**。
  - **一筆支出的所有照片一起分析**：`analyzeReceiptPhoto(photoUrls[], question, expenseLabel)`
    會把該筆的每一張 `photo_urls` 都下載送進模型，prompt 開頭標明
    「以下 N 張是同一筆支出『…』的收據」。以前只看 `photo_urls[0]`，
    長帳單拍成兩張時第二張的品項永遠問不到。
  - **回覆與歷史都標明是哪一筆**：回覆開頭是 `🔍 {日期} {描述} {金額} {幣別}`，
    寫進 `line_chat_history` 的內容前面加 `[收據分析 {ref}]`，
    下一輪追問（「那第二項是什麼」）才有指代對象。
- **旅程被刪除時不會 500**（M5）: AI 核心查完旅程先檢查 null 再往下走。
  以前直接讀 `trip.name` 會丟例外 → webhook 回 500 → LINE 重送同一則訊息。
- **語音記帳**（M15）: 收到 `audio` 訊息時下載 m4a，以 `inlineData` 交給 Gemini 逐字轉錄，
  轉出來的文字**當成使用者打的字**往下走 —— 所以快捷指令（「今日支出」）、
  草稿修正（「剛剛那筆改五百」）、取消、編輯清單全部都能用講的，不是只有記帳。
  代價是多一次 Gemini 呼叫（先轉錄、再解析），這是目前最慢的一條路徑。
  - ⚠️ **群組的提及模式不處理語音**：語音沒辦法 @提及機器人，要嘛每則語音都下載＋轉錄
    （群組裡語音很多，額度撐不住），要嘛跳過。想在群組用語音請切「模式:全回應模式」。
  - 聽不清楚（空轉錄）回「我聽不太清楚」；超過 10MB 回「這段語音太長了」。
  - 目前**不會回報聽到了什麼** —— 聽錯時請按卡片的「✏️ 編輯」或說「取消」。
- **旅程時區**（M4）: `getTripTimezone()` 優先讀 `trips.timezone`（IANA 字串，
  網頁「設定 → 基本設定」可選），並用 `Intl.DateTimeFormat` 驗證字串有效才採用。
  沒設定才退回舊的「從幣別猜」——主幣別是「折算成哪一種錢」，跟人在哪個時區無關，
  主幣 TWD 的日本旅程會猜成台北時間，日本時間 23:30 記帳就記到前一天去了（情境 F4）。
- **封存保護**: 機器人會檢查旅程的 `is_archived` 狀態。若已封存，則僅提供查詢與聊天功能，禁止新增支出。

## 2. 機器人自我介紹 (Self Introduction)
*注意：若修改以下自我介紹內容，請務必一字不漏地同步更新至 `messages.ts` 中的 `BOT_SELF_INTRODUCTION` 變數。*

```text
Yoshi! 我是旅遊記帳小幫手「耀西」🥚

🔗 先綁定旅程
輸入「ID:旅程代碼」（代碼在網頁的旅程設定），有密碼的話再輸入密碼

💰 記帳：用講的、拍照都可以
・「晚餐 1200」「小明付計程車 300」
・傳收據或商品照片，我幫你讀出來；也可以傳語音
・卡片按「✅ 確認存入」才會存；講錯就說「剛剛那筆改 500」
・存過的也能改或刪：「把昨天的拉麵改 300」

🗺 問我旅程的事
・「明天幾點出門？」「今晚住哪？」
・「明天京都會下雨嗎？」「附近推薦吃什麼？」
・「總共花多少？我還要給誰多少？」

👥 群組裡請 @耀西 或用「耀西」開頭叫我，對我的訊息按「回覆」也可以
⚙️ 分帳習慣按下方「記帳偏好」設定；今日支出、旅程總覽也在下方按鈕（「本月支出」「結算」直接打字）
```

## 3. 技術規格與實作細節

- **查日誌時看什麼**：AI 迴圈每一步都有一行。中間的查詢是
  `[AI] <模型> r<第幾輪> → <工具名> <參數>`（例如 `r1 → list_expenses {"keyword":"牛"}`），
  最後收尾的是 `[AI] <模型> → <終結函式名>`。答錯或找錯支出時，
  這兩行就能還原模型查了什麼、憑什麼那樣判斷。用 MCP 的 `query_logs` 撈。
- **檔案分工**: `index.ts` 只做驗簽、解析、建 `EventContext` 與分派（約 110 行）；
  五條路徑各自在 [`handlers/`](../supabase/functions/line-webhook/handlers/)
  （`postback.ts`、`image.ts`、`audio.ts`、`commands.ts`、`ai-text.ts`），
  共用的東西在 `config.ts`／`db.ts`／`util.ts`／`line-api.ts`／`drafts.ts`／`messages.ts`／`ai.ts`。
  記帳的實際動作（驗證、寫入、查詢、餘額）在 [`_shared/tools/`](../supabase/functions/_shared/tools/)，
  與未來的 MCP server 共用；AI 的呼叫與 function calling 迴圈在
  [`_shared/ai/`](../supabase/functions/_shared/ai/)（Gemini 與 Claude 各一個檔案，以 `AI_PROVIDER` 切換；不碰 `Deno.env`，所以測得動）。
  沒有副作用的純函式在 [`_shared/validate.ts`](../supabase/functions/_shared/validate.ts)（AI 回傳內容的驗證）
  與 [`guards.ts`](../supabase/functions/line-webhook/guards.ts)（與 LINE 有關的判斷與摘要），
  兩者都由 `guards.test.ts` 看守 —— 改這些行為請連同測試一起改。
  `check:functions` 列了這幾個進入點：`line-webhook/index.ts`、`liff-notify/index.ts`、
  `_shared/tools/registry.ts` 與 `_shared/ai/` 的三支，其餘模組透過 import 一起被檢查。
  完整的模組清單與 import 方向見 [`../CLAUDE.md`](../CLAUDE.md)。
- **狀態管理**: 透過 `line_user_states` 維護綁定狀態（`current_trip_id`／`pending_trip_id`／
  `pending_at`）與群組觸發模式；`last_active_at` 每次收到事件時由 `runInBackground()` 更新
  （在 M1 之前它是從未被寫過的死欄位）；
  AI 記帳偏好已改存 `trips.ai_preference`（`default_config` 保留但不再讀寫）。
- **對話記憶**: 紀錄於 `line_chat_history`，餵給 AI 的是最近 **8** 筆 `user`/`model` 訊息。
  同一張表另以 `role` 欄位承載兩種側通道：`pending`（Flex 卡片的 postback payload）與 `saved`（最近存檔的支出 id，供撤銷使用）。
- **Payload 優化**: LINE Postback Data 上限為 300 bytes，程式碼用三層手法因應：
  1. JSON 鍵名極端縮寫（`d`=description、`a`=amount、`c`=currency、`dt`=date、`cat`=category、`p`=payer、`s`=split）。
     撤銷按鈕只帶 `{"act":"undo","eid":"<uuid>"}`，描述一律回查而不放進 payload。
     LIFF 的 `uri` 按鈕同理，只帶 `id` 或 `n`（見上方「LIFF 編輯頁的三種進入方式」）。
  2. **真正的解法是 nonce 間接法**：postback 只帶 `{"act":"save","n":"<8碼>"}`（約 30 bytes），
     完整內容存在 `line_chat_history` 的 `pending` 列，點擊時再取回。
  3. 保留讀取舊格式內嵌欄位的相容分支，讓已發出的舊卡片仍可運作。
- **AI 呼叫方式**（以下以 Gemini 描述；Claude 的對應做法與差異見 `CLAUDE.md` 的「AI 供應商層」）:
  **文字與 OCR 是兩套不同的契約**，不要互相套用。
  - 人設與不可變規則放在 `systemInstruction`（`YOSHI_SYSTEM_INSTRUCTION`），與每次變動的旅程 context 分開。
  - **講話風格**也在那裡：像 LINE 聊天一樣 1–2 句、不要開場白與結尾客套、不用 Markdown（使用者嫌回覆太冗長，2026-10-30 收緊）。
  - 對話歷史組成真正的多輪 `contents`，而不是壓成一段文字塞進 prompt。
  - 記帳走低溫（0.2 ~ 0.4）以求穩定。
  - **文字路徑：function calling**（Feature G，`ai.runToolLoop()`，實作於 `_shared/ai/`）。
    模型可以先呼叫唯讀工具把資料查清楚，最後一定要呼叫一支「終結函式」：

    | 名稱 | 種類 | 效果 |
    | :--- | :--- | :--- |
    | `list_expenses` | 讀 | 依日期／分類／成員／關鍵字查支出（上限 50 筆），回 ref 給模型指名 |
    | `get_balance` | 讀 | 每人折合主幣別的淨結餘 |
    | `get_settlement_plan` | 讀 | 最少轉帳次數的結清路徑 |
    | `propose_expenses` | 終結 | 1–4 張「🤖 AI 記帳預覽」卡（`corrects_draft` 指名要修正的草稿） |
    | `propose_expense_update` | 終結 | 「✏️ 修改預覽」卡，列出欄位「前 → 後」 |
    | `propose_expense_delete` | 終結 | 「🗑 確認刪除？」卡 |
    | `analyze_receipt` | 終結 | 重新閱讀某一筆的收據並回答 |
    | `reply` | 終結 | 一般回覆（取代舊的 `type: chat`） |

    讀取工具的定義直接來自 `_shared/tools/registry.ts`（MCP 用同一份），
    `propose_*` 的參數 schema 也是 `_shared/tools/schemas.ts` 裡那幾份**本身**。
    ⚠️ 寫入類的 `create_expense` / `update_expense` / `delete_expense` **刻意不公開給模型** ——
    那三支按下去就落地了，LINE 這條路一律要經過使用者按確認；`execute` 那裡再擋一次。
  - **迴圈的三條硬性限制**（都已查證，違反的症狀都不好懂）：
    ①`tools` 與 `responseMimeType: application/json` **不能同時帶**（Gemini 3 以外直接 400），
    所以文字路徑不用 JSON mode，改以 `toolConfig.functionCallingConfig.mode = 'ANY'` 強迫每輪都回 function call；
    ②Gemini 3 的 `functionCall` part 帶 `thoughtSignature`，下一輪必須原樣送回，而且**簽章綁定模型** ——
    迴圈全程鎖定同一個模型，換模型時從原始 `contents` 重來；
    ③`functionResponse.response` 必須是 JSON **物件**，陣列或字串包成 `{ result }`（超過 6000 字元截斷並標記）。
    400 一律把 body 讀出來記 log；body 含 `thought_signature` / `function` / `tool` 字樣時視為
    `FatalError`（schema 問題，換模型沒用）。
  - **收尾與時限**：最多 3 輪；到最後一輪或超過 `deadlineAt` 時加 `allowedFunctionNames` 強迫收尾。
    `deadlineAt = event.timestamp + 45s`，以 **LINE 送出事件的時間**為準（排隊延遲要算進去），
    每次 fetch 的 timeout 取 `min(25s, 剩餘時間)`。
  - **OCR 路徑：維持 JSON mode**（`ai.generate` + `OCR_RESPONSE_SCHEMA`）。
    回應格式由 `responseSchema` 約束，prompt 不必手寫 JSON 範例。
    注意 Gemini 的 schema 不支援 `additionalProperties`，所以「成員 → 金額」是以
    `[{ member, amount }]` 陣列表達，解析後由 `toAmountMap()` 轉回程式內部慣用的 map。
    語音轉錄與「重新閱讀收據」也走 `ai.generate`（語音一律由 Gemini 處理）。
- **模型 fallback**: 依序嘗試多個模型。429（額度用盡）、404（模型下架）、400（不支援送出的設定）、
  5xx、連線失敗、逾時與空回應都會換下一個（`RetryableError`），全部失敗才回覆額度提示（`RATE_LIMIT:` 前綴）。
  `FatalError`（schema 問題、金鑰不對）直接往外丟，不浪費額度重試。
  文字與 OCR 使用不同的模型優先序。
- **寫入前的驗證**: AI 回傳的內容不會直接落地。
  - **成員名稱**：`resolveMember()` 做正規化與部分比對，把暱稱、大小寫差異對應回正式名稱；
    只有唯一解才採用，有歧義或對不上就回訊息詢問，不硬猜。
  - **幣別**：先由 `resolveCurrencyByRule()` 依 `currency_source` 決定該用哪一個（見上），
    再交給 `normalizeCurrency()` —— 旅程 `rates` 內的最優先，其次是 ISO 白名單，
    都不符就退回旅程預設幣別並提醒使用者。
  - **日期**：檢查 `YYYY-MM-DD` 格式、日期是否真的存在（`2026-02-30` 會被 `Date` 悄悄捲成 3/2）
    與「今天 ±1 年」的合理範圍，超出就退回今天並提醒。
  - **分類**：`resolveCategory()` 比照 `resolveMember` 做正規化與唯一子字串比對（M18）；
    對不上就退回旅程預設分類 →「其他」→ 清單第一個，並回一則提醒。
    以前完全不驗證，AI 回「美食」而旅程只有「餐飲」時會存進一個不存在的分類（F7）。
  - **付款人與分攤**：AI 回空陣列時由 `applyParticipantDefaults()` 補上預設值
    （付款：旅程預設付款人 → 傳訊者對應的成員 → 成員第一位；分攤：旅程預設分攤 → 全員），
    規則與前端 `src/utils/quickAdd.ts` 的 `buildQuickAddDraft` 一致。
    存檔時若過濾掉已被移除的成員後仍為空，會請使用者按「編輯」補上，而不是回「聯絡管理員」。
    **只要有任何一個名字已不在成員清單裡就拒絕存入**（M12）並把名字列出來 ——
    默默存下去的話，那個人的份額會被 `calculateDistribution` 當成餘數加到調整成員身上，
    Σ 仍然等於總額，所以連最終防線也攔不住，帳面上完全正常卻有人平白多背一份。
  - **拒絕存入時會 `releaseNonce()`**：「確認存入」是先寫 nonce 再做事（防連點的鎖），
    不放掉的話整張卡片會死掉 —— 連我們自己叫使用者去按的「✏️ 編輯」都會回「已處理過」。
  - 任何被修正的欄位都會以文字訊息告知使用者，不會默默改掉。
- **錯誤處理**: 
  - 針對圖片下載、OCR 解析、資料庫寫入皆有完善的 `try-catch` 保護。
  - OCR 失敗或使用者取消時，會自動清理已上傳的 Storage 暫存檔。
- **多幣別支援**: 根據旅程的 `precision_config` 自動判定金額精度（如 TWD 預設為 0 位小數，其餘為 2 位）。
  折算成主幣別一律走 `getRate()`（主幣別恆為 1），與網頁共用同一套規則。
- **背景工作**: 對話歷史等不影響回覆的寫入交給 `runInBackground()`
  （內部走 `EdgeRuntime.waitUntil`）。**`saved` 紀錄例外，一定要 `await`** ——
  Edge Runtime 會在回應送出後中止未完成的 promise，那一列掉了會讓「取消上一筆」撤到更早的支出。

## 4. 回歸檢查表

改 Bot 邏輯前後請對照 [`LINE_SCENARIOS.md`](LINE_SCENARIOS.md)：
它列出所有已知使用情境、目前的支援狀態，以及尚未修的 bug 清單。要加新功能，先在那裡加情境再動手。
