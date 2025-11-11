// src/index.js
// ============================================================
// 🐾 寵兒共和國｜商品管理 API（D1 + R2）
// - Basic Auth（變更資料/管理路徑需要）
// - CORS（簡單可調整）
// - Products / Product Images CRUD（D1）
// - Public Image Gateway: https://image.wedo.pet/{SKU}/{filename} （R2）
// ============================================================

/**
 * 環境需求（wrangler.toml）：
 *  - d1_databases:  binding = "DATABASE"
 *  - r2_buckets:   binding = "R2_BUCKET"
 *  - vars:         ALLOWED_ORIGINS (optional), MAX_IMAGE_MB (optional)
 *  - secrets:      USERNAME, PASSWORD
 *  - （可選）Airtable：AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
 */

export default {
  fetch: (req, env, ctx) => router(req, env, ctx),
};

// -----------------------------
// 工具：回應包裝 / CORS / Auth
// -----------------------------

const json = (data, init = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });

const text = (data, init = {}) =>
  new Response(data, {
    status: init.status || 200,
    headers: { "content-type": "text/plain; charset=utf-8", ...init.headers },
  });

const notFound = () => json({ ok: false, error: "Not Found" }, { status: 404 });

const getOrigin = (req) => {
  try {
    return new URL(req.url).origin;
  } catch {
    return "*";
  }
};

const withCORS = (req, res, env) => {
  const reqOrigin = req.headers.get("Origin");
  const allowList = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin =
    allowList.includes("*") || !reqOrigin || allowList.includes(reqOrigin)
      ? reqOrigin || "*"
      : allowList[0] || "*";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };

  const resHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) resHeaders.set(k, v);
  return new Response(res.body, { ...res, headers: resHeaders, status: res.status });
};

const handlePreflight = (req, env) => {
  if (req.method !== "OPTIONS") return null;
  // 快速回應 CORS 預檢
  return withCORS(
    req,
    new Response(null, {
      status: 204,
      headers: { "content-length": "0" },
    }),
    env
  );
};

const basicAuthOk = (req, env) => {
  const h = req.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  try {
    const [user, pass] = atob(h.slice(6)).split(":");
    return user === env.USERNAME && pass === env.PASSWORD;
  } catch {
    return false;
  }
};

const requireAuth = (req, env) => {
  if (basicAuthOk(req, env)) return null;
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Restricted"' },
  });
};

const readJSON = async (req) => {
  try {
    const body = await req.text();
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("Invalid JSON");
  }
};

// -----------------------------
// Router
// -----------------------------

