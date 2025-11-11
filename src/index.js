/**
 * Pet Republic API (Cloudflare Worker)
 * - Public:
 *    GET  /                          -> help
 *    GET  /{sku}/{filename}          -> public image proxy from R2
 *    GET  /api/products              -> list products (q, brand, category, status, page, size)
 *    GET  /api/products/:sku         -> get product by sku
 *    GET  /api/products/:sku/images  -> list images of product
 *
 * - Protected (Basic Auth):
 *    GET  /admin                     -> minimal admin home (static file should be hosted separately)
 *    POST /api/products              -> create
 *    PUT  /api/products/:sku         -> update
 *    DELETE /api/products/:sku       -> delete
 *    POST /api/products/:sku/images  -> add image record
 *    DELETE /api/products/:sku/images/:filename -> delete image record
 *    POST /api/upload/:sku           -> (todo) upload binary to R2 then add image record
 *    GET|POST /sync-airtable         -> one-shot import from Airtable
 *
 *  Bindings:
 *    env.DATABASE  -> D1 (image-db)
 *    env.R2_BUCKET -> R2 (my-images-bucket)
 *    env.MAX_IMAGE_MB (string, default 20)
 *    env.USERNAME / env.PASSWORD (for Basic Auth)
 *    env.AIRTABLE_API_TOKEN / env.AIRTABLE_BASE_ID / env.AIRTABLE_TABLE_NAME
 */

export default {
  fetch: (req, env, ctx) => router(req, env, ctx),
};

// ---------- Helpers ----------
const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(reqMethod(obj)),
      ...extraHeaders,
    },
  });

const text = (body, status = 200, extraHeaders = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders(), ...extraHeaders },
  });

const html = (body, status = 200, extraHeaders = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders } });

const notFound = () => json({ ok: false, error: "Not Found" }, 404);

const contentTypeByName = (name = "") => {
  const ext = name.split(".").pop()?.toLowerCase();
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
    default:
      return "application/octet-stream";
  }
};

const corsHeaders = (method = "GET") => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  ...(method === "OPTIONS" ? { "access-control-max-age": "86400" } : {}),
});

// utility for json() CORS inference on OPTIONS (no-op fallback)
function reqMethod(obj) { return "GET"; }

// ---------- Auth ----------
function requiresAuth(req) {
  // return the pair {pass:boolean, user?:string}
  const hdr = req.headers.get("authorization");
  if (!hdr || !hdr.startsWith("Basic ")) return { pass: false };
  try {
    const decoded = atob(hdr.slice(6));
    const [user, pass] = decoded.split(":");
    return { pass: true, user, pass };
  } catch {
    return { pass: false };
  }
}

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Pet Republic Admin"', ...corsHeaders() },
  });
}

