/* V3: 
  - 
  - 
*/

-- 
DROP TABLE IF EXISTS product_images;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS _sync_log;       -- ✅ 
DROP TABLE IF EXISTS _schema_versions; -- ✅ 

-- 
CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT,
  brand TEXT,
  status TEXT,
  raw_json TEXT  
);

-- 
CREATE TABLE product_images (
  sku TEXT,
  filename TEXT,
  url TEXT,
  width INTEGER,
  height INTEGER,
  variant TEXT,
  PRIMARY KEY (sku, filename),
  FOREIGN KEY (sku) REFERENCES products(sku) ON DELETE CASCADE
);

-- 
CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand);
CREATE INDEX IF NOT EXISTS idx_products_status ON products (status);

-- 
-- 
CREATE TABLE _sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_start_time TEXT,
  sync_end_time TEXT,
  status TEXT, -- 'success' or 'error'
  message TEXT,
  records_fetched INTEGER,
  products_upserted INTEGER,
  images_upserted INTEGER
);

CREATE TABLE _schema_versions (
  id INTEGER PRIMARY KEY,
  version INTEGER,
  applied_at TEXT
);
INSERT INTO _schema_versions (id, version, applied_at) VALUES (1, 1, CURRENT_TIMESTAMP);
