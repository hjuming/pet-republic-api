// src/index.js
// Pet Republic API - Cloudflare Worker
// Bindings (Wrangler):
//  - D1:        binding=DATABASE
//  - R2:        binding=R2_BUCKET
//  - Vars:      MAX_IMAGE_MB (string, optional)
//  - Secrets:   USERNAME, PASSWORD, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME

const TEXT_HTML = { 'content-type': 'text/html; charset=utf-8' };
const JSON_HDR  = { 'content-type': 'application/json; charset=utf-8' };

// ---- tiny utils ----
const ok = (data = {}) => new Response(JSON.stringify({ ok: true, ...data }, null, 2), { headers: JSON_HDR });
const err = (msg = 'Error', code = 400) => new Response(JSON.stringify({ ok: false, error: msg }, null, 2), { status: code, headers: JSON_HDR });
const notFound = () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const parseJSON = async (req) => {
  try { return await req.json(); } catch { return null; }
};
const parseBasicAuth = (req) => {
  const h = req.headers.get('authorization') || '';
  if (!h.toLowerCase().startsWith('basic ')) return null;
  try {
    const txt = atob(h.slice(6));
    const i = txt.indexOf(':');
    if (i < 0) return null;
    return { user: txt.slice(0, i), pass: txt.slice(i + 1) };
  } catch { return null; }
};
const requireAuth = (env, req) => {
  const cred = parseBasicAuth(req);
  if (!cred) return false;
  return (cred.user === env.USERNAME && cred.pass === env.PASSWORD);
};
const qstr = (url) => Object.fromEntries(new URL(url).searchParams.entries());
const toBool = (v) => v === true || v === 'true' || v === '1' || v === 1;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// map Airtable fields -> DB columns
const FIELD_MAP = {
  '商品貨號': 'sku',
  '產品名稱': 'name',
  '英文品名': 'name_en',
  '品牌名稱': 'brand',
  '類別': 'category',
  '建議售價': 'msrp',
  '國際條碼': 'barcode',
  '箱入數': 'case_qty',
  '商品介紹': 'description',
  '成份/材質': 'materials',
  '商品尺寸': 'size',
  '重量g': 'weight_g',
  '產地': 'origin',
  '現貨商品': 'in_stock',
  '商品圖檔': 'images' // attachment(s)
};

// schema SQL (idempotent)
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT,
  name_en TEXT,
  brand TEXT,
  category TEXT,
  msrp REAL,
  barcode TEXT,
  case_qty INTEGER,
  description TEXT,
  materials TEXT,
  size TEXT,
  weight_g REAL,
  origin TEXT,
  in_stock INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  filename TEXT NOT NULL,
  url TEXT,                    -- public url (worker route)
  r2_key TEXT,                 -- ${sku}/${filename}
  width INTEGER,
  height INTEGER,
  mime TEXT,
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (sku, filename)
);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products (brand);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE INDEX IF NOT EXISTS idx_products_status ON products (status);
CREATE INDEX IF NOT EXISTS idx_images_sku ON images (sku);
`;

async function ensureSchema(env) {
  await env.DATABASE.exec(SCHEMA_SQL);
}

function buildLike(keyword) {
  const kw = `%${keyword.replace(/[%_]/g, s => '\\' + s)}%`;
  return { kw };
}

function first(arr, def = null) { return Array.isArray(arr) && arr.length ? arr[0] : def; }

// ---- HTML (輕量內建；你也有獨立 index.html / admin/index.html，兩者擇一即可) ----
const HTML_CATALOG = `<!doctype html><meta charset="utf-8"><title>Pet Republic｜商品清單</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="icon" href="https://i.urusai.cc/dLe5k.png">
<body class="bg-gray-50 text-gray-800">
<header class="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
  <div class="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
    <h1 class="text-xl font-bold">Pet Republic｜商品清單</h1>
    <input id="q" class="ml-auto border rounded-lg px-4 py-2 w-80" placeholder="輸入關鍵字或 SKU">
    <button id="btn" class="px-4 py-2 rounded-lg bg-teal-600 text-white">搜尋</button>
    <a class="px-4 py-2 rounded-lg bg-slate-100" href="/admin">後台</a>
  </div>
