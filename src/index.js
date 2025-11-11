/**
 * ✅ 
 * * @param {object} env - Worker 
 */
async function syncAirtable(env) {
  const startTime = Date.now();
  console.log(`[syncAirtable] 開始執行同步... (Base: ${env.AIRTABLE_BASE_ID}, Table: ${env.AIRTABLE_TABLE_NAME})`);

  let allRecords = [];
  let offset = null;
  const airtableUrl = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_NAME}`);
  
  // 
  airtableUrl.searchParams.set('view', 'Grid view'); // 
  airtableUrl.searchParams.set('pageSize', 100);

  try {
    // === 1. 
    // Airtable API 
    do {
      if (offset) {
        airtableUrl.searchParams.set('offset', offset);
      }
      
      console.log(`[syncAirtable] 正在抓取 Airtable 頁面... (offset: ${offset})`);
      const res = await fetch(airtableUrl.href, {
        headers: {
          'Authorization': `Bearer ${env.AIRTABLE_API_TOKEN}`,
        },
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Airtable API 錯誤: ${res.status} ${res.statusText} - ${errorText}`);
      }

      const data = await res.json();
      allRecords.push(...data.records);
      offset = data.offset;

    } while (offset);
    
    console.log(`[syncAirtable] 已抓取總共 ${allRecords.length} 筆 Airtable 紀錄。`);

    if (allRecords.length === 0) {
      console.log("[syncAirtable] 沒有抓到任何資料，同步中止。");
      return { ok: true, message: "Airtable 中沒有資料，同步中止。", recordsFetched: 0 };
    }

    // === 2. 
    const productStmts = [];
    const imageStmts = [];

    // 
    const productInsert = env.DATABASE.prepare(
      `INSERT OR REPLACE INTO products (sku, name, brand, status, raw_json) 
       VALUES (?, ?, ?, ?, ?)`
    );
    
    const imageInsert = env.DATABASE.prepare(
      `INSERT OR REPLACE INTO product_images (sku, filename, url, width, height, variant) 
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    
    // 
    const skusInAirtable = new Set();

    for (const record of allRecords) {
      const fields = record.fields;
      
      // ✅ 
      if (!fields['商品貨號']) {
        console.warn(`[syncAirtable] 偵測到一筆紀錄缺少 '商品貨號'，已跳過: ${record.id}`);
        continue;
      }

      const sku = String(fields['商品貨號']).trim();
      skusInAirtable.add(sku);

      // 2a. 
      productStmts.push(
        productInsert.bind(
          sku,
          fields['產品名稱'] || null, // ✅ 
          fields['品牌名稱'] || null, // ✅ 
          fields['現貨商品'] || 'draft', // ✅ 
          JSON.stringify(fields) // 
        )
      );
      
      // 2b. 
      if (fields['商品圖檔'] && Array.isArray(fields['商品圖檔'])) { // ✅ 
        let variantCounter = 1;
        for (const img of fields['商品圖檔']) { // ✅ 
          if (img.url && img.filename) {
            imageStmts.push(
              imageInsert.bind(
                sku,
                img.filename,
                img.url,
                img.width || null,
                img.height || null,
                `v${variantCounter++}` // 
              )
            );
          }
        }
      }
    }
    
    // === 3. 
    // 
    // 
    // 
    
    // 
    const imageSkus = Array.from(skusInAirtable).map(sku => `?`).join(',');
    const deleteOldImagesStmt = env.DATABASE.prepare(
      `DELETE FROM product_images WHERE sku IN (${imageSkus})`
    ).bind(...skusInAirtable);

    console.log(`[syncAirtable] 準備執行 D1 批次處理... (Products: ${productStmts.length}, Images: ${imageStmts.length}, DeleteStmts: 1)`);

    // 
    // 
    const allStmts = [
      deleteOldImagesStmt, // 
      ...productStmts,     // 
      ...imageStmts        // 
    ];

    const results = await env.DATABASE.batch(allStmts);
    
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.log(`[syncAirtable] D1 批次處理完成！`, results);

    const finalResult = {
      ok: true,
      message: "Airtable 同步 D1 成功！",
      recordsFetched: allRecords.length,
      productsUpserted: productStmts.length,
      imagesUpserted: imageStmts.length,
      duration_seconds: duration,
      timestamp: new Date().toISOString(),
    };
    
    console.log(JSON.stringify(finalResult));
    return finalResult;

  } catch (err) {
    console.error(`[syncAirtable] 同步過程中發生嚴重錯誤: ${err.message}`, err.stack);
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

      // 根目錄
      if (request.method === "GET" && path === "/") {
        return json({
          ok: true,
          name: "Pet Republic API",
          routes: {
            public: [
              "GET / -> catalog html/json",
              "GET /{sku}/{filename} -> public image (R2)",
              "GET /api/products -> list products",
              "GET /api/products/:sku -> get product",
              "GET /api/products/:sku/images -> product images",
              "GET /api/debug/counts -> D1 counts",
            ],
            protected_basic_auth: [
              "GET /admin -> admin html",
              "POST /sync-airtable -> trigger import",
            ],
          },
        });
      }

      // 後台頁
      if (request.method === "GET" && path === "/admin") {
        if (!requireBasicAuth()) {
          return withCors(new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="pet-republic-admin"' },
          }));
        }
        const html = `
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
</script>`;
        return text(html, 200, { "content-type": "text/html; charset=utf-8" });
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

      // 產品列表
      if (request.method === "GET" && path === "/api/products") {
        try {
          const rs = await env.DATABASE.prepare(
            `SELECT sku, name, brand, status FROM products ORDER BY sku LIMIT 100`
          ).all();
          return json({ ok: true, rows: rs.results || [] });
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
