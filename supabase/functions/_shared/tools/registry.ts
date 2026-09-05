// ============================================================
// tools/registry.ts —— 對外公開的工具清單
//
// 一支工具＝一個名字、一段給模型看的說明、一份 JSON Schema、一個 execute。
// 同一份定義同時餵給兩邊（docs/MCP_SERVER_DESIGN.md §2）：
//   Gemini -- `tools[0].functionDeclarations`（toGeminiFunctionDeclarations）
//   MCP    -- `tools/list` 的 `inputSchema`
//
// ⚠️ execute 的回傳**一律是物件**：Gemini 的 functionResponse.response 不接受
//    陣列或純字串，MCP 那邊也是包在物件裡回。陣列請包成 { expenses: [...] }。
//
// LINE 的文字路徑用得到這裡的**讀取**工具（`toGeminiFunctionDeclarations(READ_TOOL_NAMES)`
// 與 `runTool`），寫入類的 create／update／delete 則刻意不公開給模型 ——
// 那三支會直接落地，對話式管道一律要先出一張確認卡（見 line-webhook/gemini.ts）。
// package.json 的 check:functions 仍把這個檔案列成獨立的進入點，
// 免得沒人用到的那幾支工具漏掉 deno check。
// ============================================================

import {
  commitExpense,
  commitExpenseUpdate,
  deleteExpense,
  expenseRef,
  listExpenses,
  prepareExpense,
  prepareExpenseUpdate,
  resolveExpenseRef,
  restoreExpense,
} from "./expenses.ts"
import { getBalance, getSettlementPlan } from "./balance.ts"
import { getTrip } from "./trip.ts"
import { optionalString, toExpenseInput, toExpensePatch, toListFilters } from "./args.ts"
import {
  EXPENSE_INPUT_SCHEMA,
  EXPENSE_REF_SCHEMA,
  GET_BALANCE_SCHEMA,
  LIST_EXPENSES_SCHEMA,
  NO_ARGS_SCHEMA,
  UPDATE_EXPENSE_SCHEMA,
} from "./schemas.ts"
import type {
  GeminiFunctionDeclaration,
  ToolArgs,
  ToolContext,
  ToolDefinition,
} from "./types.ts"