</header>
<main class="max-w-6xl mx-auto p-4 grid grid-cols-1 md:grid-cols-4 gap-6">
  <aside class="md:col-span-1 space-y-4">
    <div class="p-4 bg-white rounded-xl border shadow-sm">
      <h3 class="font-semibold mb-2">快速篩選</h3>
      <div id="filters" class="space-y-3"></div>
    </div>
  </aside>
  <section class="md:col-span-3">
    <div class="flex items-center gap-2 mb-4">
      <button id="toggle" class="px-3 py-2 rounded-lg border">切換：縮圖 / 列表</button>
      <button id="csv" class="px-3 py-2 rounded-lg bg-emerald-600 text-white">匯出選取 CSV</button>
      <button id="zip" class="px-3 py-2 rounded-lg bg-indigo-600 text-white">打包圖片 ZIP</button>
    </div>
    <div id="grid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"></div>
    <div class="mt-6 flex gap-3">
      <button id="prev" class="px-3 py-2 rounded-lg border">上一頁</button>
      <button id="next" class="px-3 py-2 rounded-lg border">下一頁</button>
    </div>
  </section>
</main>
<script>
const state={page:1,size:24,view:'grid',brand:'',category:'',status:''};
async function load(){
  const u=new URL('/api/products', location.origin);
  u.searchParams.set('page',state.page);
  u.searchParams.set('size',state.size);
  if(state.brand)u.searchParams.set('brand',state.brand);
  if(state.category)u.searchParams.set('category',state.category);
  if(state.status)u.searchParams.set('status',state.status);
  const q=document.getElementById('q').value.trim(); if(q)u.searchParams.set('q',q);
  const res=await fetch(u); const data=await res.json();
  const g=document.getElementById('grid'); g.innerHTML='';
  (data.items||[]).forEach(it=>{
    const url=it.thumb|| (it.images && it.images[0]) || '';
    const el=document.createElement('div');
    el.className='bg-white border rounded-xl overflow-hidden shadow';
    el.innerHTML=\`
      <div class="aspect-[1/1] bg-gray-100 flex items-center justify-center overflow-hidden">
        \${url?'<img src="'+url+'" class="w-full h-full object-cover">':'<span class="text-gray-400">No Image</span>'}
      </div>
      <div class="p-3 text-sm">
        <div class="font-semibold truncate" title="\${it.name||''}">\${it.name||'-'}</div>
        <div class="text-gray-500">SKU：\${it.sku}</div>
        <div class="text-gray-500">\${it.brand||''} · \${it.category||''}</div>
      </div>\`;
    g.appendChild(el);
  });
  if(state.page<=1) document.getElementById('prev').setAttribute('disabled','');
  else document.getElementById('prev').removeAttribute('disabled');
  if((state.page*state.size)>= (data.total||0)) document.getElementById('next').setAttribute('disabled','');
  else document.getElementById('next').removeAttribute('disabled');
  // filters (brand/category chips)
  const box=document.getElementById('filters'); box.innerHTML='';
  const mk=(title, list, key)=>{
    const wrap=document.createElement('div');
    wrap.innerHTML='<div class="text-xs text-gray-500 mb-1">'+title+'</div>';
    const row=document.createElement('div'); row.className='flex flex-wrap gap-2';
    ['全部',...list].forEach(v=>{
      const b=document.createElement('button');
      b.className='px-3 py-1 rounded-full border text-sm '+ ((state[key]===v || (v==='全部' && !state[key]))?'bg-gray-900 text-white':'bg-white');
      b.textContent=v;
      b.onclick=()=>{state[key]=(v==='全部'?'':v); state.page=1; load();};
      row.appendChild(b);
    });
    wrap.appendChild(row); box.appendChild(wrap);
  };
  mk('品牌', data.facets?.brands||[], 'brand');
  mk('類別', data.facets?.categories||[], 'category');
}
document.getElementById('btn').onclick=()=>{state.page=1;load();};
document.getElementById('prev').onclick=()=>{if(state.page>1){state.page--;load();}};
document.getElementById('next').onclick=()=>{state.page++;load();};
document.getElementById('toggle').onclick=()=>{state.view=state.view==='grid'?'list':'grid';load();};
window.addEventListener('DOMContentLoaded', load);
</script>
`;

const HTML_ADMIN = `<!doctype html><meta charset="utf-8"><title>Pet Republic｜後台</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<body class="bg-gray-50 text-gray-800">
<header class="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
  <div class="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
    <h1 class="text-xl font-bold">Pet Republic｜後台</h1>
    <a class="ml-auto px-3 py-2 rounded-lg border" href="/">回前台清單頁</a>
  </div>
</header>
<main class="max-w-3xl mx-auto p-4">
  <div class="p-5 bg-white rounded-xl border shadow-sm">
    <h2 class="text-lg font-semibold mb-2">Airtable 同步</h2>
    <p class="text-gray-500 mb-4">按下即可觸發一次匯入（僅管理員可用）。</p>
    <button id="sync" class="px-4 py-2 rounded-lg bg-indigo-600 text-white">開始同步</button>
    <pre id="out" class="mt-5 p-4 bg-slate-900 text-slate-100 rounded-lg overflow-auto text-sm">等待中…</pre>
  </div>
</main>
<script>
const out = document.getElementById('out');
document.getElementById('sync').onclick = async ()=>{
  out.textContent = '執行中…';
  const res = await fetch('/sync-airtable', { method:'POST' });
  const txt = await res.text();
  out.textContent = txt;
};
</script>
`;

// ---- R2 helpers ----
async function r2FetchToBucket(env, url, key) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Fetch image failed: ' + res.status);
  const ct = res.headers.get('content-type') || 'application/octet-stream';
  await env.R2_BUCKET.put(key, res.body, { httpMetadata: { contentType: ct } });
  return { mime: ct };
}

function publicImageURL(host, sku, filename) {
  const base = `https://${host}`;
  return `${base}/${encodeURIComponent(sku)}/${encodeURIComponent(filename)}`;
}

// ---- Airtable sync ----
async function syncAirtable(env, host) {
  const token = env.AIRTABLE_API_TOKEN;
  const baseId = env.AIRTABLE_BASE_ID;
  const table = env.AIRTABLE_TABLE_NAME;
  if (!token || !baseId || !table) return { imported: 0, images: 0, note: 'Airtable secrets not set' };

  const base = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`;
  let offset = '';
  let imported = 0, imageCount = 0;
  const seen = new Set();

  await ensureSchema(env);

  do {
    const url = new URL(base);
    if (offset) url.searchParams.set('offset', offset);
    url.searchParams.set('pageSize', '50');
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Airtable fetch failed: ' + res.status);
    const data = await res.json();

    for (const rec of (data.records || [])) {
      const f = rec.fields || {};
      const row = {};
      for (const [k, v] of Object.entries(FIELD_MAP)) {
        row[v] = f[k];
      }
      const sku = (row.sku || '').toString().trim();
      if (!sku) continue;

      seen.add(sku);

      // normalize
      const values = {
        sku,
        name: row.name || null,
        name_en: row.name_en || null,
        brand: row.brand || null,
        category: row.category || null,
        msrp: row.msrp ? Number(row.msrp) : null,
        barcode: row.barcode || null,
        case_qty: row.case_qty ? Number(row.case_qty) : null,
        description: row.description || null,
        materials: row.materials || null,
        size: row.size || null,
        weight_g: row.weight_g ? Number(row.weight_g) : null,
        origin: row.origin || null,
        in_stock: row.in_stock ? (toBool(row.in_stock) ? 1 : 0) : 0,
        status: 'active'
      };

      // upsert product
      await env.DATABASE.prepare(
        "INSERT INTO products (sku,name,name_en,brand,category,msrp,barcode,case_qty,description,materials,size,weight_g,origin,in_stock,status,updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
        "ON CONFLICT(sku) DO UPDATE SET name=excluded.name,name_en=excluded.name_en,brand=excluded.brand,category=excluded.category,msrp=excluded.msrp,barcode=excluded.barcode,case_qty=excluded.case_qty,description=excluded.description,materials=excluded.materials,size=excluded.size,weight_g=excluded.weight_g,origin=excluded.origin,in_stock=excluded.in_stock,status=excluded.status,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
      ).bind(
        values.sku, values.name, values.name_en, values.brand, values.category, values.msrp, values.barcode, values.case_qty,
        values.description, values.materials, values.size, values.weight_g, values.origin, values.in_stock, values.status
      ).run();

      imported++;

      // images (Airtable attachment)
      const attachments = Array.isArray(row.images) ? row.images : [];
      let pos = 0;
      for (const att of attachments) {
        const url = att.url || att.thumbnails?.large?.url || att.thumbnails?.full?.url;
        if (!url) continue;
        const fnameRaw = att.filename || url.split('/').pop().split('?')[0];
        // 防止奇怪字元
        const filename = fnameRaw.replace(/[^\w.\-]+/g, '_');
        const r2Key = `${sku}/${filename}`;

        // put into R2 (skip if exists)
        const head = await env.R2_BUCKET.head(r2Key);
        if (!head) {
          try {
            const meta = await r2FetchToBucket(env, url, r2Key);
            imageCount++;
            // be gentle to Airtable CDN
            await sleep(150);
          } catch (e) {
            // ignore single failure
          }
        }

        // upsert image record
        const publicUrl = publicImageURL(host, sku, filename);
        await env.DATABASE
          .prepare("INSERT INTO images (sku, filename, url, r2_key, position) VALUES (?,?,?,?,?) ON CONFLICT(sku,filename) DO UPDATE SET url=excluded.url, r2_key=excluded.r2_key, position=excluded.position")
          .bind(sku, filename, publicUrl, r2Key, pos++)
          .run();
      }
    }

    offset = data.offset || '';
  } while (offset);

  return { imported, images: imageCount };
}

// ---- API handlers ----
async function listProducts(env, url) {
  await ensureSchema(env);
  const qp = qstr(url);
  const page = Math.max(1, parseInt(qp.page || '1', 10));
  const size = Math.min(100, Math.max(1, parseInt(qp.size || '24', 10)));
  const offset = (page - 1) * size;
  const params = [];
  const where = [];

  if (qp.q) {
    const { kw } = buildLike(qp.q);
    where.push("(sku LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\' OR brand LIKE ? ESCAPE '\\\\' OR category LIKE ? ESCAPE '\\\\')");
    params.push(kw, kw, kw, kw);
  }
  if (qp.brand) {
    const arr = qp.brand.split(',').map(s => s.trim()).filter(Boolean);
    if (arr.length) {
      where.push('(' + arr.map(() => 'brand = ?').join(' OR ') + ')');
      params.push(...arr);
    }
  }
  if (qp.category) {
    const arr = qp.category.split(',').map(s => s.trim()).filter(Boolean);
    if (arr.length) {
      where.push('(' + arr.map(() => 'category = ?').join(' OR ') + ')');
      params.push(...arr);
    }
  }
  if (qp.status) {
    const arr = qp.status.split(',').map(s => s.trim()).filter(Boolean);
    if (arr.length) {
      where.push('(' + arr.map(() => 'status = ?').join(' OR ') + ')');
      params.push(...arr);
    }
  }

  const whereSQL = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const totalRow = await env.DATABASE.prepare(`SELECT COUNT(*) AS c FROM products ${whereSQL}`).bind(...params).first();
  const total = totalRow ? (totalRow.c || 0) : 0;

  const rows = await env.DATABASE.prepare(
    `SELECT sku,name,brand,category,msrp,status 
     FROM products ${whereSQL}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, size, offset).all();

  // thumbs + facets
  const items = [];
  const brands = new Set(), categories = new Set();
  for (const r of rows.results || []) {
    // thumb (first image)
    const img = await env.DATABASE.prepare("SELECT url FROM images WHERE sku=? ORDER BY position ASC, id ASC LIMIT 1").bind(r.sku).first();
    items.push({ ...r, thumb: img ? img.url : null });
    if (r.brand) brands.add(r.brand);
    if (r.category) categories.add(r.category);
  }

  return ok({ total, page, size, items, facets: { brands: [...brands], categories: [...categories] } });
}

async function getProduct(env, sku) {
  await ensureSchema(env);
  const row = await env.DATABASE.prepare("SELECT * FROM products WHERE sku=?").bind(sku).first();
  if (!row) return notFound();
  const imgs = await env.DATABASE.prepare("SELECT filename,url,position FROM images WHERE sku=? ORDER BY position ASC, id ASC").bind(sku).all();
  row.images = (imgs.results || []).map(x => x.url);
  return ok({ item: row });
}

async function listImages(env, sku) {
  await ensureSchema(env);
  const imgs = await env.DATABASE.prepare("SELECT filename,url,position FROM images WHERE sku=? ORDER BY position ASC, id ASC").bind(sku).all();
  return ok({ sku, images: (imgs.results || []) });
}

async function createProduct(env, data) {
  await ensureSchema(env);
  if (!data || !data.sku) return err('sku required', 400);
  await env.DATABASE.prepare(
    "INSERT INTO products (sku,name,brand,category,msrp,status) VALUES (?,?,?,?,?,?)"
  ).bind(data.sku, data.name||null, data.brand||null, data.category||null, data.msrp||null, data.status||'active').run();
  return ok({ message: 'created', sku: data.sku });
}
async function updateProduct(env, sku, data) {
  await ensureSchema(env);
  const fields = ['name','name_en','brand','category','msrp','barcode','case_qty','description','materials','size','weight_g','origin','in_stock','status'];
  const sets = [], params = [];
  for (const k of fields) {
    if (k in data) { sets.push(k + '=?'); params.push(data[k]); }
  }
  if (!sets.length) return err('no fields', 400);
  params.push(sku);
  await env.DATABASE.prepare(`UPDATE products SET ${sets.join(',')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sku=?`).bind(...params).run();
  return ok({ message: 'updated', sku });
}
async function deleteProduct(env, sku) {
  await ensureSchema(env);
  await env.DATABASE.prepare("UPDATE products SET status='archived', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sku=?").bind(sku).run();
  return ok({ message: 'archived', sku });
}

async function addImageRecord(env, sku, data, host) {
  await ensureSchema(env);
  if (!data || !data.filename) return err('filename required', 400);
  const filename = String(data.filename).replace(/[^\w.\-]+/g, '_');
  const r2Key = `${sku}/${filename}`;
  const url = publicImageURL(host, sku, filename);
  await env.DATABASE.prepare(
    "INSERT INTO images (sku,filename,url,r2_key,position) VALUES (?,?,?,?,?) ON CONFLICT(sku,filename) DO UPDATE SET url=excluded.url,r2_key=excluded.r2_key,position=excluded.position"
  ).bind(sku, filename, url, r2Key, data.position||0).run();
  return ok({ message: 'image recorded', url });
}
async function delImageRecord(env, sku, filename) {
  await ensureSchema(env);
  filename = filename.replace(/[^\w.\-]+/g, '_');
  const r2Key = `${sku}/${filename}`;
  await env.DATABASE.prepare("DELETE FROM images WHERE sku=? AND filename=?").bind(sku, filename).run();
  await env.R2_BUCKET.delete(r2Key);
  return ok({ message: 'image deleted', sku, filename });
}

// Public R2 read: GET /:sku/:filename
async function servePublicImage(env, sku, filename) {
  const key = `${sku}/${filename}`;
  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return notFound();
  const hdr = new Headers();
  obj.writeHttpMetadata(hdr);
  hdr.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers: hdr });
}

