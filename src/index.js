// src/index.js
// Pet Republic API (Cloudflare Workers + D1 + R2)
// - GET  /                         -> catalog html
// - GET  /admin                    -> admin html (Basic Auth)
// - GET  /{sku}/{filename}         -> public image from R2
// - GET  /api/products             -> list (q, brand, category, status, page, size)
// - GET  /api/products/:sku        -> single
// - GET  /api/products/:sku/images -> images by sku
// - POST /api/products             -> create   (Basic Auth)
// - PUT  /api/products/:sku        -> update   (Basic Auth)
// - DELETE /api/products/:sku      -> delete   (Basic Auth)
// - POST /api/products/:sku/images -> add image record  (Basic Auth)
// - DELETE /api/products/:sku/images/:filename -> delete image record (Basic Auth)
// - POST /sync-airtable            -> manual one-shot import trigger (Basic Auth, placeholder)

const JSON_OK = (obj = {}, init = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status: init,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const JSON_ERR = (msg = "Error", init = 400) =>
  JSON_OK({ ok: false, error: msg }, init);

const NOT_FOUND = () =>
  new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });

const TEXT = (html, init = 200) =>
  new Response(html, {
    status: init,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/* ----------------------- HTML Templates (escaped) ----------------------- */

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
    const url=it.thumb||(it.images&&it.images[0])||'';
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
  if((state.page*state.size)>=(data.total||0)) document.getElementById('next').setAttribute('disabled','');
  else document.getElementById('next').removeAttribute('disabled');
  // filters
  const box=document.getElementById('filters'); box.innerHTML='';
  const mk=(title, list, key)=>{
    const wrap=document.createElement('div');
    wrap.innerHTML='<div class="text-xs text-gray-500 mb-1">'+title+'</div>';
    const row=document.createElement('div'); row.className='flex flex-wrap gap-2';
    ['全部',...list].forEach(v=>{
      const b=document.createElement('button');
      b.className='px-3 py-1 rounded-full border text-sm '+((state[key]===v||(v==='全部'&&!state[key]))?'bg-gray-900 text-white':'bg-white');
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
<body class="bg-slate-50 text-slate-800">
<header class="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
  <div class="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
    <h1 class="text-xl font-bold">Pet Republic｜後台</h1>
    <a class="ml-auto px-3 py-2 rounded-lg border" href="/">回前台清單頁</a>
  </div>
</header>
<main class="max-w-4xl mx-auto p-4">
  <section class="bg-white rounded-2xl border shadow-sm p-6">
    <h2 class="font-semibold text-lg mb-2">Airtable 同步</h2>
    <p class="text-sm text-slate-500 mb-4">按下即可觸發一次匯入（僅管理員可用）。</p>
    <button id="btnSync" class="px-4 py-2 rounded-lg bg-indigo-600 text-white">開始同步</button>
    <pre id="out" class="mt-4 p-4 bg-slate-900 text-slate-100 rounded-xl overflow-auto text-sm">等待中…</pre>
  </section>
</main>
<script>
document.getElementById('btnSync').onclick=async()=>{
  const res=await fetch('/sync-airtable',{method:'POST'});
  const txt=await res.text();
  document.getElementById('out').textContent=txt;
};
</script>
`;

/* ----------------------- Auth Helpers ----------------------- */

function parseBasicAuth(req) {
  const h = req.headers.get("authorization") || "";
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(h);
  if (!m) return null;
  try {
    const [user, pass] = atob(m[1]).split(":", 2);
    return { user, pass };
  } catch {
    return null;
  }
}

function requireAuth(req, env) {
  const cred = parseBasicAuth(req);
  if (!cred || cred.user !== env.USERNAME || cred.pass !== env.PASSWORD) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="pet-republic-admin"' },
    });
  }
  return null;
}

/* ----------------------- SQL Helpers ----------------------- */

async function queryList(env, params) {
  const page = Math.max(1, Number(params.get("page") || 1));
  const size = Math.min(100, Math.max(1, Number(params.get("size") || 24)));
  const where = [];
  const args = [];

  const q = params.get("q");
  if (q) {
    where.push("(sku LIKE ? OR name LIKE ? OR brand LIKE ? OR category LIKE ?)");
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const brand = params.get("brand");
  if (brand) { where.push("brand = ?"); args.push(brand); }

  const category = params.get("category");
  if (category) { where.push("category = ?"); args.push(category); }

  const status = params.get("status");
  if (status) { where.push("status = ?"); args.push(status); }

  const cond = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const offset = (page - 1) * size;

  const totalRow = await env.DATABASE.prepare(`SELECT COUNT(*) as n FROM products ${cond}`).bind(...args).first();
  const total = totalRow?.n || 0;

  const items = await env.DATABASE.prepare(
    `SELECT sku, name, brand, category, status, price, thumb 
     FROM products ${cond}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...args, size, offset).all();

  const brands = await env.DATABASE.prepare(`SELECT brand, COUNT(*) n FROM products GROUP BY brand ORDER BY n DESC LIMIT 30`).all();
  const categories = await env.DATABASE.prepare(`SELECT category, COUNT(*) n FROM products GROUP BY category ORDER BY n DESC LIMIT 30`).all();

  // images for each item (first one only to speed up)
  const skus = (items?.results || []).map(r => r.sku);
  const imagesMap = {};
  if (skus.length) {
    const qs = skus.map(() => "?").join(",");
    const imgs = await env.DATABASE.prepare(
      `SELECT sku, url FROM product_images WHERE sku IN (${qs}) GROUP BY sku`
    ).bind(...skus).all();
    (imgs?.results || []).forEach(r => { imagesMap[r.sku] = r.url; });
  }

  const results = (items?.results || []).map(r => ({
    ...r,
    images: imagesMap[r.sku] ? [imagesMap[r.sku]] : [],
  }));

  return {
    ok: true,
    page, size, total,
    items: results,
    facets: {
      brands: (brands?.results || []).map(b => b.brand).filter(Boolean),
      categories: (categories?.results || []).map(c => c.category).filter(Boolean),
    },
  };
}

/* ----------------------- R2 Helpers ----------------------- */

async function r2Get(env, key) {
  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return NOT_FOUND();
  const headers = new Headers(obj.httpMetadata);
  if (!headers.get("content-type")) headers.set("content-type", "application/octet-stream");
  return new Response(obj.body, { headers });
}

/* ----------------------- Router ----------------------- */

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      const { pathname, searchParams } = url;

      // normalize: custom "/api" introspection
      if (pathname === "/api") {
        return JSON_OK({
          ok: true,
          name: "Pet Republic API",
          routes: {
            public: [
              'GET  /                -> catalog html',
              'GET  /{sku}/{filename} -> public image (R2)',
              'GET  /api/products    -> list products',
              'GET  /api/products/:sku -> get product',
              'GET  /api/products/:sku/images -> product images',
            ],
            protected_basic_auth: [
              'GET    /admin                           -> admin html',
              'POST   /api/products                    -> create',
              'PUT    /api/products/:sku               -> update',
              'DELETE /api/products/:sku               -> delete',
              'POST   /api/products/:sku/images        -> add image record',
              'DELETE /api/products/:sku/images/:name  -> delete image record',
              'POST   /sync-airtable                   -> trigger import (placeholder)',
            ],
          },
        });
      }

      // root: catalog page
      if (pathname === "/" || pathname === "/index.html") {
        return TEXT(HTML_CATALOG);
      }

      // admin (Basic Auth)
      if (pathname === "/admin") {
        const deny = requireAuth(req, env);
        if (deny) return deny;
        return TEXT(HTML_ADMIN);
      }

      // R2 public file: /:sku/:filename
      const mImg = /^\/([^\/]+)\/([^\/]+)$/.exec(pathname);
      if (mImg) {
        const key = `${mImg[1]}/${mImg[2]}`;
        return r2Get(env, key);
      }

      // API: list
      if (pathname === "/api/products" && req.method === "GET") {
        const data = await queryList(env, searchParams);
        return JSON_OK(data);
      }

      // API: single
      const mSku = /^\/api\/products\/([^\/]+)$/.exec(pathname);
      if (mSku && req.method === "GET") {
        const sku = decodeURIComponent(mSku[1]);
        const prod = await env.DATABASE.prepare(
          "SELECT sku, name, brand, category, status, price, thumb, description FROM products WHERE sku = ? LIMIT 1"
        ).bind(sku).first();
        if (!prod) return NOT_FOUND();
        const imgs = await env.DATABASE.prepare(
          "SELECT filename, url FROM product_images WHERE sku = ? ORDER BY sort, filename"
        ).bind(sku).all();
        return JSON_OK({ ok: true, product: prod, images: imgs?.results || [] });
      }

      // API: images of sku
      const mImgs = /^\/api\/products\/([^\/]+)\/images$/.exec(pathname);
      if (mImgs && req.method === "GET") {
        const sku = decodeURIComponent(mImgs[1]);
        const imgs = await env.DATABASE.prepare(
          "SELECT filename, url FROM product_images WHERE sku = ? ORDER BY sort, filename"
        ).bind(sku).all();
        return JSON_OK({ ok: true, items: imgs?.results || [] });
      }

      // ===== Protected (Basic Auth) =====
      if (pathname.startsWith("/api/") || pathname === "/sync-airtable") {
        const deny = requireAuth(req, env);
        if (deny) return deny;
      }

      // Create
      if (pathname === "/api/products" && req.method === "POST") {
        const b = await req.json();
        if (!b?.sku) return JSON_ERR("sku is required", 400);
        await env.DATABASE.prepare(
          `INSERT INTO products (sku, name, brand, category, status, price, thumb, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(b.sku, b.name || "", b.brand || "", b.category || "", b.status || "active",
          b.price || 0, b.thumb || "", b.description || "").run();
        return JSON_OK({ ok: true });
      }

      // Update
      if (mSku && req.method === "PUT") {
        const sku = decodeURIComponent(mSku[1]);
        const b = await req.json();
        await env.DATABASE.prepare(
          `UPDATE products SET name=?, brand=?, category=?, status=?, price=?, thumb=?, description=? WHERE sku=?`
        ).bind(b.name || "", b.brand || "", b.category || "", b.status || "active",
          b.price || 0, b.thumb || "", b.description || "", sku).run();
        return JSON_OK({ ok: true });
      }

      // Delete
      if (mSku && req.method === "DELETE") {
        const sku = decodeURIComponent(mSku[1]);
        await env.DATABASE.prepare("DELETE FROM product_images WHERE sku=?").bind(sku).run();
        await env.DATABASE.prepare("DELETE FROM products WHERE sku=?").bind(sku).run();
        return JSON_OK({ ok: true });
      }

      // Add image record
      if (mImgs && req.method === "POST") {
        const sku = decodeURIComponent(mImgs[1]);
        const b = await req.json();
        if (!b?.filename) return JSON_ERR("filename required", 400);
        // If you host on R2 at /sku/filename, you can build url here:
        const url = b.url || `https://${urlHost(req)}/${encodeURIComponent(sku)}/${encodeURIComponent(b.filename)}`;
        await env.DATABASE.prepare(
          `INSERT INTO product_images (sku, filename, url, sort)
           VALUES (?, ?, ?, ?)`
        ).bind(sku, b.filename, url, Number(b.sort || 0)).run();
        return JSON_OK({ ok: true });
      }

      // Delete image record
      const mDelImg = /^\/api\/products\/([^\/]+)\/images\/([^\/]+)$/.exec(pathname);
      if (mDelImg && req.method === "DELETE") {
        const sku = decodeURIComponent(mDelImg[1]);
        const filename = decodeURIComponent(mDelImg[2]);
        await env.DATABASE.prepare("DELETE FROM product_images WHERE sku=? AND filename=?")
          .bind(sku, filename).run();
        return JSON_OK({ ok: true });
      }

      // Manual Airtable sync (placeholder)
      if (pathname === "/sync-airtable" && req.method === "POST") {
        return JSON_OK({
          ok: true,
          message: "已接收同步請求。請留意 D1 儀表板查詢數與 logs（此示範版回覆成功，不執行真實抓取）。"
        });
      }

      return NOT_FOUND();
    } catch (err) {
      return JSON_ERR(String(err?.stack || err?.message || err), 500);
    }
  },
};

/* ----------------------- Utils ----------------------- */
function urlHost(req) {
  try { return new URL(req.url).host; } catch { return ""; }
}
