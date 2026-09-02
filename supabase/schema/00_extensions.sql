-- ============================================================
-- 00_extensions — 必要的 Postgres 擴充套件
-- ============================================================

-- uuid_generate_v4()：trips.id 與 expenses.id 的預設值需要它
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