// ============================================================
// 工具
// ============================================================

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_trip',
    description: '取得目前這趟旅程的設定：成員、分類、幣別與匯率、精度、預設付款人與分攤、時區與今天的日期。不確定成員或分類怎麼寫時先呼叫它。',
    inputSchema: NO_ARGS_SCHEMA,
    execute: (_args, ctx) => Promise.resolve(getTrip(ctx)),
  },
  {
    name: 'list_expenses',
    description: '依日期、分類、成員或關鍵字查詢這趟旅程的支出。要指稱某一筆（修改、刪除、看收據）時，先用它拿到 ref。',
    inputSchema: LIST_EXPENSES_SCHEMA,
    execute: (args, ctx) => listExpenses(toListFilters(args), ctx),
  },
  {
    name: 'get_balance',
    description: '每人折合主幣別的淨結餘（正數＝應收、負數＝應付）。回答「我還欠多少」「誰付最多」用這個，不要自己加總。',
    inputSchema: GET_BALANCE_SCHEMA,
    execute: (args, ctx) => getBalance(ctx, optionalString(args.member)),
  },
  {
    name: 'get_settlement_plan',
    description: '最少轉帳次數的結清路徑：誰要付給誰多少錢。',
    inputSchema: NO_ARGS_SCHEMA,
    execute: (_args, ctx) => getSettlementPlan(ctx),
  },
  {
    name: 'create_expense',
    description: '記一筆新支出。金額分配與幣別由伺服器驗算，付款人與分攤留空就套用旅程預設值。',
    inputSchema: EXPENSE_INPUT_SCHEMA,
    execute: async (args, ctx) => {
      const prepared = prepareExpense(toExpenseInput(args), ctx.trip, {
        today: ctx.today,
        actorName: ctx.actorName,
        // 這條路徑沒有「使用者原話」可以驗證幣別，只能相信呼叫端填的 currency_source
        sourceText: null,
      })
      if (prepared.reject) {
        return { ok: false, reason: 'rejected', message: prepared.reject }
      }
      // 對不上成員清單的名字一律不記 —— 記錯人比不記更難發現
      if (prepared.unresolvedMembers.length > 0) {
        return {
          ok: false,
          reason: 'unknown_members',
          unknown_members: prepared.unresolvedMembers,
          members: ctx.trip.members ?? [],
        }
      }
      const saved = await commitExpense(prepared.expense, ctx)
      if (!saved.ok) return { ok: false, reason: saved.reason, dropped_members: saved.dropped ?? [] }
      return {
        ok: true,
        id: saved.id,
        ref: saved.id ? expenseRef(saved.id) : null,
        expense: prepared.expense,
        warnings: prepared.warnings,
      }
    },
  },
  {
    name: 'update_expense',
    description: '修改一筆既有支出。只填要改的欄位，其餘沿用原值；改了金額而沒指定分攤時會重新均分。',
    inputSchema: UPDATE_EXPENSE_SCHEMA,
    execute: async (args, ctx) => {
      const ref = optionalString(args.expense_ref)
      if (!ref) return { ok: false, reason: 'not_found' }
      const existing = await resolveExpenseRef(ref, ctx, { allowSettlement: false })
      if (!existing) return { ok: false, reason: 'not_found' }

      const prepared = prepareExpenseUpdate(existing, toExpensePatch(args), ctx.trip, {
        today: ctx.today,
        actorName: ctx.actorName,
        sourceText: null,
      })
      if (prepared.reject) return { ok: false, reason: 'rejected', message: prepared.reject }
      if (prepared.unresolvedMembers.length > 0) {
        return {
          ok: false,
          reason: 'unknown_members',
          unknown_members: prepared.unresolvedMembers,
          members: ctx.trip.members ?? [],
        }
      }

      const saved = await commitExpenseUpdate(existing.id, prepared.expense, ctx)
      if (!saved.ok) return { ok: false, reason: saved.reason }
      return {
        ok: true,
        id: existing.id,
        ref: expenseRef(existing.id),
        changes: prepared.changes,
        expense: prepared.expense,
        warnings: prepared.warnings,
      }
    },
  },
  {
    name: 'delete_expense',
    description: '把一筆支出丟進垃圾桶（軟刪除），24 小時內可以還原。',
    inputSchema: EXPENSE_REF_SCHEMA,
    execute: async (args, ctx) => {
      const ref = optionalString(args.expense_ref)
      if (!ref) return { ok: false, reason: 'not_found' }
      const existing = await resolveExpenseRef(ref, ctx, { allowSettlement: false })
      if (!existing) return { ok: false, reason: 'not_found' }
      const result = await deleteExpense(existing.id, ctx)
      return result.ok
        ? { ok: true, id: existing.id, description: result.description }
        : { ok: false, reason: result.reason, description: result.description ?? null }
    },
  },
  {
    name: 'restore_expense',
    description: '把垃圾桶裡的支出還原。',
    inputSchema: EXPENSE_REF_SCHEMA,
    execute: async (args, ctx) => {
      const ref = optionalString(args.expense_ref)
      if (!ref) return { ok: false, reason: 'not_found' }
      // 要還原的東西當然已經被刪掉了，這裡一定要 includeDeleted
      const existing = await resolveExpenseRef(ref, ctx, { includeDeleted: true, allowSettlement: true })
      if (!existing) return { ok: false, reason: 'not_found' }
      const result = await restoreExpense(existing.id, ctx)
      return result.ok
        ? { ok: true, id: existing.id, description: result.description }
        : { ok: false, reason: result.reason, description: result.description ?? null }
    },
  },
]

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

/** 執行一支工具。名字不認得就丟例外 —— 那代表 declarations 與 registry 不同步。 */
export function runTool(name: string, args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) return Promise.reject(new Error(`Unknown tool: ${name}`))
  return tool.execute(args ?? {}, ctx)
}

/**
 * 轉成 Gemini 的 function declarations。
 *
 * 不給 `names` 就是全部。實務上會給 —— 不同路徑該讓模型看到的工具不一樣
 * （例如只讀的查詢情境不該看得到 delete_expense）。
 */
export function toGeminiFunctionDeclarations(names?: string[]): GeminiFunctionDeclaration[] {
  const wanted = names && names.length > 0 ? TOOLS.filter((t) => names.includes(t.name)) : TOOLS
  return wanted.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }))
}