// ---------- Router ----------
async function router(req, env, ctx) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders("OPTIONS") });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // Root help
  if (req.method === "GET" && path === "/") {
    return json({
      ok: true,
      name: "Pet Republic API",
      routes: {
        public: [
          'GET  /                          -> this help',
          'GET  /{sku}/{filename}          -> public image (R2)',
          'GET  /api/products              -> list products (q, brand, category, status, page, size)',
          'GET  /api/products/:sku         -> get product by sku',
          'GET  /api/products/:sku/images  -> list images of product',
        ],
        protected_basic_auth: [
          'GET  /admin                                   -> minimal admin home',
          'POST /api/products                            -> create',
          'PUT  /api/products/:sku                       -> update',
          'DELETE /api/products/:sku                     -> delete',
          'POST /api/products/:sku/images                -> add image record',
          'DELETE /api/products/:sku/images/:filename    -> delete image record',
          'POST /api/upload/:sku                         -> (todo) upload image to R2 (binary)',
          'GET|POST /sync-airtable                       -> one-shot import (Airtable)',
        ],
      },
    });
  }

  // Public image proxy: /{sku}/{filename}
  {
    const m = path.match(/^\/([^\/]+)\/([^\/]+)$/);
    if (req.method === "GET" && m) {
      const sku = decodeURIComponent(m[1]);
      const filename = decodeURIComponent(m[2]);
      const key = `${sku}/${filename}`;
      try {
        const obj = await env.R2_BUCKET.get(key);
        if (!obj) return notFound();
        const headers = {
          "content-type": contentTypeByName(filename),
          "cache-control": "public, max-age=31536000, immutable",
        };
        return new Response(obj.body, { headers });
      } catch (e) {
        return json({ ok: false, error: e.message || "R2 Error" }, 500);
      }
    }
  }

  // Public APIs
  if (req.method === "GET" && path === "/api/products") {
    return listProducts(req, env);
  }
  if (req.method === "GET" && /^\/api\/products\/[^\/]+$/.test(path)) {
    const sku = decodeURIComponent(path.split("/").pop());
    return getProduct(sku, env);
  }
  if (req.method === "GET" && /^\/api\/products\/[^\/]+\/images$/.test(path)) {
    const sku = decodeURIComponent(path.split("/")[3]);
    return listImages(sku, env);
  }

  // Protected zone (Basic Auth)
  if (/^\/admin($|\/)/.test(path) ||
      path === "/sync-airtable" ||
      path.startsWith("/api/") && req.method !== "GET") {

    const { pass, user, pass: pw } = requiresAuth(req);
    if (!pass) return unauthorized();
    const ok = user === env.USERNAME && pw === env.PASSWORD;
    if (!ok) return unauthorized();
  }

  // minimal admin (提示而已；真正的後台頁建議放 Pages/存檔管理)
  if (req.method === "GET" && path === "/admin") {
    return html(`<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8"/>
<title>Pet Republic Admin (API)</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<body style="font-family:ui-sans-serif,system-ui;line-height:1.6;padding:24px">
  <h1>Pet Republic Admin</h1>
  <p>API 已啟用 Basic Auth。建議將「後台頁面」獨立為 <code>/admin/index.html</code> 靜態頁並呼叫本 API。</p>
  <ul>
    <li><a href="/sync-airtable">/sync-airtable</a>（觸發一次性 Airtable → D1 匯入）</li>
    <li><a href="/api/products">/api/products</a>（商品查詢）</li>
  </ul>
</body></html>`);
  }

  // CRUD — create/update/delete (簡化版本，欄位基本驗證)
  if (req.method === "POST" && path === "/api/products") {
    const body = await req.json().catch(() => ({}));
    if (!body.sku || !body.name) return json({ ok: false, error: "sku & name required" }, 400);
    await env.DATABASE
      .prepare(
        `INSERT INTO products (sku,name,brand,category,price,compare_at_price,status,stock,short_desc,description,specs,tags)
         VALUES (?1,?2,?3,?4,?5,?6,COALESCE(?7,'active'),COALESCE(?8,0),?9,?10,?11,?12)
         ON CONFLICT(sku) DO UPDATE SET
           name=excluded.name, brand=excluded.brand, category=excluded.category,
           price=excluded.price, compare_at_price=excluded.compare_at_price,
           status=excluded.status, stock=excluded.stock,
           short_desc=excluded.short_desc, description=excluded.description,
           specs=excluded.specs, tags=excluded.tags,
           updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      )
      .bind(
        body.sku, body.name, body.brand ?? null, body.category ?? null,
        body.price ?? 0, body.compare_at_price ?? null, body.status ?? "active",
        body.stock ?? 0, body.short_desc ?? null, body.description ?? null,
        body.specs ? JSON.stringify(body.specs) : null, Array.isArray(body.tags) ? body.tags.join(",") : body.tags ?? null
      )
      .run();
    return json({ ok: true });
  }

  if (req.method === "PUT" && /^\/api\/products\/[^\/]+$/.test(path)) {
    const sku = decodeURIComponent(path.split("/").pop());
    const body = await req.json().catch(() => ({}));
    const row = await env.DATABASE.prepare("SELECT id FROM products WHERE sku=?").bind(sku).first();
    if (!row) return json({ ok: false, error: "SKU not found" }, 404);

    await env.DATABASE
      .prepare(
        `UPDATE products SET
           name=COALESCE(?1,name),
           brand=COALESCE(?2,brand),
           category=COALESCE(?3,category),
           price=COALESCE(?4,price),
           compare_at_price=COALESCE(?5,compare_at_price),
           status=COALESCE(?6,status),
           stock=COALESCE(?7,stock),
           short_desc=COALESCE(?8,short_desc),
           description=COALESCE(?9,description),
           specs=COALESCE(?10,specs),
           tags=COALESCE(?11,tags),
           updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         WHERE sku=?12`
      )
      .bind(
        body.name ?? null, body.brand ?? null, body.category ?? null,
        body.price ?? null, body.compare_at_price ?? null, body.status ?? null,
        body.stock ?? null, body.short_desc ?? null, body.description ?? null,
        body.specs ? JSON.stringify(body.specs) : null,
        Array.isArray(body.tags) ? body.tags.join(",") : body.tags ?? null,
        sku
      )
      .run();
    return json({ ok: true });
  }

  if (req.method === "DELETE" && /^\/api\/products\/[^\/]+$/.test(path)) {
    const sku = decodeURIComponent(path.split("/").pop());
    await env.DATABASE.prepare("DELETE FROM product_images WHERE sku=?").bind(sku).run();
    await env.DATABASE.prepare("DELETE FROM products WHERE sku=?").bind(sku).run();
    // optional: 清 R2 目錄（需列舉刪除）
    return json({ ok: true });
  }

  // images record add / delete
  if (req.method === "POST" && /^\/api\/products\/[^\/]+\/images$/.test(path)) {
    const sku = decodeURIComponent(path.split("/")[3]);
    const b = await req.json().catch(() => ({}));
    if (!b.filename || !b.r2_key) return json({ ok: false, error: "filename & r2_key required" }, 400);
    await env.DATABASE
      .prepare("INSERT OR IGNORE INTO product_images (sku, filename, r2_key, alt, sort) VALUES (?,?,?,?,COALESCE(?5,0))")
      .bind(sku, b.filename, b.r2_key, b.alt ?? null, b.sort ?? 0)
      .run();
    return json({ ok: true });
  }

  if (req.method === "DELETE" && /^\/api\/products\/[^\/]+\/images\/[^\/]+$/.test(path)) {
    const [, , , sku, , filename] = path.split("/");
    await env.DATABASE.prepare("DELETE FROM product_images WHERE sku=? AND filename=?").bind(sku, filename).run();
    await env.R2_BUCKET.delete(`${sku}/${filename}`).catch(() => {});
    return json({ ok: true });
  }

  // (todo) binary upload endpoint
  if (req.method === "POST" && /^\/api\/upload\/[^\/]+$/.test(path)) {
    return json({ ok: false, error: "Not implemented in this build" }, 501);
  }

  // Airtable sync (GET/POST)
  if ((req.method === "GET" || req.method === "POST") && path === "/sync-airtable") {
    try {
      const result = await syncFromAirtable(env);
      return json(result);
    } catch (e) {
      return json({ ok: false, error: e.message || "sync error" }, 500);
    }
  }

  return notFound();
}

// ---------- Public handlers ----------
async function listProducts(req, env) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const brand = url.searchParams.get("brand");
  const category = url.searchParams.get("category");
  const status = url.searchParams.get("status") || "active";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const size = Math.min(60, Math.max(1, parseInt(url.searchParams.get("size") || "24")));
  const offset = (page - 1) * size;

  const where = [];
  const bind = [];

  if (status) {
    where.push("status = ?");
    bind.push(status);
  }
  if (q) {
    where.push("(sku LIKE ? OR name LIKE ? OR brand LIKE ? OR category LIKE ?)");
    bind.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (brand) {
    where.push("brand = ?");
    bind.push(brand);
  }
  if (category) {
    where.push("category = ?");
    bind.push(category);
  }

  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS n FROM products ${whereSQL}`
  ).bind(...bind).first();
  const total = totalRow?.n || 0;

  const rows = await env.DATABASE.prepare(
    `SELECT sku,name,brand,category,price,compare_at_price,status,stock,short_desc
       FROM products
       ${whereSQL}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`
  ).bind(...bind, size, offset).all();

  // facets
  const brandFacets = await env.DATABASE.prepare(
    `SELECT brand AS k, COUNT(*) AS n FROM products WHERE status='active' AND brand IS NOT NULL GROUP BY brand ORDER BY n DESC`
  ).all();
  const categoryFacets = await env.DATABASE.prepare(
    `SELECT category AS k, COUNT(*) AS n FROM products WHERE status='active' AND category IS NOT NULL GROUP BY category ORDER BY n DESC`
  ).all();

  // 首圖（若要加速可改 join）
  const skus = rows.results.map(r => r.sku);
  const firsts = {};
  if (skus.length) {
    const ph = skus.map(() => "?").join(",");
    const imgs = await env.DATABASE.prepare(
      `SELECT sku, filename FROM product_images WHERE sku IN (${ph}) ORDER BY sort ASC, id ASC`
    ).bind(...skus).all();
    for (const r of imgs.results) {
      if (!firsts[r.sku]) firsts[r.sku] = r.filename;
    }
  }

  const items = rows.results.map(r => ({
    ...r,
    price: Number(r.price) || 0,
    image: firsts[r.sku] ? `/${r.sku}/${firsts[r.sku]}` : null,
  }));

  return json({
    ok: true,
    page,
    size,
    total,
    pages: Math.ceil(total / size),
    items,
    facets: {
      brand: brandFacets.results.filter(x => !!x.k),
      category: categoryFacets.results.filter(x => !!x.k),
    },
  });
}

