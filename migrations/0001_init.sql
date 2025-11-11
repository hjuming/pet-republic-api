-- ============================================================
-- 🐾 寵兒共和國｜D1 資料庫初始化結構
-- 檔案位置：migrations/0001_init.sql
-- 功能說明：
--   1️⃣ 建立商品主表 (products)
--   2️⃣ 建立圖片表 (product_images)
--   3️⃣ 建立必要索引與更新觸發器
-- ============================================================


-- ============================================================
-- 產品主表
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,                      -- 商品編號
  name TEXT NOT NULL,                            -- 商品名稱
  slug TEXT UNIQUE,                              -- SEO 友善網址別名
  brand TEXT,                                    -- 品牌名稱
  category TEXT,                                 -- 商品分類
  price INTEGER NOT NULL DEFAULT 0,              -- 售價（以整數分儲存，如 199 元 → 19900）
  compare_at_price INTEGER,                      -- 原價（選填）
  status TEXT NOT NULL DEFAULT 'active',         -- active | draft | archived
  stock INTEGER NOT NULL DEFAULT 0,              -- 庫存數量
  short_desc TEXT,                               -- 簡短描述（摘要）
  description TEXT,                              -- 詳細描述（HTML 或 Markdown）
  specs JSON,                                    -- 規格 JSON（例：{"重量":"200g","尺寸":"20cm"}）
  tags TEXT,                                     -- 標籤（以逗號分隔或 JSON 儲存）
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku);
CREATE INDEX IF NOT EXISTS idx_products_status ON products (status);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);


-- ============================================================
-- 圖片表
-- ============================================================
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,                             -- 關聯商品 SKU
  filename TEXT NOT NULL,                        -- 檔名（例：main.jpg / 1.webp）
  r2_key TEXT NOT NULL,                          -- R2 儲存鍵值（例：{sku}/{filename}）
  alt TEXT,                                      -- 圖片替代文字
  sort INTEGER NOT NULL DEFAULT 0,               -- 排序權重
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(sku, filename)
);

CREATE INDEX IF NOT EXISTS idx_images_sku ON product_images (sku);


-- ============================================================
-- 更新觸發器
-- ============================================================
CREATE TRIGGER IF NOT EXISTS trg_products_updated_at
AFTER UPDATE ON products
FOR EACH ROW
BEGIN
  UPDATE products
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id = OLD.id;
END;
