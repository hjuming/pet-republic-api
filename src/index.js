// ======== 工具 ========
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const ALLOW_ORIGIN = "*"; // 前台取用 API

function ok(data, headers = {}) {
  return new Response(JSON.stringify(data), {
    headers: { ...JSON_HEADERS, "Access-Control-Allow-Origin": ALLOW_ORIGIN, ...headers },
  });
}
function bad(msg, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code,
    headers: { ...JSON_HEADERS, "Access-Control-Allow-Origin": ALLOW_ORIGIN },
  });
}
function notFound() { return bad("Not found", 404); }
function methodNotAllowed() { return bad("Method not allowed", 405); }

function requireBasicAuth(req, env) {
  const hdr = req.headers.get("Authorization") || "";
  if (!hdr.startsWith("Basic ")) return false;
  const [u, p] = atob(hdr.slice(6)).split(":");
  return u === env.USERNAME && p === env.PASSWORD;
}

function parseIntSafe(v, d = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function sanitizeFilename(name) {
  // 僅允許英數、.、-、_，避免目錄跳脫與奇異字元
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ======== 後台頁面（/admin） ========
function adminHtml() {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>寵兒共和國｜商品管理系統</title>
<meta name="robots" content="noindex,nofollow"/>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:system-ui,-apple-system,"Noto Sans TC","Microsoft JhengHei",sans-serif}</style>
</head>
<body class="bg-slate-50">
<div class="max-w-6xl mx-auto p-6">
  <header class="flex items-center justify-between mb-6">
    <h1 class="text-2xl font-bold">寵兒共和國｜商品管理</h1>
    <span class="text-sm text-slate-500">僅內部使用（Basic Auth）</span>
  </header>

  <section class="mb-6 rounded-xl bg-white shadow p-4 border">
    <h2 class="font-semibold mb-3">新增 / 更新商品</h2>
    <form id="prodForm" class="grid md:grid-cols-2 gap-4">
      <input required name="sku" placeholder="SKU（唯一）" class="border rounded p-2"/>
      <input required name="name" placeholder="商品名稱" class="border rounded p-2"/>
      <input name="brand" placeholder="品牌" class="border rounded p-2"/>
      <input name="category" placeholder="分類" class="border rounded p-2"/>
      <input name="price" placeholder="售價（NT$，自動轉分）" class="border rounded p-2" type="number" min="0"/>
      <input name="compare_at_price" placeholder="原價（NT$）" class="border rounded p-2" type="number" min="0"/>
      <input name="stock" placeholder="庫存數" class="border rounded p-2" type="number" min="0"/>
      <select name="status" class="border rounded p-2">
        <option value="active" selected>active</option>
        <option value="draft">draft</option>
        <option value="archived">archived</option>
      </select>
      <input name="tags" placeholder="標籤（逗號分隔）" class="border rounded p-2 md:col-span-2"/>
      <input name="slug" placeholder="Slug（選填，不填自動）" class="border rounded p-2 md:col-span-2"/>
      <textarea name="short_desc" placeholder="短描述" class="border rounded p-2 md:col-span-2"></textarea>
      <textarea name="description" placeholder="詳細描述（可用 Markdown）" class="border rounded p-2 md:col-span-2"></textarea>
      <textarea name="specs" placeholder='規格（JSON，例如：{"shape":"round"}）' class="border rounded p-2 md:col-span-2"></textarea>
      <div class="md:col-span-2 flex gap-2">
        <button class="px-4 py-2 rounded bg-teal-600 text-white" type="submit">儲存商品</button>
        <button id="delBtn" class="px-4 py-2 rounded bg-rose-600 text-white" type="button">刪除商品</button>
      </div>
    </form>
  </section>

  <section class="mb-6 rounded-xl bg-white shadow p-4 border">
    <h2 class="font-semibold mb-3">上傳商品圖片</h2>
    <form id="imgForm" class="flex flex-col md:flex-row gap-3 items-start">
      <input required name="sku" placeholder="SKU" class="border rounded p-2"/>
      <input name="filename" placeholder="檔名（例：main.jpg，留空沿用原檔名）" class="border rounded p-2"/>
      <input type="file" accept="image/*" name="file" class="border rounded p-2"/>
      <button class="px-4 py-2 rounded bg-indigo-600 text-white" type="submit">上傳</button>
    </form>
    <p class="text-sm text-slate-500 mt-2">R2 路徑：<code>https://image.wedo.pet/{SKU}/{filename}</code></p>
  </section>

  <section class="rounded-xl bg-white shadow p-4 border">
    <div class="flex items-center justify-between mb-3">
      <h2 class="font-semibold">商品列表</h2>
      <input id="q" placeholder="搜尋（SKU/名稱/品牌/分類）" class="border rounded p-2 w-64"/>
    </div>
    <div id="list" class="divide-y"></div>
    <div class="flex gap-2 mt-3">
      <button id="prev" class="px-3 py-1 rounded border">上一頁</button>
      <button id="next" class="px-3 py-1 rounded border">下一頁</button>
    </div>
  </section>
</div>

<script>
const auth = { headers: { } }; // Basic Auth 由瀏覽器自動帶（因為是受保護頁面）
let limit = 10, offset = 0;

async function reload() {
  const q = document.getElementById('q').value || '';
  const res = await fetch(\`/api/products?limit=\${limit}&offset=\${offset}&search=\${encodeURIComponent(q)}\`, auth);
  const data = await res.json();
  const list = document.getElementById('list');
  list.innerHTML = (data.items || []).map(p => \`
    <div class="py-2 flex items-start justify-between gap-4">
      <div>
        <div class="font-semibold">\${p.name} <span class="text-slate-500">(\${p.sku})</span></div>
        <div class="text-sm text-slate-500">\${p.brand || ''} · \${p.category || ''} · \$\${(p.price/100).toFixed(0)}</div>
        <div class="text-xs text-slate-400">status=\${p.status} · stock=\${p.stock}</div>
      </div>
      <button class="px-2 py-1 rounded border" onclick='fillForm(\${JSON.stringify(p)})'>載入</button>
    </div>\`).join('');
}

function fillForm(p){
  const f = document.getElementById('prodForm');
  for (const k of ['sku','name','brand','category','slug','short_desc','description','tags','status']) {
    if (f[k]) f[k].value = p[k] || '';
  }
  if (f.price) f.price.value = p.price ? Math.round(p.price/100) : '';
  if (f.compare_at_price) f.compare_at_price.value = p.compare_at_price ? Math.round(p.compare_at_price/100) : '';
  if (f.stock) f.stock.value = p.stock || 0;
  if (f.specs) f.specs.value = p.specs ? JSON.stringify(p.specs,null,2) : '';
}

document.getElementById('prev').onclick = ()=>{ offset = Math.max(0, offset - limit); reload(); };
document.getElementById('next').onclick = ()=>{ offset += limit; reload(); };
document.getElementById('q').oninput = ()=>{ offset=0; reload(); };

document.getElementById('prodForm').onsubmit = async (e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const sku = fd.get('sku').trim();
  const body = {};
  for (const [k,v] of fd.entries()) if (k!=='sku' && v!=='') body[k]=v;
  if (body.price) body.price = parseInt(body.price,10)*100;
  if (body.compare_at_price) body.compare_at_price = parseInt(body.compare_at_price,10)*100;
  if (body.stock) body.stock = parseInt(body.stock,10);
  if (body.specs) { try { body.specs = JSON.parse(body.specs); } catch{} }

  const exists = await fetch(\`/api/products/\${encodeURIComponent(sku)}\`);
  if (exists.ok) {
    await fetch(\`/api/products/\${encodeURIComponent(sku)}\`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  } else {
    await fetch('/api/products', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sku,...body})});
  }
  alert('已儲存'); reload();
};

document.getElementById('delBtn').onclick = async ()=>{
  const sku = document.querySelector('#prodForm [name=sku]').value.trim();
  if (!sku) return alert('請先填 SKU');
  if (!confirm(\`確定刪除 \${sku}？\`)) return;
  await fetch(\`/api/products/\${encodeURIComponent(sku)}\`, {method:'DELETE'});
  alert('已刪除'); reload();
};

document.getElementById('imgForm').onsubmit = async (e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  if (!fd.get('file') || !fd.get('sku')) return alert('請填 SKU 並選擇檔案');
  const res = await fetch(\`/api/products/\${encodeURIComponent(fd.get('sku'))}/images\`, { method:'POST', body: fd });
  const data = await res.json();
  if (data.ok) { alert('上傳完成'); } else { alert('上傳失敗：'+(data.error||'unknown')); }
};
reload();
</script>
</body></html>`;
}

// ======== API 實作 ========
async function listProducts(env, { search, limit = 10, offset = 0 }) {
  const _limit = parseIntSafe(limit, 10);
  const _offset = parseIntSafe(offset, 0);
  let where = [], params = [];
  if (search) {
    where.push("(sku LIKE ? OR name LIKE ? OR brand LIKE ? OR category LIKE ?)");
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = await env.DATABASE.prepare(`
    SELECT sku,name,slug,brand,category,price,compare_at_price,status,stock,short_desc,description,specs,tags,updated_at
    FROM products ${whereSql}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, _limit, _offset).all();

  const total = await env.DATABASE.prepare(`
    SELECT COUNT(*) AS n FROM products ${whereSql}
  `).bind(...params).first();

  // 轉型 JSON 欄位
  const rows = (items.results || []).map(r => ({ ...r, specs: r.specs ? JSON.parse(r.specs) : null }));
  return { ok: true, items: rows, total: total?.n ?? 0, limit: _limit, offset: _offset };
}

async function getProduct(env, sku) {
  const row = await env.DATABASE.prepare(`
    SELECT sku,name,slug,brand,category,price,compare_at_price,status,stock,short_desc,description,specs,tags,updated_at
    FROM products WHERE sku = ?
  `).bind(sku).first();
  if (!row) return null;
  row.specs = row.specs ? JSON.parse(row.specs) : null;
  const images = await env.DATABASE.prepare(`
    SELECT filename, r2_key, alt, sort FROM product_images WHERE sku = ? ORDER BY sort, id
  `).bind(sku).all();
  row.images = images.results || [];
  return row;
}

async function upsertProduct(env, data) {
  const sku = (data.sku || "").trim();
  if (!sku) throw new Error("缺少 sku");
  const exists = await env.DATABASE.prepare(`SELECT 1 FROM products WHERE sku=?`).bind(sku).first();
  const payload = {
    name: data.name || "",
    slug: data.slug || null,
    brand: data.brand || null,
    category: data.category || null,
    price: parseIntSafe(data.price, 0),
    compare_at_price: data.compare_at_price != null ? parseIntSafe(data.compare_at_price, null) : null,
    status: data.status || "active",
    stock: parseIntSafe(data.stock, 0),
    short_desc: data.short_desc || null,
    description: data.description || null,
    specs: data.specs ? JSON.stringify(data.specs) : null,
    tags: data.tags || null,
  };
  if (exists) {
    await env.DATABASE.prepare(`
      UPDATE products
      SET name=?, slug=?, brand=?, category=?, price=?, compare_at_price=?, status=?, stock=?, short_desc=?, description=?, specs=?, tags=?
      WHERE sku=?
    `).bind(payload.name, payload.slug, payload.brand, payload.category, payload.price, payload.compare_at_price, payload.status, payload.stock, payload.short_desc, payload.description, payload.specs, payload.tags, sku).run();
  } else {
    await env.DATABASE.prepare(`
      INSERT INTO products (sku,name,slug,brand,category,price,compare_at_price,status,stock,short_desc,description,specs,tags)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(sku, payload.name, payload.slug, payload.brand, payload.category, payload.price, payload.compare_at_price, payload.status, payload.stock, payload.short_desc, payload.description, payload.specs, payload.tags).run();
  }
  return sku;
}

async function deleteProduct(env, sku) {
  // 刪除 images 表，R2 是否同時清除交給前端或另設批次（這裡示範同步刪）
  const imgs = await env.DATABASE.prepare(`SELECT r2_key FROM product_images WHERE sku=?`).bind(sku).all();
  for (const r of (imgs.results||[])) {
    await env.R2_BUCKET.delete(r.r2_key);
  }
  await env.DATABASE.prepare(`DELETE FROM product_images WHERE sku=?`).bind(sku).run();
  await env.DATABASE.prepare(`DELETE FROM products WHERE sku=?`).bind(sku).run();
}

// 上傳圖片：multipart/form-data { file, filename? }
async function uploadImage(env, sku, formData) {
  const file = formData.get("file");
  if (!file || !file.name) throw new Error("缺少檔案");
  let filename = (formData.get("filename") || file.name).toString();
  filename = sanitizeFilename(filename);
  const key = `${sku}/${filename}`;

  // 檔案大小檢查
  const maxMB = parseInt(env.MAX_IMAGE_MB || "20", 10);
  if (file.size > maxMB * 1024 * 1024) throw new Error(`檔案過大（>${maxMB}MB）`);

  // 寫入 R2
  await env.R2_BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  // 寫入 DB（upsert）
  await env.DATABASE.prepare(`
    INSERT INTO product_images (sku,filename,r2_key) VALUES (?,?,?)
    ON CONFLICT(sku,filename) DO UPDATE SET r2_key=excluded.r2_key
  `).bind(sku, filename, key).run();

  return { filename, key, url: `https://image.wedo.pet/${encodeURIComponent(sku)}/${encodeURIComponent(filename)}` };
}

async function deleteImage(env, sku, filename) {
  filename = sanitizeFilename(filename);
  const key = `${sku}/${filename}`;
  await env.R2_BUCKET.delete(key);
  await env.DATABASE.prepare(`DELETE FROM product_images WHERE sku=? AND filename=?`).bind(sku, filename).run();
}

// ======== 入口 ========
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": ALLOW_ORIGIN,
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 後台頁（Basic Auth）
    if (pathname === "/admin") {
      if (!requireBasicAuth(req, env)) {
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="admin"' } });
      }
      return new Response(adminHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 健康檢查
    if (pathname === "/api/health") return ok({ ok: true, ts: Date.now() });

    // === 商品列表 ===
    if (pathname === "/api/products" && req.method === "GET") {
      const search = searchParams.get("search") || "";
      const limit = searchParams.get("limit") || "10";
      const offset = searchParams.get("offset") || "0";
      const data = await listProducts(env, { search, limit, offset });
      return ok(data);
    }

    // === 新增商品（後台） ===
    if (pathname === "/api/products" && req.method === "POST") {
      if (!requireBasicAuth(req, env)) return bad("Unauthorized", 401);
      const body = await req.json().catch(()=> ({}));
      try {
        const sku = await upsertProduct(env, body);
        const item = await getProduct(env, sku);
        return ok({ ok: true, item });
      } catch (e) { return bad(e.message || "invalid", 400); }
    }

    // /api/products/:sku
    const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch) {
      const sku = decodeURIComponent(productMatch[1]);
      if (req.method === "GET") {
        const item = await getProduct(env, sku);
        return item ? ok(item) : notFound();
      }
      if (req.method === "PUT") {
        if (!requireBasicAuth(req, env)) return bad("Unauthorized", 401);
        const body = await req.json().catch(()=> ({}));
        try {
          await upsertProduct(env, { ...body, sku });
          const item = await getProduct(env, sku);
          return ok({ ok: true, item });
        } catch (e) { return bad(e.message || "invalid", 400); }
      }
      if (req.method === "DELETE") {
        if (!requireBasicAuth(req, env)) return bad("Unauthorized", 401);
        await deleteProduct(env, sku);
        return ok({ ok: true });
      }
      return methodNotAllowed();
    }

    // /api/products/:sku/images（POST 上傳）
    const imgUploadMatch = pathname.match(/^\/api\/products\/([^/]+)\/images$/);
    if (imgUploadMatch) {
      const sku = decodeURIComponent(imgUploadMatch[1]);
      if (req.method !== "POST") return methodNotAllowed();
      if (!requireBasicAuth(req, env)) return bad("Unauthorized", 401);
      const form = await req.formData();
      try {
        const out = await uploadImage(env, sku, form);
        return ok({ ok: true, ...out });
      } catch (e) { return bad(e.message || "upload failed", 400); }
    }

    // /api/products/:sku/images/:filename（DELETE）
    const imgDelMatch = pathname.match(/^\/api\/products\/([^/]+)\/images\/([^/]+)$/);
    if (imgDelMatch) {
      const sku = decodeURIComponent(imgDelMatch[1]);
      const filename = decodeURIComponent(imgDelMatch[2]);
      if (req.method !== "DELETE") return methodNotAllowed();
      if (!requireBasicAuth(req, env)) return bad("Unauthorized", 401);
      await deleteImage(env, sku, filename);
      return ok({ ok: true });
    }

    return notFound();
  },
};