async function router(req, env, ctx) {
  const preflight = handlePreflight(req, env);
  if (preflight) return preflight;

  const url = new URL(req.url);
  const path = url.pathname;

  // Public image gateway: /{sku}/{filename}
  // e.g., https://image.wedo.pet/ABC123/main.jpg
  const imageMatch = path.match(/^\/([^/]+)\/([^/]+)$/);
  if (imageMatch && req.method === "GET") {
    const [, sku, filename] = imageMatch;
    return withCORS(req, await handleR2ImageGet(sku, filename, env), env);
  }

  // Home
  if (path === "/" && req.method === "GET") {
    return withCORS(
      req,
      json({
        ok: true,
        name: "Pet Republic API",
        routes: {
          public: [
            "GET   /                          -> this help",
            "GET   /{sku}/{filename}          -> public image (R2)",
            "GET   /api/products              -> list products (q, brand, category, status, page, size)",
            "GET   /api/products/:sku         -> get product by sku",
            "GET   /api/products/:sku/images  -> list images of product",
          ],
          protected_basic_auth: [
            "GET   /admin                      -> minimal admin home",
            "POST  /api/products               -> create",
            "PUT   /api/products/:sku          -> update",
            "DELETE /api/products/:sku         -> delete",
            "POST  /api/products/:sku/images   -> add image record",
            "DELETE /api/products/:sku/images/:filename -> delete image record",
            "POST  /api/upload/:sku            -> (todo) upload image to R2 (binary)",
            "POST  /sync-airtable              -> one-shot import (if Airtable configured)",
          ],
        },
      }),
      env
    );
  }

  // Admin (protected)
  if (path === "/admin") {
    const auth = requireAuth(req, env);
    if (auth) return auth;
    const origin = getOrigin(req);
    const html = `<!doctype html><meta charset="utf-8"/>
      <title>Pet Republic Admin</title>
      <style>body{font-family:ui-sans-serif,system-ui;padding:32px;max-width:960px;margin:auto;}</style>
      <h1>🐾 寵兒共和國：商品管理</h1>
      <p>這是最小版管理入口（Basic Auth 保護）。</p>
      <ul>
        <li><code>GET ${origin}/api/products</code> 檢視清單</li>
        <li><code>POST ${origin}/sync-airtable</code> Airtable 一次性匯入（若已設定）</li>
      </ul>`;
    return withCORS(
      req,
      new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      env
    );
  }

  // API: Products
  if (path === "/api/products" && req.method === "GET") {
    return withCORS(req, await listProducts(url, env), env);
  }
  if (path === "/api/products" && req.method === "POST") {
    const auth = requireAuth(req, env);
    if (auth) return auth;
    return withCORS(req, await createProduct(req, env), env);
  }

  const productSkuMatch = path.match(/^\/api\/products\/([^/]+)$/);
  if (productSkuMatch) {
    const sku = decodeURIComponent(productSkuMatch[1]);
    if (req.method === "GET") {
      return withCORS(req, await getProduct(sku, env), env);
    }
    if (req.method === "PUT") {
      const auth = requireAuth(req, env);
      if (auth) return auth;
      return withCORS(req, await updateProduct(req, sku, env), env);
    }
    if (req.method === "DELETE") {
      const auth = requireAuth(req, env);
      if (auth) return auth;
      return withCORS(req, await deleteProduct(sku, env), env);
    }
  }

  // API: Product Images
  const productImagesListMatch = path.match(/^\/api\/products\/([^/]+)\/images$/);
  if (productImagesListMatch) {
    const sku = decodeURIComponent(productImagesListMatch[1]);
    if (req.method === "GET") {
      return withCORS(req, await listImages(sku, env), env);
    }
    if (req.method === "POST") {
      const auth = requireAuth(req, env);
      if (auth) return auth;
      return withCORS(req, await addImageRecord(req, sku, env), env);
    }
  }

  const productImageDeleteMatch = path.match(
    /^\/api\/products\/([^/]+)\/images\/([^/]+)$/
  );
  if (productImageDeleteMatch && req.method === "DELETE") {
    const auth = requireAuth(req, env);
    if (auth) return auth;
    const sku = decodeURIComponent(productImageDeleteMatch[1]);
    const filename = decodeURIComponent(productImageDeleteMatch[2]);
    return withCORS(req, await deleteImageRecord(sku, filename, env), env);
  }

  // （可選）API: Upload Binary to R2（預留，若你要走 Worker 直傳）
  if (path.startsWith("/api/upload/") && req.method === "POST") {
    const auth = requireAuth(req, env);
    if (auth) return auth;
    const sku = decodeURIComponent(path.split("/").pop());
    return withCORS(req, await uploadToR2(req, sku, env), env);
  }

  // （可選）Airtable 一次性匯入（若你還需從 Airtable 轉移最後一次）
  if (path === "/sync-airtable" && req.method === "POST") {
    const auth = requireAuth(req, env);
    if (auth) return auth;
    return withCORS(req, await syncAirtable(env), env);
  }

  return withCORS(req, notFound(), env);
}

// -----------------------------
// D1: Products
// -----------------------------

async function listProducts(url, env) {
  const q = url.searchParams.get("q")?.trim() || "";
  const brand = url.searchParams.get("brand")?.trim() || "";
  const category = url.searchParams.get("category")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get("size") || "20", 10)));
  const offset = (page - 1) * size;

  const cond = [];
  const params = {};

  if (q) {
    cond.push("(sku LIKE $q OR name LIKE $q)");
    params["q"] = `%${q}%`;
  }
  if (brand) {
    cond.push("brand = $brand");
    params["brand"] = brand;
  }
  if (category) {
    cond.push("category = $category");
    params["category"] = category;
  }
  if (status) {
    cond.push("status = $status");
    params["status"] = status;
  }

  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  const sql = `
    SELECT id, sku, name, slug, brand, category, price, compare_at_price, status, stock, short_desc, created_at, updated_at
    FROM products
    ${where}
    ORDER BY created_at DESC
    LIMIT $limit OFFSET $offset
  `;
  params["limit"] = size;
  params["offset"] = offset;

  const countSql = `SELECT COUNT(*) AS total FROM products ${where}`;
  const { results } = await env.DATABASE.prepare(sql).bind(...bindNamed(params)).all();
  const countRes = await env.DATABASE.prepare(countSql).bind(...bindNamed(params)).first();
  const total = Number(countRes?.total || 0);

  return json({
    ok: true,
    page,
    size,
    total,
    items: results || [],
  });
}

