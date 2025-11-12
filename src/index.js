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
    // === 1. 取回 Airtable 全部分頁 ===
    while (true) {
      if (offset) airtableUrl.searchParams.set('offset', offset);
      const res = await fetch(airtableUrl, {
        headers: {
          'Authorization': `Bearer ${env.AIRTABLE_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      if (!res.ok) {
        const t = await res.text().catch(()=> '');
        throw new Error(`Airtable 讀取失敗: ${res.status} ${res.statusText} - ${t}`);
      }
      const data = await res.json();
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
      console.log(`[syncAirtable] 已抓取筆數: ${allRecords.length}${offset ? ' (尚有下一頁)' : ''}`);
      if (!offset) break;
    }

    // === 2. 轉為產品與圖片陣列 ===
    const products = [];
    const images = [];

    for (const r of allRecords) {
      const f = r.fields || {};
      const sku = (f.sku || f.SKU || '').toString().trim();
      if (!sku) continue;

      products.push({
        sku,
        name: (f.name || f.品名 || '').toString().trim(),
        brand: (f.brand || f.品牌 || '').toString().trim(),
        price: Number(f.price || f.Price || 0) || 0,
        category: (f.category || f.分類 || '').toString().trim(),
        updated_at: new Date().toISOString()
      });

      const imgs = f.images || f.Images || [];
      if (Array.isArray(imgs)) {
        for (const img of imgs) {
          images.push({
            sku,
            filename: img.filename || img.name || '',
            url: img.url || '',
            width: img.width || 0,
            height: img.height || 0,
            variant: img.variant || ''
          });
        }
      }
    }

    console.log(`[syncAirtable] 轉換完成：產品 ${products.length}、圖片 ${images.length}`);

    // === 3. 寫入 D1 (UPSERT) ===
    // 建表（若不存在）
    await env.DATABASE.exec(`
      CREATE TABLE IF NOT EXISTS products (
        sku TEXT PRIMARY KEY,
        name TEXT,
        brand TEXT,
        price REAL,
        category TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS product_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT,
        filename TEXT,
        url TEXT,
        width INTEGER,
        height INTEGER,
        variant TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_product_images_sku ON product_images(sku);
    `);

    const productUpsert = env.DATABASE.prepare(`
      INSERT INTO products (sku, name, brand, price, category, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET
        name=excluded.name,
        brand=excluded.brand,
        price=excluded.price,
        category=excluded.category,
        updated_at=excluded.updated_at
    `);

    const imageDeleteBySku = env.DATABASE.prepare(`DELETE FROM product_images WHERE sku = ?`);
    const imageInsert = env.DATABASE.prepare(
      `INSERT OR REPLACE INTO product_images (sku, filename, url, width, height, variant) 
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // === 3. 分批寫入，避免單次交易過大 ===
    const CHUNK_SIZE = 100; // 
    let totalProductsUpserted = 0;
    let totalImagesUpserted = 0;
    let totalBatches = 0;

    console.log(`[syncAirtable] 開始分批處理資料，每批 ${CHUNK_SIZE} 筆...`);

    for (let i = 0; i < allRecords.length; i += CHUNK_SIZE) {
      const chunkProducts = products.slice(i, i + CHUNK_SIZE);

      // 產品 UPSERT
      for (const p of chunkProducts) {
        await productUpsert.bind(p.sku, p.name, p.brand, p.price, p.category, p.updated_at).run();
        totalProductsUpserted++;
      }

      // 每批同步圖片：先刪後插（確保與 Airtable 對齊）
      const skuSet = new Set(chunkProducts.map(p => p.sku));
      for (const sku of skuSet) {
        await imageDeleteBySku.bind(sku).run();
      }
      const chunkImages = images.filter(img => skuSet.has(img.sku));
      for (const img of chunkImages) {
        await imageInsert.bind(img.sku, img.filename, img.url, img.width, img.height, img.variant).run();
        totalImagesUpserted++;
      }

      totalBatches++;
      console.log(`[syncAirtable] 批次 ${totalBatches} 完成：產品累計 ${totalProductsUpserted}、圖片累計 ${totalImagesUpserted}`);
    }

    const took = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[syncAirtable] 完成！花費 ${took}s`);
    return { ok: true, products: totalProductsUpserted, images: totalImagesUpserted, batches: totalBatches, took: Number(took) };
  } catch (err) {
    console.error('[syncAirtable] 失敗', err);
    return { ok: false, error: String(err) };
  }
}

// ===== Utilities =====
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

const text = (str, status = 200, headers = {}) =>
  new Response(str, { status, headers });

function withCors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "*");
  return new Response(res.body, { ...res, headers: h });
}

function parseBasicAuth(req) {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Basic ')) return null;
  try {
    const raw = atob(auth.slice(6));
    const idx = raw.indexOf(':');
    return { user: raw.slice(0, idx), pass: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

function requireBasicAuth(req, env) {
  const creds = parseBasicAuth(req);
  if (!env.PASSWORD || !env.USERNAME) return false; // 未設定就視為關閉
  return creds && creds.user === env.USERNAME && creds.pass === env.PASSWORD;
}

// ===== Worker =====
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
          },
        });
      }

      // 後台頁（需基本驗證）
      if (request.method === "GET" && path === "/admin") {
        if (!requireBasicAuth(request, env)) {
          return withCors(new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="pet-republic-admin"' },
          }));
        }
        // 顯示簡單後台頁
        return text(ADMIN_HTML, 200, { "content-type": "text/html; charset=utf-8" });
      }

      // 觸發 Airtable 同步（POST）
      if (request.method === "POST" && path === "/sync-airtable") {
        if (!requireBasicAuth(request, env)) {
          return withCors(new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="pet-republic-admin"' },
          }));
        }
        const result = await syncAirtable(env);
        return json(result);
      }

      // 產品 API：GET /api/products?page=1&size=20&q=xxx
      if (request.method === "GET" && path === "/api/products") {
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') || 20)));
        const q = (url.searchParams.get('q') || '').trim();

        let where = '';
        const params = [];
        if (q) {
          where = `WHERE sku LIKE ? OR name LIKE ? OR brand LIKE ? OR category LIKE ?`;
          const like = `%${q}%`;
          params.push(like, like, like, like);
        }

        const [{ count }] = await env.DATABASE.prepare(`SELECT COUNT(*) AS count FROM products ${where}`).bind(...params).all().then(r => r.results);
        const offset = (page - 1) * size;

        const rows = await env.DATABASE.prepare(
          `SELECT sku, name, brand, price, category, updated_at 
           FROM products ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
        ).bind(...params, size, offset).all().then(r => r.results);

        // 取回圖片（每筆最多 4 張示意）
        const skuList = rows.map(r => r.sku);
        let images = [];
        if (skuList.length) {
          const placeholders = skuList.map(()=> '?').join(',');
          images = await env.DATABASE.prepare(
            `SELECT sku, filename, url, width, height, variant 
             FROM product_images WHERE sku IN (${placeholders})
             ORDER BY id ASC`
          ).bind(...skuList).all().then(r => r.results);
        }

        // 聚合
        const imgMap = new Map();
        for (const img of images) {
          if (!imgMap.has(img.sku)) imgMap.set(img.sku, []);
          if (imgMap.get(img.sku).length < 4) imgMap.get(img.sku).push(img);
        }
        const items = rows.map(r => ({ ...r, images: imgMap.get(r.sku) || [] }));

        return json({
          ok: true,
          items,
          meta: { page, size, total: count }
        });
      }

      // 前台清單頁
      if (request.method === "GET" && path === "/") {
        return text(CATALOG_HTML, 200, { "content-type": "text/html; charset=utf-8" });
      }

      // 圖片上傳（需基本驗證）PUT /upload/:sku/:filename  body=二進位檔
      const uploadMatch = path.match(/^\/upload\/([^/]+)\/([^/]+)$/);
      if (request.method === "PUT" && uploadMatch) {
        if (!requireBasicAuth(request, env)) {
          return withCors(new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="pet-republic-admin"' },
          }));
        }
        try {
          const sku = decodeURIComponent(uploadMatch[1]);
          const filename = decodeURIComponent(uploadMatch[2]);

          const maxMB = Number(env.MAX_IMAGE_MB || "20");
          const buf = await request.arrayBuffer();
          const sizeMB = buf.byteLength / (1024 * 1024);
          if (sizeMB > maxMB) return json({ ok: false, error: `檔案超過 ${maxMB} MB` }, 413);

          const ct = request.headers.get('content-type') || 'application/octet-stream';
          await env.R2_BUCKET.put(`${sku}/${filename}`, buf, { httpMetadata: { contentType: ct } });
          return json({ ok: true, path: `/${sku}/${filename}` });
        } catch (e) {
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      // 公開圖檔（R2）： /{sku}/{filename}
      const fileMatch = path.match(/^\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && fileMatch) {
        const bucketKey = `${decodeURIComponent(fileMatch[1])}/${decodeURIComponent(fileMatch[2])}`;
        const obj = await env.R2_BUCKET.get(bucketKey); 
        if (!obj) return text("Not Found", 404);
        const headers = new Headers();
        if (obj.httpMetadata?.contentType) headers.set("content-type", obj.httpMetadata.contentType);
        return withCors(new Response(obj.body, { headers }));
      }

      // 健康檢查 / 統計
      if (request.method === "GET" && path === "/health") {
        try {
          const [{ cnt }] = await env.DATABASE.prepare(`SELECT COUNT(*) AS cnt FROM products`).all().then(r => r.results);
          return json({ ok: true, d1_products: cnt ?? 0, time: new Date().toISOString() });
        } catch {
          return json({ ok: true, products: 0, images: 0 });
        }
      }

      return text("Not Found", 404);
    } catch (err) {
      return new Response(`Internal Error: ${String(err)}`, { status: 500 });
    }
  },
};

// --- HTML （後台）
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
  document.getElementById('btn').onclick = async () => {
    const btn = document.getElementById('btn');
    const out = document.getElementById('out');
    btn.disabled = true;
    out.textContent = '執行中...\\n';

    try {
      const res = await fetch('/sync-airtable', { method: 'POST' });
      const data = await res.json();
      out.textContent += JSON.stringify(data, null, 2);
    } catch (e) {
      out.textContent += '錯誤: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  };
</script>`;

// ✅ 前台「商品清單」頁
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
    <button id="btnZip" class="rounded-lg bg-indigo-600 text-white px-4 py-2">打包圖片 ZIP</button>
  </div>

  <div id="summary" class="text-sm text-gray-500 mb-3"></div>

  <div id="cards" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div>

  <div class="mt-6 flex items-center justify-center gap-2">
    <button id="prev" class="rounded border px-3 py-1">上一頁</button>
    <button id="next" class="rounded border px-3 py-1">下一頁</button>
  </div>
</main>

<script>
const state = { page: 1, size: 20, q: '', cardMode: true, selected: new Set() };

function $(id){ return document.getElementById(id); }
function escapeHTML(s){ return (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[m])); }
function csvLine(cols){ return cols.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','); }

function productCard(p){
  const imgs = (p.images||[]).slice(0,4).map(img =>
    \`<img src="\${escapeHTML(img.url)}" alt="\${escapeHTML(img.filename||'')}" class="w-20 h-20 object-cover rounded border"/>\`
  ).join('');
  const checked = state.selected.has(p.sku) ? 'checked' : '';
  return \`
  <div class="bg-white rounded-xl border shadow-sm overflow-hidden">
    <div class="p-4 flex items-start gap-3">
      <input type="checkbox" data-sku="\${p.sku}" class="mt-1">
      <div>
        <div class="text-sm text-gray-400">\${escapeHTML(p.category||'')}</div>
        <div class="font-semibold text-lg">\${escapeHTML(p.name||p.sku)}</div>
        <div class="text-sm text-gray-500">品牌：\${escapeHTML(p.brand||'-')}</div>
        <div class="text-teal-700 font-bold">NT$\${(p.price||0).toLocaleString()}</div>
      </div>
    </div>
    <div class="px-4 pb-4 flex flex-wrap gap-2">\${imgs||''}</div>
  </div>\`;
}

function productRow(p){
  return \`
  <div class="grid grid-cols-12 gap-3 items-center">
    <div class="col-span-1"><input type="checkbox" data-sku="\${p.sku}"></div>
    <div class="col-span-2 font-mono text-sm">\${escapeHTML(p.sku)}</div>
    <div class="col-span-4">\${escapeHTML(p.name||'-')}</div>
    <div class="col-span-2 text-gray-500">\${escapeHTML(p.brand||'-')}</div>
    <div class="col-span-1 text-right">NT$\${(p.price||0).toLocaleString()}</div>
    <div class="col-span-2 text-gray-400 text-xs">\${escapeHTML(p.updated_at||'')}</div>
  </div>\`;
}

function render(list){
  const el = $("cards");
  if (state.cardMode) {
    el.className = "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4";
    el.innerHTML = list.map(productCard).join('');
  } else {
    el.className = "space-y-2";
    el.innerHTML = \`
      <div class="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div class="p-3 grid grid-cols-12 gap-3 text-sm font-semibold bg-gray-50 border-b">
          <div class="col-span-1">選取</div>
          <div class="col-span-2">SKU</div>
          <div class="col-span-4">名稱</div>
          <div class="col-span-2">品牌</div>
          <div class="col-span-1 text-right">價格</div>
          <div class="col-span-2">更新時間</div>
        </div>
        <div class="divide-y">\${list.map(productRow).join('')}</div>
      </div>\`;
  }

  // 綁 checkbox
  el.querySelectorAll('input[type="checkbox"][data-sku]').forEach(cb=>{
    cb.checked = state.selected.has(cb.dataset.sku);
    cb.onchange = () => {
      if (cb.checked) state.selected.add(cb.dataset.sku);
      else state.selected.delete(cb.dataset.sku);
    };
  });
}

$("btnToggle").onclick = ()=>{
  state.cardMode = !state.cardMode;
  load();
};

$("btnExport").onclick = ()=>{
  const lines = [["SKU","Name","Brand","Price","Category"]];
  (state.selected.size ? [...state.selected] : []).forEach(sku=>{
    // 這裡實際上可再呼叫單筆 API；先僅以畫面資料為例
  });
  if (!state.selected.size) { alert('請勾選要匯出的商品'); return; }
  const csv = lines.map(csvLine).join("\\n");
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'products.csv';
  a.click();
};

$("prev").onclick = ()=>{ if(state.page>1){ state.page--; load(); } };
$("next").onclick = ()=>{ state.page++; load(); };

async function load(){
  const params = new URLSearchParams({ page: state.page, size: state.size });
  if (state.q) params.set('q', state.q);
  const url = '/api/products?' + params.toString();

  const cards = $("cards");
  cards.innerHTML = '<div class="text-gray-500">載入中...</div>';
  
  const res = await fetch(url);
  const data = await res.json();
  
  if (!data.ok) {
    cards.innerHTML = '<div class="text-red-500">API 錯誤: ' + escapeHTML(data.error) + '</div>';
    return;
  }

  // 重新 render
  render(data.items || []);
  
  // 分頁摘要
  const meta = data.meta || { page: 1, size: 20, total: 0 };
  state.page = meta.page;
  state.total = meta.total;
  
  $("prev").disabled = (meta.page <= 1);
  $("next").disabled = (meta.page * meta.size >= meta.total);
  
  // 底部摘要
  const start = (meta.page - 1) * meta.size + 1;
  const end = Math.min(meta.page * meta.size, meta.total);
  $("summary").textContent = '顯示 ' + start + ' - ' + end + ' 筆，共 ' + meta.total + ' 筆商品';
}

// 查詢
$("btnSearch").onclick = ()=>{ state.q = $("q").value.trim(); state.page = 1; load(); };
$("q").onkeydown = (e) => { if(e.key === 'Enter') { $("btnSearch").click(); } };

// 下載 ZIP（未實作範例）
$("btnZip").onclick = () => alert('此功能尚未實作');

// 初始載入
load();
</script>
</body>
</html>
`;
