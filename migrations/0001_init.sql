-- 產品主表
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  brand TEXT,
  category TEXT,
  price INTEGER NOT NULL DEFAULT 0,           -- 以「整數分」儲存：NT$199 -> 19900
  compare_at_price INTEGER,                   -- 原價（選填）
  status TEXT NOT NULL DEFAULT 'active',      -- active | draft | archived
  stock INTEGER NOT NULL DEFAULT 0,
  short_desc TEXT,
  description TEXT,
  specs JSON,                                 -- 規格（JSON）
  tags TEXT,                                  -- 以逗號分隔或 JSON 皆可
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku);
CREATE INDEX IF NOT EXISTS idx_products_status ON products (status);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);

-- 圖片表
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  filename TEXT NOT NULL,                     -- 例：main.jpg / 1.webp
  r2_key TEXT NOT NULL,                       -- 例：{sku}/{filename}
  alt TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(sku, filename)
);

CREATE INDEX IF NOT EXISTS idx_images_sku ON product_images (sku);

-- 更新觸發器
CREATE TRIGGER IF NOT EXISTS trg_products_updated_at
AFTER UPDATE ON products
FOR EACH ROW
BEGIN
  UPDATE products SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = OLD.id;
END;