async function getProduct(sku, env) {
  const row = await env.DATABASE
    .prepare(
      `SELECT id, sku, name, slug, brand, category, price, compare_at_price, status, stock,
              short_desc, description, specs, tags, created_at, updated_at
       FROM products WHERE sku = ?`
    )
    .bind(sku)
    .first();

  if (!row) return json({ ok: false, error: "Product not found" }, { status: 404 });
  return json({ ok: true, item: row });
}

async function createProduct(req, env) {
  let payload;
  try {
    payload = await readJSON(req);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  // 必填：sku, name；其他選填
  const required = ["sku", "name"];
  for (const k of required) {
    if (!payload[k]) return json({ ok: false, error: `Missing field: ${k}` }, { status: 400 });
  }

  const {
    sku,
    name,
    slug = null,
    brand = null,
    category = null,
    price = 0,
    compare_at_price = null,
    status = "active",
    stock = 0,
    short_desc = null,
    description = null,
    specs = null,
    tags = null,
  } = payload;

  try {
    await env.DATABASE
      .prepare(
        `INSERT INTO products
         (sku, name, slug, brand, category, price, compare_at_price, status, stock, short_desc, description, specs, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        sku,
        name,
        slug,
        brand,
        category,
        toInt(price),
        compare_at_price != null ? toInt(compare_at_price) : null,
        status,
        toInt(stock),
        short_desc,
        description,
        specs ? JSON.stringify(specs) : null,
        normalizeTags(tags)
      )
      .run();

    return json({ ok: true, sku });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, { status: 400 });
  }
}

async function updateProduct(req, sku, env) {
  let payload;
  try {
    payload = await readJSON(req);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  // 動態組 UPDATE
  const fields = [];
  const vals = [];
  const mapping = {
    name: "name",
    slug: "slug",
    brand: "brand",
    category: "category",
    price: "price",
    compare_at_price: "compare_at_price",
    status: "status",
    stock: "stock",
    short_desc: "short_desc",
    description: "description",
    specs: "specs",
    tags: "tags",
  };

  for (const [k, col] of Object.entries(mapping)) {
    if (k in payload) {
      let v = payload[k];
      if (k === "price" || k === "compare_at_price" || k === "stock") v = toInt(v);
      if (k === "specs" && v != null) v = JSON.stringify(v);
      if (k === "tags") v = normalizeTags(v);
      fields.push(`${col} = ?`);
      vals.push(v);
    }
  }

  if (!fields.length) {
    return json({ ok: false, error: "Nothing to update" }, { status: 400 });
  }

  try {
    await env.DATABASE
      .prepare(`UPDATE products SET ${fields.join(", ")} WHERE sku = ?`)
      .bind(...vals, sku)
      .run();

    return json({ ok: true, sku });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, { status: 400 });
  }
}

async function deleteProduct(sku, env) {
  const tx = env.DATABASE;
  try {
    await tx.prepare(`DELETE FROM product_images WHERE sku = ?`).bind(sku).run();
    await tx.prepare(`DELETE FROM products WHERE sku = ?`).bind(sku).run();
    return json({ ok: true, sku });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, { status: 400 });
  }
}

// -----------------------------
// D1: Product Images
// -----------------------------

async function listImages(sku, env) {
  const { results } = await env.DATABASE
    .prepare(
      `SELECT id, sku, filename, r2_key, alt, sort, created_at
       FROM product_images
       WHERE sku = ?
       ORDER BY sort ASC, id ASC`
    )
    .bind(sku)
    .all();

  return json({ ok: true, items: results || [] });
}

async function addImageRecord(req, sku, env) {
  let payload;
  try {
    payload = await readJSON(req);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const filename = payload.filename?.trim();
  if (!filename) return json({ ok: false, error: "Missing filename" }, { status: 400 });

  const r2_key = payload.r2_key || `${sku}/${filename}`;
  const alt = payload.alt || null;
  const sort = toInt(payload.sort || 0);

  try {
    await env.DATABASE
      .prepare(
        `INSERT INTO product_images (sku, filename, r2_key, alt, sort)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(sku, filename, r2_key, alt, sort)
      .run();

    return json({ ok: true, sku, filename, r2_key });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, { status: 400 });
  }
}

async function deleteImageRecord(sku, filename, env) {
  try {
    await env.DATABASE
      .prepare(`DELETE FROM product_images WHERE sku = ? AND filename = ?`)
      .bind(sku, filename)
      .run();

    // 注意：這裡只刪 D1 紀錄，不自動刪 R2 物件，避免誤刪
    return json({ ok: true, sku, filename });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, { status: 400 });
  }
}

