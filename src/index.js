export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const method = request.method.toUpperCase();

    // ===== Helpers =====
    const secHeaders = {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer-when-downgrade",
      "permissions-policy":
        "accelerometer=(), autoplay=(), camera=(), geolocation=(), microphone=(), payment=()",
    };

    // CORS
    const allowOrigin = pickOrigin(request, env.ALLOWED_ORIGINS);
    const corsHeaders = {
      "access-control-allow-origin": allowOrigin,
      "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-expose-headers": "etag",
      "access-control-max-age": "86400",
    };

    const respondJSON = (data, status = 200, extra = {}) =>
      new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...secHeaders,
          ...corsHeaders,
          ...extra,
        },
      });

    const respondText = (data, status = 200, extra = {}) =>
      new Response(data, {
        status,
        headers: { ...secHeaders, ...corsHeaders, ...extra },
      });

    const respondHTML = (html, status = 200, extra = {}) =>
      new Response(html, {
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...secHeaders,
          ...corsHeaders,
          ...extra,
        },
      });

    const requireBasicAuth = () => {
      const header = request.headers.get("authorization") || "";
      const [, b64] = header.split(" ");
      if (!b64) return false;
      const [user, pass] = atob(b64).split(":");
      return user === env.USERNAME && pass === env.PASSWORD;
    };

    // ===== Preflight =====
    if (method === "OPTIONS") {
      // 若為預檢請求，直接回 204 與 CORS 標頭
      return new Response(null, {
        status: 204,
        headers: { ...secHeaders, ...corsHeaders },
      });
    }

    // ===== Root: HTML / JSON 目錄 =====
    if (method === "GET" && path === "/") {
      // 偵測瀏覽器 → HTML；API 用戶 → JSON
      const wantsHTML =
        url.searchParams.get("format") === "html" ||
        (request.headers.get("accept") || "").includes("text/html");

      if (!wantsHTML) {
        return respondJSON({
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

      // 簡單型錄頁（前 50 筆）
      try {
        const rs = await env.DATABASE.prepare(
          `SELECT
             p.sku, p.name, p.brand, p.status,
             (SELECT url FROM product_images WHERE sku = p.sku LIMIT 1) AS cover_url
           FROM products p
           ORDER BY p.sku
           LIMIT 50`
        ).all();

        const rows = rs.results || [];
        const html = renderCatalogHTML(rows);
        return respondHTML(html);
      } catch (e) {
        return respondHTML(
          minimalHTML(
            `<h1>Pet Republic｜目錄</h1><p style="color:#b91c1c">載入失敗：${escapeHTML(
              String(e)
            )}</p>`
          ),
          500
        );
      }
    }

    // ===== 後台（Basic Auth） =====
    if (method === "GET" && path === "/admin") {
      if (!requireBasicAuth()) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...secHeaders,
            ...corsHeaders,
            "WWW-Authenticate": 'Basic realm="pet-republic-admin"',
          },
        });
      }
      const html = minimalHTML(`
        <h1>Pet Republic｜後台</h1>
        <section>
          <h2>Airtable 同步</h2>
          <button id="btn">開始同步</button>
          <pre id="out"></pre>
        </section>
        <script>
          document.getElementById('btn').onclick = async () => {
            const res = await fetch('/sync-airtable', { method:'POST' });
            document.getElementById('out').textContent = await res.text();
          };
        </script>
      `);
      return respondHTML(html);
    }

    if (method === "POST" && path === "/sync-airtable") {
      if (!requireBasicAuth()) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            ...secHeaders,
            ...corsHeaders,
            "WWW-Authenticate": 'Basic realm="pet-republic-admin"',
          },
        });
      }
      // 這裡先回示範訊息；未實作真實抓取，避免 CI/權限風險
      return respondJSON({
        ok: true,
        message:
          "已接收同步請求。請留意 D1 儀表板查詢數與 logs（本端點目前為示範回覆，未執行真實抓取）。",
      });
    }

    // ===== API: 產品清單 =====
    if (method === "GET" && path === "/api/products") {
      try {
        const rs = await env.DATABASE.prepare(
          `SELECT sku, name, brand, status
           FROM products
           ORDER BY sku LIMIT 100`
        ).all();
        return respondJSON({ ok: true, rows: rs.results || [] });
      } catch (e) {
        return respondJSON({ ok: false, error: String(e) }, 500);
      }
    }

    // ===== API: 單一產品 =====
    const mProduct = path.match(/^\/api\/products\/([^/]+)$/);
    if (method === "GET" && mProduct) {
      const sku = decodeURIComponent(mProduct[1]);
      try {
        const rs = await env.DATABASE.prepare(
          `SELECT * FROM products WHERE sku = ? LIMIT 1`
        )
          .bind(sku)
          .all();
        return respondJSON({
          ok: true,
          sku,
          product: rs.results?.[0] || null,
        });
      } catch (e) {
        return respondJSON({ ok: false, error: String(e) }, 500);
      }
    }

    // ===== API: 產品圖片 =====
    const mImages = path.match(/^\/api\/products\/([^/]+)\/images$/);
    if (method === "GET" && mImages) {
      const sku = decodeURIComponent(mImages[1]);
      try {
        const rs = await env.DATABASE.prepare(
          `SELECT sku, filename, url, width, height, variant
           FROM product_images WHERE sku = ?
           ORDER BY filename`
        )
          .bind(sku)
          .all();
        return respondJSON({ ok: true, sku, images: rs.results || [] });
      } catch (e) {
        return respondJSON({ ok: false, error: String(e) }, 500);
      }
    }

    // ===== 公開圖檔（R2）: /{sku}/{filename} =====
    const mFile = path.match(/^\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && mFile) {
      const key = `${decodeURIComponent(mFile[1])}/${decodeURIComponent(
        mFile[2]
      )}`;

      // ETag / If-None-Match 支援
      const obj = await env.R2_BUCKET.get(key, { onlyIf: getConditional(request) });
      if (obj && obj.notModified) {
        return new Response(null, {
          status: 304,
          headers: { ...secHeaders, ...corsHeaders, etag: obj.etag },
        });
      }
      if (!obj) return respondText("Not Found", 404);

      const headers = new Headers({ ...secHeaders, ...corsHeaders, etag: obj.etag });
      if (obj.httpMetadata?.contentType)
        headers.set("content-type", obj.httpMetadata.contentType);
      // 可調整快取策略
      headers.set("cache-control", "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400");

      return new Response(obj.body, { headers });
    }

    // ===== 健康檢查 / 統計 =====
    if (method === "GET" && path === "/api/debug/counts") {
      try {
        const p = await env.DATABASE.prepare(
          `SELECT COUNT(*) AS c FROM products`
        ).first();
        const i = await env.DATABASE.prepare(
          `SELECT COUNT(*) AS c FROM product_images`
        ).first();
        return respondJSON({ ok: true, products: p?.c ?? 0, images: i?.c ?? 0 });
      } catch {
        // D1 尚未建表時也能回應
        return respondJSON({ ok: true, products: 0, images: 0 });
      }
    }

    // ===== 兜底 =====
    return respondText("Not Found", 404);

    // ===== Utils =====
    function normalizePath(p) {
      const clean = p.replace(/\/+$/, "");
      return clean === "" ? "/" : clean;
    }

    function pickOrigin(req, list) {
      const reqOrigin = req.headers.get("origin") || "";
      if (!list || list.trim() === "") return reqOrigin || "*";
      const allowed = list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return allowed.includes(reqOrigin) ? reqOrigin : allowed[0] || "*";
    }

    function minimalHTML(inner) {
      return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pet Republic</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,-apple-system,"Noto Sans TC",Segoe UI,Roboto,sans-serif;margin:24px;line-height:1.6}
  h1{font-size:clamp(20px,2.6vw,28px);margin:0 0 12px}
  h2{font-size:18px;margin:20px 0 8px}
  button{font-size:16px;padding:.7rem 1.1rem;border-radius:.75rem;background:#4f46e5;color:#fff;border:0}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
  .card{border:1px solid #e5e7eb22;border-radius:16px;padding:12px}
  .card img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:12px;background:#0b1220}
  .muted{opacity:.6}
  pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:12px;overflow:auto}
</style>
${inner}`;
    }

    function renderCatalogHTML(rows) {
      const items = rows
        .map(
          (r) => `<div class="card">
  <img src="${escapeAttr(r.cover_url || "")}" loading="lazy" alt="${escapeAttr(
            r.name || r.sku
          )}">
  <div><strong>${escapeHTML(r.name || r.sku)}</strong></div>
  <div class="muted">${escapeHTML(r.brand || "")} · ${escapeHTML(
            r.status || ""
          )}</div>
  <div class="muted">SKU：${escapeHTML(r.sku)}</div>
</div>`
        )
        .join("");
      return minimalHTML(`
        <h1>Pet Republic｜目錄</h1>
        <div class="grid">${items || "<div class='muted'>尚無產品資料</div>"}</div>
        <p class="muted">顯示前 50 筆 · 以 /api/products 取得 JSON</p>
      `);
    }

    function escapeHTML(s = "") {
      return s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }
    function escapeAttr(s = "") {
      return escapeHTML(s).replaceAll("'", "&#39;");
    }

    function getConditional(req) {
      const etag = req.headers.get("if-none-match");
      return etag ? { etagMatches: etag } : undefined;
    }
  },
};
