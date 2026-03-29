# Travel Ledger WebApp - 旅遊記帳與行程管理系統

這是一個專為旅遊設計的財務管理系統，支援多幣別、精確分帳與即時同步。

## 🚀 常用開發指令 (Build & Run)

在開始開發前，請確保已安裝 [Node.js](https://nodejs.org/)。

### 1. 安裝環境與依賴
```bash
# 安裝所有必要的套件
npm install

# 設定環境變數 (請手動建立 .env 檔案)
# VITE_SUPABASE_URL=你的網址
# VITE_SUPABASE_ANON_KEY=你的金鑰
```

### 2. 本地開發模式 (極常用)
啟動 Vite 開發伺服器，支援即時預覽修改：
```bash
npm run dev
```

### 3. 專案建置與檢查
```bash
# 檢查程式碼型別並打包成生產環境檔案
npm run build

# 預覽建置後的結果 (確認 build 出來的東西沒問題)
npm run preview

# 執行 ESLint 程式碼格式檢查
npm run lint
```

---

## 📤 Git 提交與推送指令 (Git Push)

當你完成修改並想同步到 GitHub 或遠端倉庫時，請依序執行：

### 1. 查看變更狀態
確認哪些檔案被修改了：
```bash
git status
```

### 2. 加入變更 (Stage)
```bash
# 加入所有變更的檔案
git add .

# 或者只加入特定檔案
git add src/App.tsx
```

### 3. 提交變更 (Commit)
*註：請寫下簡短且清楚的更新說明*
```bash
git commit -m "feat: 新增記帳功能"
```

### 4. 推送到雲端
```bash
git push origin main
```

---

## 🛠️ Git 錯誤復原指令 (Git Recovery)

如果操作失誤或改錯程式碼，可以用以下指令救回：

### 1. 放棄「尚未提交」的所有修改 (救命用)
如果你改亂了但還沒 commit，想直接回到上次儲存的狀態（程式碼會被覆蓋）：
```bash
git checkout .
# 或者
git restore .
```

### 2. 取消「已暫存 (Staged)」但未提交的檔案
如果你執行了 `git add .` 但發現加錯了：
```bash
git reset .
```

### 3. 修改最後一次 commit 的內容或訊息
如果你剛 commit 完發現訊息打錯或少加了一個檔案：
```bash
git commit --amend -m "新的正確訊息"
```

### 4. 撤銷「已提交」但想退回前一步 (Reset)
如果你 commit 了但反悔了：
- **保留修改內容**（只是把 commit 取消，程式碼還在）：
  ```bash
  git reset --soft HEAD~1
  ```
- **完全刪除修改**（回到上一個 commit 的狀態，目前的修改會消失）：
  ```bash
  git reset --hard HEAD~1
  ```

---

## 📂 專案主要目錄結構
- `src/api/`: Supabase 客戶端與資料存取邏輯
- `src/components/`: 共用 UI 元件
- `src/features/`: 核心功能（如 Ledger, Stats）
- `src/pages/`: 頁面組件
- `src/utils/`: 財務運算 (decimal.js) 與工具函式
