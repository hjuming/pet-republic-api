/**
 * * @param {object} env - Worker 
 */
async function syncAirtable(env) {
  const startTime = Date.now();
  console.log(`[syncAirtable] 開始執行同步... (Base: ${env.AIRTABLE_BASE_ID}, Table: ${env.AIRTABLE_TABLE_NAME})`);

  let allRecords = [];
  let offset = null;
  const airtableUrl = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_NAME}`);
  
  airtableUrl.searchParams.set('pageSize', 100);
  // 

  try {
    // 使用 offset 迭代抓取所有頁面
    while (true) {
      if (offset) {
        airtableUrl.searchParams.set('offset', offset);
      }
      
      const res = await fetch(airtableUrl.href, {
        headers: { 'Authorization': `Bearer ${env.AIRTABLE_API_TOKEN}` },
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Airtable API 錯誤: ${res.status} ${res.statusText} - ${errorText}`);
      }

      const data = await res.json();
      allRecords.push(...data.records);
      offset = data.offset;
      if (!offset) break;
    }

    const items = allRecords.map((r) => {
      const f = r.fields || {};
      return {
        id: r.id,
        sku: String(f.SKU || ''),
        name: String(f.Name || f.Title || ''),
        brand: String(f.Brand || ''),
        price: Number(f.Price || 0),
        images: (f.Images || []).map(img => (typeof img === 'string' ? img : (img.url || ''))).filter(Boolean),
        updatedAt: r?.createdTime || null
      };
    });

    console.log(`[syncAirtable] 完成抓取 ${items.length} 筆。`);
    return { ok: true, count: items.length, items, durationMs: Date.now() - startTime };
  } catch (err) {
    console.error('[syncAirtable] 失敗：', err);
    return { ok: false, error: String(err), durationMs: Date.now() - startTime };
  }
}

/** D1 helpers */
function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}
const notAllowed = () => text('Method Not Allowed', 405, { 'allow': 'GET, POST' });

/**
 * 初始化資料表（若不存在）
 */
async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT,
      name TEXT,
      brand TEXT,
      price REAL,
      images TEXT,     -- JSON array
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
  `);
}

/**
 * 批次 upsert
 */
async function upsertProducts(db, items) {
  const placeholders = items.map(() => `(?, ?, ?, ?, ?, ?, ?)`).join(',');
  const params = [];
  for (const it of items) {
    params.push(
      it.id,
      it.sku,
      it.name,
      it.brand,
      it.price,
      JSON.stringify(it.images || []),
      it.updatedAt || null
    );
  }

  // 先刪後插 或 用 INSERT OR REPLACE
  const sql = `
    BEGIN TRANSACTION;
    ${items.map((_) => `INSERT OR REPLACE INTO products (id, sku, name, brand, price, images, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?);`).join('\n')}
    COMMIT;
  `;
  await db.exec({ sql, params });
}

/** 查詢 */
async function queryProducts(db, { q = '', brand = '', limit = 50, offset = 0 }) {
  const params = [];
  let where = '1=1';
  if (q) {
    where += ' AND (sku LIKE ? OR name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (brand) {
    where += ' AND brand = ?';
    params.push(brand);
  }
  const sql = `
    SELECT id, sku, name, brand, price, images, updatedAt
    FROM products
    WHERE ${where}
    ORDER BY updatedAt DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const { results } = await db.prepare(sql).bind(...params).all();
  return results.map(r => ({
    ...r,
    images: (() => { try { return JSON.parse(r.images || '[]'); } catch { return []; } })()
  }));
}

/** 工具 */
function withCors(req, res, allowed = '*') {
  const headers = new Headers(res.headers);
  headers.set('access-control-allow-origin', allowed);
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type,authorization');
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  return new Response(res.body, { status: res.status, headers });
}

/** 產生隨機測試資料 */
function seedItems(n = 10) {
  const arr = [];
  for (let i = 1; i <= n; i++) {
    arr.push({
      id: `seed_${i}`,
      sku: `SKU-${String(i).padStart(4, '0')}`,
      name: `示範商品 ${i}`,
      brand: i % 2 ? 'CatBrand' : 'DogBrand',
      price: Math.round(Math.random() * 1000) / 10,
      images: [],
      updatedAt: new Date().toISOString()
    });
  }
  return arr;
}

