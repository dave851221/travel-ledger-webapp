"""
產生「旅行小本本」的 Google 試算表行程模板：docs/itinerary-sheet-template.xlsx

用法：python scripts/make-itinerary-template.py
上傳到 Google 雲端硬碟 → 用 Google 試算表開啟 → 檔案 → 儲存為 Google 試算表 →
共用改成「知道連結的任何人：檢視者」→ 把網址的 /edit… 換成 /copy，填進 src/features/itinerary/sheet.ts 的 SHEET_TEMPLATE_COPY_URL。
格式規則（欄位名稱、類型、預訂狀態）跟 supabase/functions/_shared/sheetItinerary.ts 對應，改一邊要一起改。
"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

OUT = Path(__file__).resolve().parent.parent / "docs" / "itinerary-sheet-template.xlsx"

HEAD_FILL = PatternFill("solid", fgColor="14213D")
HEAD_FONT = Font(bold=True, color="FFFFFF", size=11)
DAY_FILL = PatternFill("solid", fgColor="FFF4DC")
DAY_FONT = Font(bold=True, color="14213D")
EXAMPLE_FONT = Font(color="5B6478")
THIN = Side(style="thin", color="E3E6EC")
WRAP = Alignment(wrap_text=True, vertical="top")
TOP = Alignment(vertical="top")
ROWS = 400  # 下拉選單與文字格式套到第幾列

KINDS = ["📅 當天標題", "✈️ 航班", "🚆 交通", "🏯 景點", "🍜 美食", "🛍️ 購物", "🎡 活動", "🏨 住宿", "📝 其他"]
BOOKINGS = ["✅ 已付款", "📌 已預約", "🚶 現場排隊", "⏳ 待預訂", "❓ 未確認"]


def header(ws, names, widths, notes):
    ws.append(names)
    for i, (w, note) in enumerate(zip(widths, notes), start=1):
        c = ws.cell(row=1, column=i)
        c.fill, c.font = HEAD_FILL, HEAD_FONT
        c.alignment = Alignment(vertical="center")
        if note:
            c.comment = Comment(note, "旅行小本本", width=260, height=110)
        ws.column_dimensions[c.column_letter].width = w
    ws.row_dimensions[1].height = 26
    ws.freeze_panes = "A2"


def text_columns(ws, letters):
    """日期、時間存成文字：Google 試算表才不會自動轉成日期格式，讀出來跟打的一樣"""
    for col in letters:
        for r in range(2, ROWS + 1):
            ws[f"{col}{r}"].number_format = "@"


def dropdown(ws, col, options, title):
    dv = DataValidation(type="list", formula1='"' + ",".join(options) + '"', allow_blank=True,
                        showErrorMessage=False, promptTitle=title, prompt="從清單選，或自己打字也可以")
    dv.add(f"{col}2:{col}{ROWS}")
    ws.add_data_validation(dv)


wb = Workbook()

# ── 行程 ──────────────────────────────────────────────
ws = wb.active
ws.title = "行程"
header(
    ws,
    ["日期", "時間", "類型", "行程", "地點", "備註", "連結", "預訂"],
    [11, 13, 13, 30, 22, 34, 26, 13],
    [
        "每天第一列寫日期就好（例如 11/14），同一天下面的列留空白。",
        "09:00、09:00-11:00，或「早上」「晚餐」這種時段都可以。",
        "從下拉選單選。選「📅 當天標題」的那一列會變成那天的標題，地點欄寫城市。",
        "要做什麼，例如「伏見稻荷」「搭 Haruka 到京都」。",
        "會變成 Google 地圖連結；好幾個地點用頓號「、」隔開。",
        "一行一條。開頭打「!」會變成紅色提醒。",
        "訂位頁、Google 地圖或官網的網址。",
        "訂了沒：從下拉選單選。",
    ],
)
text_columns(ws, ["A", "B"])
dropdown(ws, "C", KINDS, "類型")
dropdown(ws, "H", BOOKINGS, "預訂")

sample = [
    ["11/14", "", "📅 當天標題", "抵達京都", "京都", "! 記得先換日幣", "", ""],
    ["", "09:30-13:00", "✈️ 航班", "桃園 → 關西 CI152", "", "", "", "✅ 已付款"],
    ["", "14:00", "🚆 交通", "搭 Haruka 到京都站", "關西機場站", "ICOCA 先儲值 3000 円", "", ""],
    ["", "16:00", "🏨 住宿", "飯店 check in", "京都站前飯店", "", "", "✅ 已付款"],
    ["", "晚餐", "🍜 美食", "京都拉麵小路", "京都拉麵小路", "", "", "🚶 現場排隊"],
    ["11/15", "", "📅 當天標題", "東山散步", "京都", "", "", ""],
    ["", "08:00", "🏯 景點", "清水寺、二年坂", "清水寺、二年坂", "早點去人比較少\n穿好走的鞋", "", ""],
    ["", "12:00", "🍜 美食", "湯豆腐午餐", "奧丹 清水", "", "", "📌 已預約"],
    ["", "下午", "🛍️ 購物", "錦市場", "錦市場", "", "", ""],
    ["11/16", "", "📅 當天標題", "回家", "大阪", "", "", ""],
    ["", "10:00", "🏨 住宿", "退房", "", "", "", ""],
    ["", "18:30-21:00", "✈️ 航班", "關西 → 桃園 CI157", "", "", "", "✅ 已付款"],
]
for row in sample:
    ws.append(row)
for r in range(2, ws.max_row + 1):
    is_day = ws.cell(row=r, column=3).value == "📅 當天標題"
    for c in range(1, 9):
        cell = ws.cell(row=r, column=c)
        cell.alignment = WRAP if c in (4, 6) else TOP
        cell.border = Border(bottom=THIN)
        if is_day:
            cell.fill, cell.font = DAY_FILL, DAY_FONT

# ── 住宿 ──────────────────────────────────────────────
st = wb.create_sheet("住宿")
header(
    st,
    ["入住日期", "退房日期", "住宿名稱", "地址", "連結", "備註"],
    [11, 11, 26, 34, 30, 30],
    ["例如 11/14", "例如 11/16", "", "", "訂房頁或官網", "一行一條"],
)
text_columns(st, ["A", "B"])
st.append(["11/14", "11/16", "京都站前飯店", "京都市下京區東塩小路町", "", "含早餐\n15:00 後入住"])
for c in range(1, 7):
    st.cell(row=2, column=c).alignment = WRAP

# ── 行前準備 ──────────────────────────────────────────
ck = wb.create_sheet("行前準備")
header(ck, ["要準備的東西"], [40], ["一列一樣東西，行程頁可以打勾（勾選記在各自的手機）。"])
for item in ["護照（效期 6 個月以上）", "網卡／eSIM", "日幣現金", "轉接頭、行動電源", "旅平險"]:
    ck.append([item])

# ── 使用說明 ──────────────────────────────────────────
how = wb.create_sheet("使用說明")
how.column_dimensions["A"].width = 90
lines = [
    ("怎麼用這份行程表", True),
    ("1. 把範例改成你們的行程：「行程」分頁一列一件事，每天第一列寫日期，下面同一天的列不用再寫。", False),
    ("2. 每天最上面可以加一列「📅 當天標題」，行程頁會用它當那天的標題。", False),
    ("3. 右上角「共用」→「一般存取權」改成「知道連結的任何人」（檢視者就好）。要一起編輯的旅伴另外加成編輯者。", False),
    ("4. 把這份試算表的網址貼到旅行小本本的「行程」分頁，就完成了。之後在這裡改，行程頁按「更新」就看得到。", False),
    ("", False),
    ("小提醒", True),
    ("・分頁名稱「行程」「住宿」「行前準備」不要改；可以自己多加欄位或分頁，旅行小本本會略過看不懂的。", False),
    ("・備註一行一條，開頭打「!」會變成紅色提醒。", False),
    ("・地點欄寫店名或景點名稱就會變成 Google 地圖連結；連結欄可以貼訂位頁或地圖網址。", False),
    ("・旅行喵喵（LINE 和網頁的 AI）也會讀這份行程，可以直接問它「明天幾點出門」。", False),
]
for text, bold in lines:
    how.append([text])
    cell = how.cell(row=how.max_row, column=1)
    cell.alignment = Alignment(wrap_text=True, vertical="top")
    cell.font = Font(bold=True, size=13) if bold else Font(size=11)

OUT.parent.mkdir(parents=True, exist_ok=True)
wb.save(OUT)
print(f"wrote {OUT}")
