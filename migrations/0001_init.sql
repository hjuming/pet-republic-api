-- ================================================
-- 🐾 寵兒共和國 D1 資料庫初始化腳本
-- File: migrations/0001_init.sql
-- 目的：建立產品主表與基本索引
-- ================================================

-- ===============================
-- 🧱 Table: products
-- ===============================
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,                -- 產品 SKU（唯一識別碼）
  title TEXT,                          -- 中文名稱
  title_en TEXT,                       -- 英文名稱
  brand TEXT,                          -- 品牌名稱
  category TEXT,                       -- 類別名稱
  description TEXT,                    -- 商品描述
  materials TEXT,                      -- 材質說明
  image_file TEXT,                     -- 上傳後檔名 (對應 R2 內路徑)
  airtable_image_url TEXT,             -- 來源 Airtable 圖片 URL
  case_pack_size TEXT,                 -- 包裝規格
  msrp TEXT,                           -- 建議售價
  barcode TEXT,                        -- 條碼
  dimensions_cm TEXT,                  -- 尺寸 (公分)
  weight_g TEXT,                       -- 重量 (公克)
  origin TEXT,                         -- 產地
  in_stock INTEGER DEFAULT 1,          -- 是否有庫存 (1=有, 0=無)
  image_synced TEXT DEFAULT 'N',       -- 圖片同步狀態 ('N'=未抓取, 'T'=成功, 'F'=失敗)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===============================
-- ⚡️ Indexes
-- ===============================
CREATE INDEX IF NOT EXISTS idx_products_synced 
  ON products (image_synced);

CREATE INDEX IF NOT EXISTS idx_products_airtable_url 
  ON products (airtable_image_url);

CREATE INDEX IF NOT EXISTS idx_products_brand 
  ON products (brand);

CREATE INDEX IF NOT EXISTS idx_products_category 
  ON products (category);

-- ===============================
-- ✅ 初始化紀錄表（可選，用於版本控制）
-- ===============================
CREATE TABLE IF NOT EXISTS migrations_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO migrations_log (filename)
VALUES ('0001_init.sql');
