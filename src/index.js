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
    // === 1. 
    console.log("[syncAirtable] 開始抓取所有 Airtable 紀錄...");
    do {
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
      console.log(`[syncAirtable] 已抓取 ${allRecords.length} 筆...`);

    } while (offset);
    
    console.log(`[syncAirtable] Airtable 紀錄抓取完畢。總共 ${allRecords.length} 筆。`);

    if (allRecords.length === 0) {
      console.log("[syncAirtable] 沒有抓到任何資料，同步中止。");
      return { ok: true, message: "Airtable 中沒有資料，同步中止。", recordsFetched: 0 };
    }

    // === 2. 
    const productInsert = env.DATABASE.prepare(
      `INSERT OR REPLACE INTO products (sku, name, brand, status, raw_json) 
       VALUES (?, ?, ?, ?, ?)`
    );
    const imageInsert = env.DATABASE.prepare(
      `INSERT OR REPLACE INTO product_images (sku, filename, url, width, height, variant) 
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // === 3. 
    const CHUNK_SIZE = 100; // 
    let totalProductsUpserted = 0;
    let totalImagesUpserted = 0;
    let totalBatches = 0;

    console.log(`[syncAirtable] 開始分批處理資料，每批 ${CHUNK_SIZE} 筆...`);

    for (let i = 0; i < allRecords.length; i += CHUNK_SIZE) {
      const chunk = allRecords.slice(i, i + CHUNK_SIZE);
      totalBatches++;
      console.log(`[syncAirtable] 正在處理第 ${totalBatches} 批 (紀錄 ${i+1} 到 ${i + chunk.length})...`);
      
      const productStmts = [];
      const imageStmts = [];
      const skusInChunk = new Set();

      for (const record of chunk) {
        const fields = record.fields;
        
        if (!fields['商品貨號']) {
          console.warn(`[syncAirtable] (批次 ${totalBatches}) 偵測到一筆紀錄缺少 '商品貨號'，已跳過: ${record.id}`);
          continue;
        }

        const sku = String(fields['商品貨號']).trim();
        skusInChunk.add(sku);

        // 3a. 
        productStmts.push(
          productInsert.bind(
            sku,
            fields['產品名稱'] || null, 
            fields['品牌名稱'] || null, 
            fields['現貨商品'] || 'draft', 
            JSON.stringify(fields)
          )
        );
        
        // 3b. 
        if (fields['商品圖檔'] && Array.isArray(fields['商品圖檔'])) { 
          let variantCounter = 1;
          for (const img of fields['商品圖檔']) { 
            if (img.url && img.filename) {
              imageStmts.push(
                imageInsert.bind(
                  sku,
                  img.filename,
                  img.url,
                  img.width || null,
                  img.height || null,
                  `v${variantCounter++}`
                )
              );
            }
          }
        }
      } // 

      if (skusInChunk.size === 0) {
        console.log(`[syncAirtable] (批次 ${totalBatches}) 此批次中沒有有效的 SKU，跳過 D1 寫入。`);
        continue;
      }

      // 3c. 
      const skuPlaceholders = Array.from(skusInChunk).map(() => '?').join(',');
      const deleteOldImagesStmt = env.DATABASE.prepare(
        `DELETE FROM product_images WHERE sku IN (${skuPlaceholders})`
      ).bind(...skusInChunk);

      // 3d. 
      const allStmts = [
        deleteOldImagesStmt,
        ...productStmts,
        ...imageStmts
      ];

      console.log(`[syncAirtable] (批次 ${totalBatches}) 執行 D1 batch... (Delete: 1, Products: ${productStmts.length}, Images: ${imageStmts.length})`);
      await env.DATABASE.batch(allStmts);
      
      totalProductsUpserted += productStmts.length;
      totalImagesUpserted += imageStmts.length;

    } // 

    // === 4. 
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    const finalResult = {
      ok: true,
      message: "Airtable 同步 D1 成功！",
      recordsFetched: allRecords.length,
      productsUpserted: totalProductsUpserted,
      imagesUpserted: totalImagesUpserted,
      totalBatches: totalBatches,
      duration_seconds: duration,
      timestamp: new Date().toISOString(),
    };
    
    console.log(`[syncAirtable] D1 批次處理全部完成！`);
    console.log(JSON.stringify(finalResult));
    return finalResult;

  } catch (err) {
    console.error(`[syncAirtable] 同步過程中發生嚴重錯誤: ${err.message}`, err.stack);
    // 
    if (err.message.includes("too many SQL variables")) {
       return {
         ok: false,
         message: `同步失敗: D1 SQL 變數過多。這通常是因為一次同步的資料量太大。 (錯誤: ${err.message})`,
         timestamp: new Date().toISOString(),
       };
    }
    return {
      ok: false,
      message: `同步失敗: ${err.message}`,
      timestamp: new Date().toISOString(),
    };
  }
}


// --- Worker 處理常式 ---

export default {
  /**
   * * */
  async scheduled(controller, env, ctx) {
    console.log(`[cron] 偵測到排程觸發: ${controller.cron}`);
    // 
    // 
    ctx.waitUntil(syncAirtable(env));
  },

  /**
   * 處理 HTTP 請求 (fetch)
   */
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      const withCors = (res) => {
        const h = new Headers(res.headers);
        h.set("access-control-allow-origin", "*");
        h.set("access-control-allow-headers", "authorization,content-type");
        h.set("access-control-allow-methods", "GET,POST,OPTIONS");
        return new Response(res.body, { status: res.status, headers: h });
      };

      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization,content-type",
            "access-control-allow-methods": "GET,POST,OPTIONS",
          },
        });
      }

      const json = (data, status = 200, extra = {}) =>
        withCors(new Response(JSON.stringify(data, null, 2), {
          status,
          headers: { "content-type": "application/json; charset=utf-8", ...extra },
        }));

      const text = (data, status = 200, extra = {}) =>
        withCors(new Response(data, { status, headers: extra }));

      const requireBasicAuth = () => {
        const auth = request.headers.get("authorization") || "";
        const parts = auth.split(" ");
        if (parts[0] !== "Basic" || !parts[1]) return false;
        const [user, pass] = atob(parts[1]).split(":");
        return user === env.USERNAME && pass === env.PASSWORD;
      };

      // ✅ 
      if (request.method === "GET" && path === "/") {
        return text(CATALOG_HTML, 200, { "content-type": "text/html; charset=utf-8" });
      }

      // 後台頁
      if (request.method === "GET" && path === "/admin") {
        if (!requireBasicAuth()) {
          return withCors(new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="pet-republic-admin"' },
          }));
        }
        // 
        return text(ADMIN_HTML, 200, { "content-type": "text/html; charset=utf-8" });
      }

      // 
      if (request.method === "POST" && path === "/sync-airtable") {
        if (!requireBasicAuth()) {
          return withCors(new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="pet-republic-admin"' },
          }));
        }
        
        // 
        // 
        const result = await syncAirtable(env);
        return json(result, result.ok ? 200 : 500);
      }

      // ✅ 
      // 
      const productListMatch = path.match(/^\/api\/products\/?$/);
      if (request.method === "GET" && productListMatch) {
        try {
          const { searchParams } = url;
          const page = parseInt(searchParams.get("page") || "1");
          const size = parseInt(searchParams.get("size") || "20");
          const q = searchParams.get("q") || "";
          const offset = (page - 1) * size;

          const whereClauses = [];
          const bindings = [];

          if (q) {
            whereClauses.push(`(p.name LIKE ? OR p.sku LIKE ?)`);
            bindings.push(`%${q}%`, `%${q}%`);
          }

          const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : "";

          // 1. 
          const countQuery = `SELECT COUNT(*) AS total FROM products p ${where}`;
          const totalRs = await env.DATABASE.prepare(countQuery).bind(...bindings).first();
          const total = totalRs?.total || 0;

          // 2. 
          const dataQuery = `
            SELECT 
              p.sku, p.name, p.brand, p.status, p.raw_json,
              (SELECT pi.url FROM product_images pi WHERE pi.sku = p.sku ORDER BY pi.filename LIMIT 1) as first_image_url
            FROM products p
            ${where}
            ORDER BY p.sku
            LIMIT ? OFFSET ?
          `;
          
          const dataRs = await env.DATABASE.prepare(dataQuery).bind(...bindings, size, offset).all();

          return json({ 
            ok: true, 
            items: dataRs.results || [], 
            meta: { page, size, total }
          });

        } catch (e) {
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      // 單一產品
      const productSkuMatch = path.match(/^\/api\/products\/([^/]+)$/);
      if (request.method === "GET" && productSkuMatch) {
        const skuParam = decodeURIComponent(productSkuMatch[1]);
        try {
          const rs = await env.DATABASE.prepare(
            `SELECT * FROM products WHERE sku = ? LIMIT 1`
          ).bind(skuParam).all();
          return json({ ok: true, sku: skuParam, product: rs.results?.[0] || null });
        } catch (e) {
          return json({ ok: false, error: String(e) }, 500);
        }
      }

      // 產品圖片
      const imagesSkuMatch = path.match(/^\/api\/products\/([^/]+)\/images$/);
      if (request.method === "GET" && imagesSkuMatch) {
        const skuParam = decodeURIComponent(imagesSkuMatch[1]);
        try {
          const rs = await env.DATABASE.prepare(
            `SELECT sku, filename, url, width, height, variant FROM product_images WHERE sku = ? ORDER BY filename`
          ).bind(skuParam).all();
          return json({ ok: true, sku: skuParam, images: rs.results || [] });
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
      if (request.method === "GET" && path === "/api/debug/counts") {
        try {
          const p = await env.DATABASE.prepare(`SELECT COUNT(*) AS c FROM products`).first();
          const i = await env.DATABASE.prepare(`SELECT COUNT(*) AS c FROM product_images`).first();
          return json({ ok: true, products: p?.c ?? 0, images: i?.c ?? 0 });
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

// --- HTML 
const ADMIN_HTML = \`
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
    out.textContent = '正在請求同步...';
    try {
      const res = await fetch('/sync-airtable', {method:'POST'});
      const data = await res.json();
      out.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      out.textContent = '錯誤: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }
</script>\`;

// ✅ 
// 
const CATALOG_HTML = \`
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

  <div id="cards" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div>
  
  <div class="mt-4 text-sm text-gray-600" id="summary"></div>

  <div class="mt-6 flex gap-3">
    <button id="prev" class="rounded-lg border px-4 py-2 disabled:opacity-50" disabled>上一頁</button>
    <button id="next" class="rounded-lg border px-4 py-2 disabled:opacity-50" disabled>下一頁</button>
  </div>

  <pre id="debug" class="mt-6 hidden bg-gray-900 text-white p-3 rounded"></pre>
</main>

<script>
// ✅ 
const state = { page: 1, size: 20, q: "", total: 0 };
const $ = (id)=>document.getElementById(id);
const cards = $("cards");

// 
function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, function(m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m];
  });
}

function render(items){
  cards.innerHTML = "";
  if(!items.length){
    cards.innerHTML = '<div class="text-gray-500">找不到符合條件的商品</div>';
    return;
  }
  for(const p of items){
    const box = document.createElement("div");
    box.className = "rounded-xl bg-white shadow p-4 flex flex-col gap-2";
    
    // 
    const raw = JSON.parse(p.raw_json || "{}");
    const category = raw['類別'] || "-"; // 
    
    // ✅ 
    const img = (p.first_image_url) 
      ? '<img src="' + escapeHTML(p.first_image_url) + '" class="w-full aspect-square object-cover rounded-lg border"/>' 
      : '<div class="w-full aspect-square bg-gray-100 rounded-lg border flex items-center justify-center text-gray-400">沒有圖片</div>';
      
    // ✅ 
    box.innerHTML = 
      img +
      '<div class="text-sm text-gray-500">' + escapeHTML(p.brand || "-") + '｜' + escapeHTML(category) + '</div>' +
      '<div class="text-lg font-bold">' + escapeHTML(p.sku) + '</div>' +
      '<div class="text-base h-12 overflow-hidden">' + escapeHTML(p.name || "") + '</div>' +
      '<div class="text-sm text-gray-500">狀態：' + escapeHTML(p.status || "-") + '</div>';
      
    cards.appendChild(box);
  }
}

async function load(){
  const url = new URL("/api/products", location.origin);
  url.searchParams.set("page", state.page);
  url.searchParams.set("size", state.size);
  if(state.q) url.searchParams.set("q", state.q);
  
  cards.innerHTML = '<div class="text-gray-500">載入中...</div>';
  
  const res = await fetch(url);
  const data = await res.json();
  
  if (!data.ok) {
    cards.innerHTML = '<div class="text-red-500">API 錯誤: ' + escapeHTML(data.error) + '</div>';
    return;
  }

  // 
  render(data.items || []);
  
  // 
  const meta = data.meta || { page: 1, size: 20, total: 0 };
  state.page = meta.page;
  state.total = meta.total;
  
  $("prev").disabled = (meta.page <= 1);
  $("next").disabled = (meta.page * meta.size >= meta.total);
  
  // 
  const start = (meta.page - 1) * meta.size + 1;
  const end = Math.min(meta.page * meta.size, meta.total);
  $("summary").textContent = '顯示 ' + start + ' - ' + end + ' 筆，共 ' + meta.total + ' 筆商品';
}

// 
$("btnSearch").onclick = ()=>{ state.q = $("q").value.trim(); state.page = 1; load(); };
$("q").onkeydown = (e) => { if(e.key === 'Enter') { $("btnSearch").click(); } };

// 
$("prev").onclick = ()=>{ if(state.page>1){ state.page--; load(); } };
$("next").onclick = ()=>{ state.page++; load(); };

// 
$("btnToggle").onclick = () => {
  if (cards.classList.contains("grid")) {
    cards.className = "flex flex-col gap-4";
  } else {
    cards.className = "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4";
  }
};

// 
$("btnExport").onclick = () => alert('此功能尚未實作');
$("btnZip").onclick = () => alert('此功能尚未實作');

// 
load();
</script>
</body>
</html>
\`;