export default {
  /**
   * 
   * @param {Request} request 
   * @param {*} env 
   * @param {*} ctx 
   * @returns 
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    const corsAllowed = '*';
    const wrap = (res) => withCors(request, res, corsAllowed);

    try {
      // 路由
      if (path === '/' && method === 'GET') {
        return wrap(html(`
          <!doctype html>
          <meta charset="utf-8"/>
          <title>Pet Republic API</title>
          <style>
            body{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;padding:24px;line-height:1.7}
            a{color:#2563eb;text-decoration:none}
            code{background:#f3f4f6;padding:.2rem .4rem;border-radius:.375rem}
            .card{border:1px solid #e5e7eb;border-radius:.75rem;padding:1rem;margin-bottom:1rem}
          </style>
          <h1>Pet Republic API</h1>
          <p>狀態良好。請使用以下端點：</p>
          <div class="card">
            <ul>
              <li><code>GET /admin</code>：後台 HTML</li>
              <li><code>GET /catalog</code>：商品清單 HTML</li>
              <li><code>POST /sync-airtable</code>：執行 Airtable 同步並寫入 D1</li>
              <li><code>GET /api/products?q=關鍵字&brand=品牌&limit=50&offset=0</code>：查詢商品</li>
              <li><code>GET /api/debug/counts</code>：資料表狀態</li>
            </ul>
          </div>
        `));
      }

      if (path === '/admin' && method === 'GET') {
        return wrap(html(ADMIN_HTML));
      }

      if (path === '/catalog' && method === 'GET') {
        return wrap(html(CATALOG_HTML));
      }

      if (path === '/sync-airtable') {
        if (method !== 'POST') return wrap(notAllowed());

        const db = env.DATABASE;
        await ensureSchema(db);

        // 先從 Airtable 取資料
        const result = await syncAirtable(env);
        if (!result.ok) {
          return wrap(json(result, 500));
        }

        // 寫入 D1
        await upsertProducts(db, result.items);
        return wrap(json({ ok: true, wrote: result.items.length }));
      }

      if (path === '/api/products' && method === 'GET') {
        const db = env.DATABASE;
        const q = url.searchParams.get('q') || '';
        const brand = url.searchParams.get('brand') || '';
        const limit = Number(url.searchParams.get('limit') || 50);
        const offset = Number(url.searchParams.get('offset') || 0);

        const rows = await queryProducts(db, { q, brand, limit, offset });
        return wrap(json({ ok: true, count: rows.length, items: rows }));
      }

      if (path === '/api/debug/counts' && method === 'GET') {
        const db = env.DATABASE;
        await ensureSchema(db);
        const { results } = await db.prepare('SELECT COUNT(*) AS c FROM products').all();
        const c = results?.[0]?.c ?? 0;
        return wrap(json({ ok: true, tables: 1, products: c, images: 0 }));
      }

      // 內部健康檢查
      if (path === '/api/health' && method === 'GET') {
        return wrap(json({ ok: true, time: new Date().toISOString() }));
      }

      // demo: 種子資料
      if (path === '/api/seed' && method === 'POST') {
        const db = env.DATABASE;
        await ensureSchema(db);
        const items = seedItems(15);
        await upsertProducts(db, items);
        return wrap(json({ ok: true, seeded: items.length }));
      }

      // 兜底
      if (method === 'GET' || method === 'HEAD') {
        // 
        if (path.startsWith('/assets/')) {
          return text('Not Found', 404);
        }
      }

      return text("Not Found", 404);
    } catch (err) {
      return new Response(`Internal Error: ${String(err)}`, { status: 500 });
    }
  },
};

// --- HTML 
const ADMIN_HTML = `
<!doctype html><meta charset="utf-8">
<title>Pet Republic｜後台</title>
<style>
  body{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;margin:2rem;}
  pre{background:#0f172a;color:#e2e8f0;padding:1rem;border-radius:.75rem;overflow:auto}
  button{font-size:16px;padding:.75rem 1.25rem;border-radius:.75rem;background:#4f46e5;color:#fff;border:0}
</style>
<h1>Pet Republic｜後台</h1>
<section>
  <h2>Airtable 同步</h2>
  <button id="btn">開始同步</button>
  <pre id="out"></pre>
</section>
<script>
  const $ = (id) => document.getElementById(id);
  $("btn").onclick = async () => {
    $("btn").disabled = true;
    $("out").textContent = "執行中...";
    try {
      const res = await fetch("/sync-airtable", { method: "POST" });
      const data = await res.json();
      $("out").textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      $("out").textContent = "錯誤: " + e.message;
    } finally {
      $("btn").disabled = false;
    }
  }
</script>`;

// ✅ 
// 
const CATALOG_HTML = `
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Pet Republic｜商品清單</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800">
<header class="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
  <div class="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
    <h1 class="text-2xl font-extrabold">Pet Republic｜商品清單</h1>
    <div class="flex-1"></div>
    <input id="q" placeholder="輸入關鍵字或 SKU" class="w-80 max-w-[60vw] rounded-lg border px-4 py-2" />
    <button id="btnSearch" class="ml-2 rounded-lg bg-teal-600 text-white px-4 py-2 hover:bg-teal-700">搜尋</button>
    <a href="/admin" class="ml-3 rounded-lg bg-gray-800 text-white px-4 py-2 hover:bg-black">後台</a>
  </div>
</header>

<main class="max-w-6xl mx-auto px-4 py-6">
  <div class="mb-3 flex flex-wrap gap-3 items-center">
    <button id="btnToggle" class="rounded-lg border px-4 py-2">切換：縮圖 / 列表</button>
    <button id="btnExport" class="rounded-lg bg-green-700 text-white px-4 py-2">匯出選取 CSV</button>
    <button id="btnZip" class="rounded-lg bg-indigo-700 text-white px-4 py-2">打包圖片（預留）</button>
  </div>

  <div id="grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"></div>
  <div id="list" class="hidden divide-y border rounded-xl bg-white"></div>
</main>

<script>
const $ = (id) => document.getElementById(id);
const state = { view: 'grid', items: [], filtered: [], selected: new Set() };

function render() {
  if (state.view === 'grid') {
    $("list").classList.add('hidden');
    $("grid").classList.remove('hidden');
    $("grid").innerHTML = state.filtered.map(item => `
      <div class="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div class="aspect-video bg-gray-100 flex items-center justify-center">
          ${(item.images?.[0]) ? `<img src="${item.images[0]}" class="w-full h-full object-cover">` : `<div class="text-gray-400">No Image</div>`}
        </div>
        <div class="p-3">
          <div class="flex items-center justify-between gap-3">
            <label class="inline-flex items-center gap-2">
              <input type="checkbox" data-id="${item.id}" ${state.selected.has(item.id) ? 'checked' : ''} class="w-4 h-4">
              <span class="text-sm text-gray-500">${item.sku || '-'}</span>
            </label>
            <span class="text-teal-700 font-semibold">$ ${Number(item.price||0).toFixed(2)}</span>
          </div>
          <div class="font-bold mt-1">${item.name||''}</div>
          <div class="text-xs text-gray-500">${item.brand||''}</div>
        </div>
      </div>
    `).join('');
    // 勾選
    $("grid").querySelectorAll('input[type=checkbox]').forEach(chk => {
      chk.onchange = () => {
        if (chk.checked) state.selected.add(chk.dataset.id);
        else state.selected.delete(chk.dataset.id);
      };
    });
  } else {
    $("grid").classList.add('hidden');
    $("list").classList.remove('hidden');
    $("list").innerHTML = state.filtered.map(item => `
      <div class="p-3 flex items-center gap-3">
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" data-id="${item.id}" ${state.selected.has(item.id) ? 'checked' : ''} class="w-4 h-4">
          <span class="text-xs text-gray-500">${item.sku || '-'}</span>
        </label>
        <div class="flex-1">
          <div class="font-bold">${item.name||''}</div>
          <div class="text-xs text-gray-500">${item.brand||''}</div>
        </div>
        <div class="text-teal-700 font-semibold">$ ${Number(item.price||0).toFixed(2)}</div>
      </div>
    `).join('');
    $("list").querySelectorAll('input[type=checkbox]').forEach(chk => {
      chk.onchange = () => {
        if (chk.checked) state.selected.add(chk.dataset.id);
        else state.selected.delete(chk.dataset.id);
      };
    });
  }
}

function filterNow() {
  const q = ($("q").value || "").trim().toLowerCase();
  if (!q) {
    state.filtered = state.items.slice(0, 120);
  } else {
    state.filtered = state.items.filter(it => 
      (it.sku||'').toLowerCase().includes(q) ||
      (it.name||'').toLowerCase().includes(q) ||
      (it.brand||'').toLowerCase().includes(q)
    ).slice(0, 300);
  }
  render();
}

function exportCSV() {
  const picked = state.items.filter(it => state.selected.has(it.id));
  if (!picked.length) {
    alert('請至少勾選一項');
    return;
  }
  const rows = [
    ['id','sku','name','brand','price','images','updatedAt'],
    ...picked.map(it => [
      it.id, it.sku, it.name, it.brand, it.price, JSON.stringify(it.images||[]), it.updatedAt||''
    ])
  ];
  const csv = rows.map(r => r.map(x => {
    const s = String(x ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g,'""')}"`;
    }
    return s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'products.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function load() {
  fetch('/api/products?limit=500')
    .then(r => r.json())
    .then(d => {
      if (!d.ok) throw new Error('API 錯誤');
      state.items = d.items || [];
      state.filtered = state.items.slice(0, 120);
      render();
    })
    .catch(e => {
      console.error(e);
      alert('讀取失敗');
    });
}

$("btnToggle").onclick = () => {
  state.view = (state.view === 'grid') ? 'list' : 'grid';
  render();
};
$("btnSearch").onclick = () => filterNow();
$("q").addEventListener('keydown', (e) => { if (e.key === 'Enter') filterNow(); });
$("btnExport").onclick = exportCSV;
$("btnZip").onclick = () => alert('此功能尚未實作');

// 
load();
</script>
</body>
</html>
`;
