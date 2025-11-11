export default {
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
              "POST /sync-airtable -> trigger import (placeholder)",
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
    const res = await fetch('/sync-airtable', {method:'POST'});
    document.getElementById('out').textContent = await res.text();
  }
</script>`;
        return text(html, 200, { "content-type": "text/html; charset=utf-8" });
      }

      // 手動同步（示範回覆）
      if (request.method === "POST" && path === "/sync-airtable") {
        if (!requireBasicAuth()) {
          return withCors(new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="pet-republic-admin"' },
          }));
        }
        return json({
          ok: true,
          message: "已接收同步請求。請留意 D1 儀表板查詢數與 logs（此示範回覆成功，不執行真實抓取）。",
        });
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
