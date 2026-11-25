// ============================================================
// ai.ts —— 呼叫 AI 的一切（LINE 這一側）
//
// 與管道無關的部分（系統指令、OCR schema、函式清單、收據重讀、用哪一家）
// 都在 `_shared/assistant/ai.ts`，網頁聊天（web-chat）用的是同一份。
// 這裡只剩：依環境變數建好 `ai`、LINE 才有的語音轉文字。
//
// handlers 只認得 `ai` 這個 `AiProvider`：一次性的 `ai.generate()` 與 function calling 的 `ai.runToolLoop()`。
// ============================================================

import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"
import { AI_PROVIDER, ANTHROPIC_API_KEY, CLAUDE_MODEL, GEMINI_API_KEY, GOOGLE_MAPS_API_KEY } from "./config.ts"
import { downloadLineContent } from "./line-api.ts"
import {
  analyzeReceiptPhoto as analyzeReceiptPhotoWith,
  buildTextToolDeclarations,
  createAssistantAi,
  readToolNames,
  STAY_SILENT_TOOL,
  TERMINAL_TOOL_NAMES,
  withStaySilent,
} from "../_shared/assistant/ai.ts"
import type { AiProvider } from "../_shared/ai/types.ts"

export {
  AMOUNT_LIST_SCHEMA,
  EXPENSE_DATA_SCHEMA,
  fetchPhotoPart,
  GEMINI_FALLBACK_MODELS,
  GEMINI_OCR_MODELS,
  memberAliasHint,
  OCR_RESPONSE_SCHEMA,
  STAY_SILENT_TOOL,
  TERMINAL_TOOL_NAMES,
  TRIP_SUMMARY_TOOL,
  YOSHI_SYSTEM_INSTRUCTION,
} from "../_shared/assistant/ai.ts"

/** handlers 只用這一個：`ai.generate()` 與 `ai.runToolLoop()` */
export const ai: AiProvider = createAssistantAi({
  provider: AI_PROVIDER,
  geminiApiKey: GEMINI_API_KEY,
  anthropicApiKey: ANTHROPIC_API_KEY,
  claudeModel: CLAUDE_MODEL,
})
console.log(`[AI] provider: ${ai.name}`)

/** 只讀的查詢工具。要 Google Places 的 key（付費 API），沒設就不給 search_places */
export const READ_TOOL_NAMES = readToolNames(!!GOOGLE_MAPS_API_KEY)

/** 文字路徑餵給模型的完整函式清單 */
export const TEXT_TOOL_DECLARATIONS = buildTextToolDeclarations(READ_TOOL_NAMES)

/** 群組裡「接話」的訊息多一支 stay_silent（加在最後面，Claude 的快取才吃得到前段） */
export const FOLLOWUP_TOOL_DECLARATIONS = withStaySilent(TEXT_TOOL_DECLARATIONS)
export const FOLLOWUP_TERMINAL_NAMES = [...TERMINAL_TOOL_NAMES, STAY_SILENT_TOOL]

/** 重新閱讀某一筆支出的收據並回答問題（實作見 _shared/assistant/ai.ts） */
export function analyzeReceiptPhoto(photoUrls: string[], question: string, expenseLabel: string): Promise<string> {
  return analyzeReceiptPhotoWith(ai, photoUrls, question, expenseLabel)
}

/**
 * LINE 語音訊息的格式固定是 m4a（AAC）。
 * Gemini 的 inlineData 吃得下，不需要自己轉檔。Claude 不收音訊，語音一律由 Gemini 免費版轉文字，
 * 轉出來的文字再走一般的文字路徑（AI_PROVIDER=claude 時就是交給 Claude）。
 */
export const AUDIO_MIME = 'audio/m4a'
/** 語音訊息通常只有幾秒鐘；超過這個大小多半是出了什麼問題，不要浪費額度 */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024

/**
 * 把語音訊息轉成文字（M15）。
 *
 * ⚠️ 刻意「先轉文字、再走原本的文字流程」，而不是把音檔直接丟給記帳的 schema：
 *    這樣快捷指令（「今日支出」）、草稿修正（「剛剛那筆改 500」）、
 *    取消、編輯清單……全部都能用語音講，而不是只有記帳。
 *    代價是多一次 Gemini 呼叫。
 */
export async function transcribeAudio(messageId: string): Promise<string> {
  const res = await downloadLineContent(messageId)
  if (!res.ok) throw new Error(`Failed to download audio from LINE: ${res.status}`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new Error('AUDIO_TOO_LARGE')

  const prompt = `請把這段語音**逐字**轉成文字。
語音可能是中文、英文或日文，也可能夾雜好幾種語言：中文一律寫成繁體中文，
英文與日文照原文寫出來，**不要翻譯**（人名、店名、地名維持原本的寫法）。
只輸出聽到的內容本身，不要加上任何說明、引號或前後綴。
聽不清楚、沒有人聲或只有雜音時，輸出空字串。`

  const text = await ai.generate({
    task: 'audio',
    messages: [{
      role: 'user',
      parts: [
        { text: prompt },
        { media: { mimeType: AUDIO_MIME, data: encodeBase64(new Uint8Array(buf)) } },
      ],
    }],
    temperature: 0,
  })

  // 模型偶爾會自己加引號包住整句
  return text.trim().replace(/^["'「『]+|["'」』]+$/g, '').trim()
}