async function getProduct(sku, env) {
  const row = await env.DATABASE
    .prepare(`SELECT * FROM products WHERE sku=?`)
    .bind(sku)
    .first();
  if (!row) return json({ ok: false, error: "SKU not found" }, 404);

  // images
  const imgs = await env.DATABASE
    .prepare(`SELECT filename, r2_key, alt, sort FROM product_images WHERE sku=? ORDER BY sort ASC, id ASC`)
    .bind(sku)
    .all();

  return json({
    ok: true,
    product: {
      ...row,
      price: Number(row.price) || 0,
      specs: tryParseJSON(row.specs),
    },
    images: imgs.results.map(i => ({
      ...i,
      url: `/${sku}/${i.filename}`,
    })),
  });
}

async function listImages(sku, env) {
  const imgs = await env.DATABASE
    .prepare(`SELECT filename, r2_key, alt, sort FROM product_images WHERE sku=? ORDER BY sort ASC, id ASC`)
    .bind(sku)
    .all();
  return json({
    ok: true,
    items: imgs.results.map(i => ({ ...i, url: `/${sku}/${i.filename}` })),
  });
}

function tryParseJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- Airtable Sync ----------
async function syncFromAirtable(env) {
  const token = env.AIRTABLE_API_TOKEN;
  const base = env.AIRTABLE_BASE_ID;
  const table = env.AIRTABLE_TABLE_NAME;
  if (!token || !base || !table) {
    return { ok: false, error: "Missing Airtable credentials (AIRTABLE_API_TOKEN/BASE_ID/TABLE_NAME)" };
  }

  const pageSize = 100;
  let url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?pageSize=${pageSize}`;
  let offset;
  let count = 0;

  do {
    const res = await fetch(offset ? `${url}&offset=${offset}` : url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Airtable error ${res.status}: ${t}`);
    }
    const data = await res.json();
    if (!data.records) break;

    for (const r of data.records) {
      const f = r.fields || {};
      if (!f["商品貨號"]) continue;

      const sku = String(f["商品貨號"]).trim();
      const name = f["產品名稱"] || sku;
      const brand = f["品牌名稱"] || null;
      const category = f["類別"] || null;
      const status = truthy(f["現貨商品"]) ? "active" : "draft";
      const price = f["建議售價"] ? Math.round(Number(f["建議售價"]) * 100) : 0;

      const specs = {
        en_name: f["英文品名"] || "",
        material: f["成份/材質"] || "",
        size: f["商品尺寸"] || "",
        weight: f["重量g"] || "",
        origin: f["產地"] || "",
        pack: f["箱入數"] || "",
        ean: f["國際條碼"] || "",
      };

      const desc = f["商品介紹"] || "";
      const shortDesc = f["英文品名"] || null;

      // upsert product
      await env.DATABASE
        .prepare(
          `INSERT INTO products
             (sku,name,brand,category,price,status,short_desc,description,specs)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(sku) DO UPDATE SET
             name=excluded.name, brand=excluded.brand, category=excluded.category,
             price=excluded.price, status=excluded.status, short_desc=excluded.short_desc,
             description=excluded.description, specs=excluded.specs,
             updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        )
        .bind(sku, name, brand, category, price, status, shortDesc, desc, JSON.stringify(specs))
        .run();

      // images
      if (Array.isArray(f["商品圖檔"])) {
        let idx = 0;
        for (const asset of f["商品圖檔"]) {
          if (!asset?.url) continue;
          idx += 1;
          const filename = `${idx}.jpg`; // 以順序命名，可依實際檔名調整
          const r2key = `${sku}/${filename}`;

          // 若資料庫已存在就略過上傳
          const exists = await env.DATABASE
            .prepare(`SELECT 1 FROM product_images WHERE sku=? AND filename=?`)
            .bind(sku, filename)
            .first();
          if (!exists) {
            try {
              const resp = await fetch(asset.url);
              if (resp.ok) {
                await env.R2_BUCKET.put(r2key, await resp.arrayBuffer(), {
                  httpMetadata: { contentType: contentTypeByName(filename) },
                });
              }
            } catch (_) {}
            await env.DATABASE
              .prepare(`INSERT OR IGNORE INTO product_images (sku, filename, r2_key, sort) VALUES (?,?,?,?)`)
              .bind(sku, filename, r2key, idx - 1)
              .run();
          }
        }
      }

      count++;
    }

    offset = data.offset;
  } while (offset);

  return { ok: true, message: `Synced ${count} products from Airtable.` };
}

function truthy(v) {
  if (v === true) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return ["y", "yes", "true", "1", "是", "有", "現貨"].includes(s);
  }
  if (typeof v === "number") return v > 0;
  return false;
}
