// src/index.js
/**
 * 🐾 寵兒共和國 API（Pet Republic API）
 * - Cloudflare Workers (D1 + R2)
 * - Airtable → D1 products，同步圖片到 R2
 * - Cron：每 10 分觸發
 */

export default {
  /**
   * HTTP 入口
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 預處理
    if (method === "OPTIONS") {
      return corsResponse(env);
    }

    try {
      // 公開健康檢查
      if (method === "GET" && path === "/health") {
        return withCORS(
          json({
            ok: true,
            service: "pet-republic-api",
            time: new Date().toISOString(),
            d1: !!env.DATABASE,
            r2: !!env.R2_BUCKET,
            maxImageMB: Number(env.MAX_IMAGE_MB || "20"),
          }),
          env
        );
      }

      // 統計（需 Basic Auth）
      if (method === "GET" && path === "/stats") {
        await requireAuth(request, env);
        const stats = await collectStats(env);
        return withCORS(json({ ok: true, ...stats }), env);
      }

      // Airtable 同步（需 Basic Auth）
      if (method === "POST" && path === "/sync-airtable") {
        await requireAuth(request, env);

        // 同步 Airtable → D1
        const imported = await importFromAirtable(env, {
          pageSize: 100,
          maxPages: 10, // 最多抓 1000 筆/次，避免打太兇
        });

        // 抓圖上傳 R2（僅處理待抓取 N）
        const imageLimit = 20;
        const imageReport = await fetchAndStoreImages(env, { limit: imageLimit });

        return withCORS(
          json({
            ok: true,
            imported,
            imageReport,
          }),
          env
        );
      }

      // 未匹配路由
      return withCORS(json({ ok: false, error: "Not Found" }, 404), env);
    } catch (err) {
      console.error("Unhandled error:", err);
      return withCORS(json({ ok: false, error: String(err?.message || err) }, 500), env);
    }
  },

  /**
   * Cron 入口（wrangler.toml 已設定 */10 * * * *）
   */
  async scheduled(event, env, ctx) {
    // 以防未設 Secrets 時造成報錯：若沒有 token/base/table 就跳過
    const hasAirtable =
      !!env.AIRTABLE_API_TOKEN && !!env.AIRTABLE_BASE_ID && !!env.AIRTABLE_TABLE_NAME;

    try {
      if (hasAirtable) {
        // ① Airtable → D1（溫和抓）
        await importFromAirtable(env, { pageSize: 100, maxPages: 3 });
      }

      // ② 抓圖到 R2（限制批量）
      await fetchAndStoreImages(env, { limit: 20 });
    } catch (err) {
      console.error("[CRON] error:", err);
    }
  },
};

/* ----------------------------- 工具函式區 ----------------------------- */

/**
 * 基本 JSON 回應
 */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 套用 CORS
 */
function withCORS(res, env) {
  const h = new Headers(res.headers);
  const origin = env.CORS_ALLOW_ORIGIN || "*";
  h.set("access-control-allow-origin", origin);
  h.set("access-control-allow-headers", "authorization, content-type, x-requested-with");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}

/**
 * 預檢回應
 */
function corsResponse(env) {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": env.CORS_ALLOW_ORIGIN || "*",
      "access-control-allow-headers": "authorization, content-type, x-requested-with",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-max-age": "600",
    },
  });
}

/**
 * Basic Auth（用於 /stats、/sync-airtable）
 */
async function requireAuth(request, env) {
  const hdr = request.headers.get("authorization") || "";
  if (!hdr.startsWith("Basic ")) {
    throwUnauthorized();
  }
  const creds = atob(hdr.slice(6));
  const [user, pass] = creds.split(":");
  if (!user || !pass) throwUnauthorized();

  // 允許使用 USERNAME/PASSWORD 或 BASIC_AUTH_USERNAME/BASIC_AUTH_PASSWORD
  const expectedUser = env.USERNAME || env.BASIC_AUTH_USERNAME;
  const expectedPass = env.PASSWORD || env.BASIC_AUTH_PASSWORD;

  if (!expectedUser || !expectedPass) {
    throw new Error("Auth not configured");
  }
  if (user !== expectedUser || pass !== expectedPass) {
    throwUnauthorized();
  }
}

function throwUnauthorized() {
  const res = new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="pet-republic-api"' },
  });
  throw res;
}

/**
 * 統計：總數/成功/失敗/待處理
 */
async function collectStats(env) {
  const db = env.DATABASE;
  const total = await db.prepare("SELECT COUNT(*) AS c FROM products").first();
  const waiting = await db
    .prepare("SELECT COUNT(*) AS c FROM products WHERE image_synced = 'N'")
    .first();
  const ok = await db
    .prepare("SELECT COUNT(*) AS c FROM products WHERE image_synced = 'T'")
    .first();
  const fail = await db
    .prepare("SELECT COUNT(*) AS c FROM products WHERE image_synced = 'F'")
    .first();

  return {
    total: Number(total?.c || 0),
    waiting: Number(waiting?.c || 0),
    success: Number(ok?.c || 0),
    failed: Number(fail?.c || 0),
  };
}