// ---- router ----
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    // help
    if (req.method === 'GET' && path === '/api') {
      return ok({
        name: 'Pet Republic API',
        routes: {
          public: [
            'GET  /                 -> catalog html',
            'GET  /{sku}/{filename} -> public image (R2)',
            'GET  /api/products     -> list products',
            'GET  /api/products/:sku -> get product',
            'GET  /api/products/:sku/images -> product images'
          ],
          protected_basic_auth: [
            'GET    /admin                         -> admin html',
            'POST   /api/products                  -> create',
            'PUT    /api/products/:sku             -> update',
            'DELETE /api/products/:sku             -> delete',
            'POST   /api/products/:sku/images      -> add image record',
            'DELETE /api/products/:sku/images/:fn  -> delete image record',
            'POST   /sync-airtable                 -> trigger import'
          ]
        }
      });
    }

    // index / admin
    if (req.method === 'GET' && path === '/') {
      return new Response(HTML_CATALOG, { headers: TEXT_HTML });
    }
    if (req.method === 'GET' && path === '/admin') {
      if (!requireAuth(env, req)) {
        return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="admin"' } });
      }
      return new Response(HTML_ADMIN, { headers: TEXT_HTML });
    }

    // Public API
    if (req.method === 'GET' && path === '/api/products') {
      return listProducts(env, req.url);
    }
    if (req.method === 'GET' && path.startsWith('/api/products/')) {
      const parts = path.split('/').filter(Boolean); // ['api','products',':sku', 'images?']
      const sku = decodeURIComponent(parts[2] || '');
      if (!sku) return notFound();
      if (parts.length === 4 && parts[3] === 'images') {
        return listImages(env, sku);
      }
      if (parts.length === 3) return getProduct(env, sku);
    }

    // Basic-auth protected
    const needAuth = (
      (req.method === 'POST' && (path === '/api/products' || path === '/sync-airtable' || path.startsWith('/api/products/'))) ||
      (req.method === 'PUT'  && path.startsWith('/api/products/')) ||
      (req.method === 'DELETE' && path.startsWith('/api/products/'))
    );
    if (needAuth && !requireAuth(env, req)) {
      return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="api"' } });
    }

    if (req.method === 'POST' && path === '/api/products') {
      const body = await parseJSON(req);
      return createProduct(env, body || {});
    }
    if (req.method === 'PUT' && path.startsWith('/api/products/')) {
      const parts = path.split('/').filter(Boolean);
      const sku = decodeURIComponent(parts[2] || '');
      const body = await parseJSON(req) || {};
      return updateProduct(env, sku, body);
    }
    if (req.method === 'DELETE' && path.startsWith('/api/products/')) {
      const parts = path.split('/').filter(Boolean);
      const sku = decodeURIComponent(parts[2] || '');
      if (parts.length === 5 && parts[3] === 'images') {
        const fn = decodeURIComponent(parts[4]);
        return delImageRecord(env, sku, fn);
      }
      return deleteProduct(env, sku);
    }
    if (req.method === 'POST' && path.startsWith('/api/products/')) {
      const parts = path.split('/').filter(Boolean);
      // /api/products/:sku/images
      if (parts.length === 4 && parts[3] === 'images') {
        const sku = decodeURIComponent(parts[2]);
        const body = await parseJSON(req) || {};
        const host = url.host;
        return addImageRecord(env, sku, body, host);
      }
    }

    // Sync Airtable
    if (req.method === 'POST' && path === '/sync-airtable') {
      const host = url.host;
      try {
        const res = await syncAirtable(env, host);
        return ok({ message: 'sync finished', ...res });
      } catch (e) {
        return err(String(e), 500);
      }
    }

    // Public image: /:sku/:filename
    if (req.method === 'GET') {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 2) {
        const [sku, filename] = parts.map(decodeURIComponent);
        return servePublicImage(env, sku, filename);
      }
    }

    return notFound();
  }
};