// -----------------------------
// R2: Public Image Read
// -----------------------------

async function handleR2ImageGet(sku, filename, env) {
  const key = `${sku}/${filename}`;

  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return notFound();

  // 嘗試用副檔名判斷 content-type
  const type = guessMime(filename) || obj.httpMetadata?.contentType || "application/octet-stream";

  // Cache 控制：公網（CDN & 瀏覽器）
  const headers = new Headers();
  headers.set("content-type", type);
  headers.set("cache-control", "public, max-age=31536000, immutable"); // 1y
  // ETag / Last-Modified（交由 R2）
  if (obj.httpEtag) headers.set("etag", obj.httpEtag);
  if (obj.uploaded) headers.set("last-modified", new Date(obj.uploaded).toUTCString());

  return new Response(obj.body, { status: 200, headers });
}

// （可選）R2 上傳（直傳二進位）
// 期待 multipart/form-data; field: file
async function uploadToR2(req, sku, env) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data"))
      return json({ ok: false, error: "Expect multipart/form-data" }, { status: 400 });

    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string")
      return json({ ok: false, error: "Missing file" }, { status: 400 });

    const filename = form.get("filename") || file.name || "upload.bin";
    const key = `${sku}/${filename}`;

    const maxMB = parseInt(env.MAX_IMAGE_MB || "20", 10);
    if (file.size > maxMB * 1024 * 1024) {
      return json({ ok: false, error: `File too large (>${maxMB}MB)` }, { status: 413 });
    }

    await env.R2_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || guessMime(filename) || "application/octet-stream" },
    });

    return json({ ok: true, key, url: `/${key}` });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, { status: 400 });
  }
}

// -----------------------------
// Airtable Sync（可選）
// -----------------------------

async function syncAirtable(env) {
  const token = env.AIRTABLE_API_TOKEN;
  const base = env.AIRTABLE_BASE_ID;
  const table = env.AIRTABLE_TABLE_NAME;

  if (!token || !base || !table) {
    return json(
      {
        ok: false,
        error:
          "Airtable config missing. Set AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME to enable.",
      },
      { status: 501 }
    );
  }

  // 這裡保留為將來需要時的匯入流程（避免此刻阻塞）
  // 你未來可實作：分頁抓取 Airtable -> 轉換 -> 寫入 products & product_images
  return json({ ok: true, message: "Sync handler placeholder. Configure and implement if needed." });
}

// -----------------------------
// Helpers
// -----------------------------

function toInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.trunc(v) : 0;
}

function normalizeTags(tags) {
  if (tags == null) return null;
  if (Array.isArray(tags)) return tags.join(",");
  if (typeof tags === "object") return JSON.stringify(tags);
  return String(tags);
}

function bindNamed(named) {
  // Cloudflare D1 目前只支援位置參數，這裡將具名物件轉為陣列
  const order = Object.keys(named);
  return order.map((k) => named[k]);
}

function guessMime(filename = "") {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "heic":
      return "image/heic";
    case "bmp":
      return "image/bmp";
    default:
      return null;
  }
}