/**
 * Airtable → D1
 */
async function importFromAirtable(env, { pageSize = 100, maxPages = 10 } = {}) {
  const token = env.AIRTABLE_API_TOKEN;
  const base = env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(env.AIRTABLE_TABLE_NAME || "");
  if (!token || !base || !table) {
    return { ok: false, reason: "Airtable secrets not configured" };
  }

  const endpoint = (offset) =>
    `https://api.airtable.com/v0/${base}/${table}?pageSize=${pageSize}${
      offset ? `&offset=${offset}` : ""
    }`;

  let page = 0;
  let offset;
  let imported = 0;

  while (page < maxPages) {
    page++;
    const res = await fetch(endpoint(offset), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Airtable HTTP ${res.status}: ${txt}`);
    }
    const data = await res.json();

    const records = Array.isArray(data.records) ? data.records : [];
    if (records.length === 0) break;

    for (const rec of records) {
      const prepared = mapAirtableRecord(rec);
      if (!prepared.sku) continue; // 沒有 SKU 的不入庫

      // upsert into D1
      await upsertProduct(env.DATABASE, prepared);
      imported++;
    }

    offset = data.offset;
    if (!offset) break; // 沒有下一頁
  }

  return { ok: true, imported, pages: page };
}

/**
 * 將 Airtable record 映射成 products 欄位
 */
function mapAirtableRecord(rec) {
  const f = rec?.fields || {};

  const pick = (...keys) => {
    for (const k of keys) {
      if (f[k] !== undefined && f[k] !== null && String(f[k]).trim() !== "") return f[k];
    }
    return null;
  };

  // 圖片欄可能是 attachments 陣列
  const imageField = pick("圖片", "Image", "Images", "image", "images", "photo", "photos");
  let imageUrl = null;
  if (Array.isArray(imageField) && imageField.length > 0 && imageField[0]?.url) {
    imageUrl = imageField[0].url;
  } else if (typeof imageField === "string") {
    imageUrl = imageField;
  }

  const obj = {
    sku: String(pick("SKU", "Sku", "sku", "貨號", "編號") || "").trim(),
    title: pick("商品名稱", "中文名稱", "Title", "名稱", "title"),
    title_en: pick("英文名稱", "English Name", "title_en"),
    brand: pick("品牌", "Brand", "brand"),
    category: pick("類別", "Category", "category"),
    description: pick("商品描述", "描述", "說明", "description"),
    materials: pick("材質", "materials"),
    case_pack_size: pick("包裝規格", "箱入數", "case_pack_size"),
    msrp: pick("建議售價", "msrp", "MSRP"),
    barcode: pick("條碼", "barcode", "EAN", "UPC"),
    dimensions_cm: pick("尺寸(公分)", "尺寸_cm", "dimensions_cm"),
    weight_g: pick("重量(公克)", "重量_g", "weight_g"),
    origin: pick("產地", "origin"),
    in_stock: normalizeBoolean(pick("有庫存", "in_stock", "庫存")),
    airtable_image_url: imageUrl,
    // image_file: 由抓圖流程寫入
  };

  return obj;
}

function normalizeBoolean(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v > 0 ? 1 : 0;
  const s = String(v || "").trim().toLowerCase();
  if (!s) return 1; // 預設有貨
  return ["y", "yes", "true", "有", "1"].includes(s) ? 1 : 0;
}

/**
 * D1 upsert
 */
async function upsertProduct(db, p) {
  // 若已存在，保留 image_synced 狀態；僅當 airtable_image_url 有變才重置 N
  const row = await db
    .prepare("SELECT airtable_image_url, image_synced FROM products WHERE sku = ?")
    .bind(p.sku)
    .first();

  let imageSynced = row?.image_synced || "N";
  if (row && p.airtable_image_url && p.airtable_image_url !== row.airtable_image_url) {
    imageSynced = "N"; // 來源圖變了，重抓
  }

  await db
    .prepare(
      `
INSERT INTO products
(sku, title, title_en, brand, category, description, materials, image_file, airtable_image_url, case_pack_size, msrp, barcode, dimensions_cm, weight_g, origin, in_stock, image_synced, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(sku) DO UPDATE SET
  title = excluded.title,
  title_en = excluded.title_en,
  brand = excluded.brand,
  category = excluded.category,
  description = excluded.description,
  materials = excluded.materials,
  -- image_file 保留已有值，抓圖流程會寫入
  airtable_image_url = excluded.airtable_image_url,
  case_pack_size = excluded.case_pack_size,
  msrp = excluded.msrp,
  barcode = excluded.barcode,
  dimensions_cm = excluded.dimensions_cm,
  weight_g = excluded.weight_g,
  origin = excluded.origin,
  in_stock = excluded.in_stock,
  image_synced = ?,
  updated_at = CURRENT_TIMESTAMP
`
    )
    .bind(
      p.sku,
      p.title,
      p.title_en,
      p.brand,
      p.category,
      p.description,
      p.materials,
      null, // image_file 初始由抓圖流程覆寫
      p.airtable_image_url,
      p.case_pack_size,
      p.msrp,
      p.barcode,
      p.dimensions_cm,
      p.weight_g,
      p.origin,
      p.in_stock,
      imageSynced
    )
    .run();
}

/**
 * 下載圖片 → 上傳 R2 → 更新 D1
 */
async function fetchAndStoreImages(env, { limit = 20 } = {}) {
  const db = env.DATABASE;
  const r2 = env.R2_BUCKET;
  const maxMB = Number(env.MAX_IMAGE_MB || "20");
  const maxBytes = maxMB * 1024 * 1024;

  const rows = await db
    .prepare(
      `
SELECT sku, airtable_image_url
FROM products
WHERE image_synced = 'N'
  AND airtable_image_url IS NOT NULL
  AND TRIM(airtable_image_url) <> ''
LIMIT ?
`
    )
    .bind(limit)
    .all();

  const items = rows?.results || [];
  let ok = 0,
    fail = 0,
    skipped = 0;

  for (const it of items) {
    const { sku, airtable_image_url } = it;
    if (!isHttpUrl(airtable_image_url)) {
      await markImage(db, sku, "F");
      fail++;
      continue;
    }

    try {
      // 先 HEAD 看大小（不是所有來源都支援）
      let contentLength = 0;
      try {
        const head = await fetch(airtable_image_url, { method: "HEAD" });
        if (head.ok) {
          const len = head.headers.get("content-length");
          if (len) contentLength = Number(len);
          if (contentLength && contentLength > maxBytes) {
            await markImage(db, sku, "F", "TooLarge(HEAD)");
            fail++;
            continue;
          }
        }
      } catch {
        // ignore
      }

      // 下載
      const res = await fetch(airtable_image_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // 若 HEAD 無長度，就用 ArrayBuffer 驗大小
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        await markImage(db, sku, "F", "TooLarge(Buffer)");
        fail++;
        continue;
      }

      const type = guessContentType(res.headers.get("content-type"), airtable_image_url);
      const ext = extFromTypeOrUrl(type, airtable_image_url);
      const key = `products/${encodeFileName(sku)}${ext}`;

      // 上傳至 R2
      await r2.put(key, new Uint8Array(buf), {
        httpMetadata: { contentType: type || "application/octet-stream" },
      });

      // 更新 D1
      await db
        .prepare(
          `
UPDATE products
SET image_file = ?, image_synced = 'T', updated_at = CURRENT_TIMESTAMP
WHERE sku = ?
`
        )
        .bind(key, sku)
        .run();

      ok++;
    } catch (e) {
      console.error(`[image] ${sku} failed:`, e);
      await markImage(db, sku, "F", String(e?.message || e));
      fail++;
    }
  }

  return { total: items.length, ok, fail, skipped };
}

async function markImage(db, sku, status = "F", reason) {
  await db
    .prepare(
      `UPDATE products SET image_synced = ?, updated_at = CURRENT_TIMESTAMP WHERE sku = ?`
    )
    .bind(status, sku)
    .run();
  if (reason) {
    // 可選：你若想記錄錯誤原因，之後可加一個 image_error 欄位
    // 這裡先留註解避免打破結構
  }
}

function isHttpUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "http:" || x.protocol === "https:";
  } catch {
    return false;
  }
}

function guessContentType(headerType, url) {
  if (headerType && headerType.includes("/")) return headerType.toLowerCase();
  const u = String(url || "").toLowerCase();
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function extFromTypeOrUrl(type, url) {
  if (!type && url) {
    const u = url.toLowerCase();
    if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return ".jpg";
    if (u.endsWith(".png")) return ".png";
    if (u.endsWith(".webp")) return ".webp";
    if (u.endsWith(".gif")) return ".gif";
  }
  if (!type) return "";
  if (type.includes("jpeg")) return ".jpg";
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  if (type.includes("gif")) return ".gif";
  return "";
}

function encodeFileName(s) {
  // 移除不適合檔名的字元
  return String(s || "")
    .trim()
    .replace(/[^\p{L}\p{N}\-_\.]/gu, "_")
    .slice(0, 128);
}
