/**
 * Pet Republic API - Cloudflare Worker
 * - Public:
 *   GET  /                      -> 前台清單 HTML
 *   GET  /api/products          -> 產品清單（支援 q, brand, category, status, page, size）
 *   GET  /api/products/:sku     -> 取得單一品
 *   GET  /api/products/:sku/images -> 該品圖片清單
 *   GET  /api/debug/counts      -> 健康檢查（產品/圖片數）
 *
 * - Protected (Basic Auth):
 *   GET  /admin                 -> 後台 HTML
 *   POST /sync-airtable         -> 從 Airtable 匯入/更新到 D1
 *
 * - Static:
 *   直接回傳 /index.html 與 /admin/index.html 內建版本（方便單檔部署）
 *   若你想用外部 HTML，也可改成 fetch R2/KV/Pages Assets
 */

/// -------- 小工具 --------
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const html = (text, status = 200) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const notFound = () => new Response("Not Found", { status: 404 });

function parseBasicAuth(req) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return null;
  try {
    const s = atob(h.slice(6));
    const i = s.indexOf(":");
    if (i < 0) return null;
    return { user: s.slice(0, i), pass: s.slice(i + 1) };
  } catch {
    return null;
  }
}

function requireAuth(req, env) {
  const c = parseBasicAuth(req);
  return !!(c && env.USERNAME && env.PASSWORD && c.user === env.USERNAME && c.pass === env.PASSWORD);
}

/// -------- 內建 HTML（前台 / 後台） --------
const CATALOG_HTML = `<!doctype html><html lang="zh-Hant">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pet Republic｜商品清單</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
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

  <div class="mt-6 flex gap-3">
    <button id="prev" class="rounded-lg border px-4 py-2">上一頁</button>
    <button id="next" class="rounded-lg border px-4 py-2">下一頁</button>
  </div>

  <pre id="debug" class="mt-6 hidden bg-gray-900 text-white p-3 rounded"></pre>
</main>

<script>
const state = { page: 1, size: 20, view: "card", q: "" };
const $ = (id)=>document.getElementById(id);
const cards = $("cards");

function render(items){
  cards.innerHTML = "";
  if(!items.length){
    cards.innerHTML = '<div class="text-gray-500">目前沒有資料</div>';
    return;
  }
  for(const p of items){
    const box = document.createElement("div");
    box.className = "rounded-xl bg-white shadow p-4 flex flex-col gap-2";
    const img = (p.images?.[0]) ? \`<img src="\${p.images[0]}" class="w-full aspect-video object-cover rounded-lg border"/>\` : "";
    box.innerHTML = \`
      \${img}
      <div class="text-sm text-gray-500">\${p.brand || "-"}｜\${p.category || "-"}</div>
      <div class="text-lg font-bold">\${p.sku}</div>
      <div class="text-base">\${p.name || ""}</div>
      <div class="text-sm text-gray-500">狀態：\${p.status || "-"}</div>
    \`;
    cards.appendChild(box);
  }
}

async function load(){
  const url = new URL("/api/products", location.origin);
  url.searchParams.set("page", state.page);
  url.searchParams.set("size", state.size);
  if(state.q) url.searchParams.set("q", state.q);
  const res = await fetch(url);
  const data = await res.json();
  render(data.items || []);
}

$("btnSearch").onclick = ()=>{ state.q = $("q").value.trim(); state.page = 1; load(); };
$("prev").onclick = ()=>{ if(state.page>1){ state.page--; load(); } };
$("next").onclick = ()=>{ state.page++; load(); };

load(); // 進頁就抓前 20 筆
</script>
</body></html>`;

const ADMIN_HTML = `<!doctype html><html lang="zh-Hant">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pet Republic｜後台</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800">
<header class="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
  <div class="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
    <h1 class="text-2xl font-extrabold">Pet Republic｜後台</h1>
    <div class="flex-1"></div>
    <a href="/" class="rounded-lg border px-4 py-2">回前台清單頁</a>
  </div>
</header>
<main class="max-w-5xl mx-auto px-4 py-6">
  <section class="bg-white rounded-2xl shadow border p-6">
    <h2 class="text-xl font-bold mb-2">Airtable 同步</h2>
    <p class="text-gray-600 mb-4">按下即可觸發一次匯入（僅管理員可用）。</p>
    <div class="flex items-center gap-3 mb-4">
      <input id="u" class="border rounded-lg px-3 py-2" placeholder="USERNAME（只存於本機）">
      <input id="p" type="password" class="border rounded-lg px-3 py-2" placeholder="PASSWORD（只存於本機）">
      <button id="go" class="rounded-lg bg-indigo-600 text-white px-4 py-2">開始同步</button>
    </div>
    <pre id="out" class="bg-gray-900 text-white p-4 rounded-lg overflow-auto"></pre>
  </section>
</main>
<script>
const $ = (id)=>document.getElementById(id);
const LS = {
  u: ()=>localStorage.getItem("admin_u")||"",
  p: ()=>localStorage.getItem("admin_p")||"",
  set(u,p){ localStorage.setItem("admin_u",u); localStorage.setItem("admin_p",p); }
};
$("u").value = LS.u(); $("p").value = LS.p();

$("go").onclick = async ()=>{
  const u = $("u").value.trim(), p = $("p").value;
  LS.set(u,p);
  const res = await fetch("/sync-airtable",{
    method:"POST",
    headers:{ "Authorization": "Basic " + btoa(u+":"+p) }
  });
  const data = await res.json().catch(()=>({ok:false,error:"非 JSON"}));
  $("out").textContent = JSON.stringify(data,null,2);
};
</script>
</body></html>`;

/// -------- Airtable 連線與對應 --------
const AT_API = "https://api.airtable.com/v0";
const AT_HEADERS = (env) => ({
  "Authorization": `Bearer ${env.AIRTABLE_API_TOKEN}`,
  "Content-Type": "application/json"
});
const AT_URL = (env) =>
  `${AT_API}/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME)}?pageSize=100`;

function mapAirtableToDb(rec) {
  const f = rec.fields || {};
  return {
    sku: f["商品貨號"] || "",
    name: f["產品名稱"] || "",
    brand: f["品牌名稱"] || "",
    category: f["類別"] || "",
    price: Number(f["建議售價"] || 0),
    barcode: f["國際條碼"] || "",
    en_name: f["英文品名"] || "",
    description: f["商品介紹"] || "",
    material: f["成份/材質"] || "",
    size: f["商品尺寸"] || "",
    weight_g: Number(f["重量g"] || 0),
    origin: f["產地"] || "",
    status: (f["現貨商品"] ? "active" : "draft"),
    images: (() => {
      const ATT = f["商品圖檔"];
      if (Array.isArray(ATT)) return ATT.map(a => a.url).filter(Boolean);
      if (typeof ATT === "string") return ATT.split(/[,;\n\r]+/).map(s=>s.trim()).filter(Boolean);
      return [];
    })()
  };
}

async function upsertProduct(env, db, p) {
  if (!p.sku) return;
  const exists = await db.prepare("SELECT sku FROM products WHERE sku = ?").bind(p.sku).first();
  if (exists) {
    await db.prepare(`
      UPDATE products SET
        name=?, brand=?, category=?, price=?, barcode=?, en_name=?,
        description=?, material=?, size=?, weight_g=?, origin=?, status=?, images_json=?
      WHERE sku=?
    `).bind(
      p.name, p.brand, p.category, p.price, p.barcode, p.en_name,
      p.description, p.material, p.size, p.weight_g, p.origin, p.status, JSON.stringify(p.images),
      p.sku
    ).run();
  } else {
    await db.prepare(`
      INSERT INTO products
        (sku, name, brand, category, price, barcode, en_name, description, material, size, weight_g, origin, status, images_json)
      VALUES
        (?,   ?,    ?,     ?,       ?,     ?,       ?,       ?,           ?,        ?,    ?,        ?,      ?,      ?)
    `).bind(
      p.sku, p.name, p.brand, p.category, p.price, p.barcode, p.en_name, p.description,
      p.material, p.size, p.weight_g, p.origin, p.status, JSON.stringify(p.images)
    ).run();
  }

  await db.prepare(`DELETE FROM images WHERE sku = ?`).bind(p.sku).run();
  for (const url of p.images) {
    await db.prepare(`INSERT INTO images (sku, filename, r2_key) VALUES (?, ?, ?)`)
      .bind(p.sku, url, url).run();
  }
}

async function syncFromAirtable(env, db) {
  let url = AT_URL(env);
  let total = 0;
  const seen = new Set();
  while (url) {
    const res = await fetch(url, { headers: AT_HEADERS(env) });
    if (!res.ok) throw new Error(\`Airtable fetch failed: \${res.status}\`);
    const data = await res.json();
    for (const r of (data.records || [])) {
      const p = mapAirtableToDb(r);
      if (!p.sku || seen.has(p.sku)) continue;
      await upsertProduct(env, db, p);
      seen.add(p.sku);
      total++;
    }
    url = data.offset ? \`\${AT_URL(env)}&offset=\${encodeURIComponent(data.offset)}\` : null;
  }
  return { total };
}

/// -------- 主處理（路由） --------
async function handleApi(env, db, req, url) {
  const { pathname, searchParams } = url;

  // 清單
  if (req.method === "GET" && pathname === "/api/products") {
    const page = Math.max(1, Number(searchParams.get("page") || "1"));
    const size = Math.min(100, Math.max(1, Number(searchParams.get("size") || "20")));
    const q = (searchParams.get("q") || "").trim();
    const brand = (searchParams.get("brand") || "").trim();
    const category = (searchParams.get("category") || "").trim();
    const status = (searchParams.get("status") || "").trim();

    const where = [];
    const binds = [];

    if (q) {
      where.push("(sku LIKE ? OR name LIKE ? OR barcode LIKE ?)");
      binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (brand) { where.push("brand = ?"); binds.push(brand); }
    if (category) { where.push("category = ?"); binds.push(category); }
    if (status) { where.push("status = ?"); binds.push(status); }

    const whereSql = where.length ? ("WHERE " + where.join(" AND ")) : "";
    const offset = (page - 1) * size;

    const list = await db.prepare(`
      SELECT sku, name, brand, category, status, price, images_json
      FROM products
      ${whereSql}
      ORDER BY sku ASC
      LIMIT ? OFFSET ?
    `).bind(...binds, size, offset).all();

    const items = (list.results || []).map(r => ({
      sku: r.sku,
      name: r.name,
      brand: r.brand,
      category: r.category,
      status: r.status,
      price: r.price,
      images: (()=>{ try { return JSON.parse(r.images_json||"[]"); } catch { return []; } })(),
    }));

    return json({ ok: true, page, size, items });
  }

  // 單一
  const m1 = pathname.match(/^\/api\/products\/([^\/]+)$/);
  if (req.method === "GET" && m1) {
    const sku = decodeURIComponent(m1[1]);
    const r = await db.prepare(`SELECT * FROM products WHERE sku = ?`).bind(sku).first();
    if (!r) return notFound();
    return json({
      ok: true,
      product: {
        ...r,
        images: (()=>{ try { return JSON.parse(r.images_json||"[]"); } catch{ return []; } })(),
      }
    });
  }

  // 該品圖片
  const m2 = pathname.match(/^\/api\/products\/([^\/]+)\/images$/);
  if (req.method === "GET" && m2) {
    const sku = decodeURIComponent(m2[1]);
    const rows = await db.prepare(`SELECT filename, r2_key FROM images WHERE sku = ? ORDER BY rowid ASC`).bind(sku).all();
    return json({ ok: true, sku, images: (rows.results || []).map(x => x.filename) });
  }

  // 健康檢查
  if (req.method === "GET" && pathname === "/api/debug/counts") {
    const p = await db.prepare("SELECT COUNT(*) AS n FROM products").first();
    const i = await db.prepare("SELECT COUNT(*) AS n FROM images").first();
    return json({ ok: true, products: p?.n || 0, images: i?.n || 0 });
  }

  return null; // 交由外層處理
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // 首頁與後台（內建 HTML）
    if (req.method === "GET" && url.pathname === "/") return html(CATALOG_HTML);
    if (url.pathname === "/admin") {
      if (!requireAuth(req, env)) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Basic realm=\"Admin\"" }});
      return html(ADMIN_HTML);
    }

    // API
    if (url.pathname.startsWith("/api/")) {
      const r = await handleApi(env, env.DATABASE, req, url);
      if (r) return r;
    }

    // 手動同步
    if (url.pathname === "/sync-airtable" && req.method === "POST") {
      if (!requireAuth(req, env)) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Basic realm=\"Admin\"" }});
      try {
        const { total } = await syncFromAirtable(env, env.DATABASE);
        return json({ ok: true, imported: total });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // 說明
    if (url.pathname === "/api") {
      return json({
        ok: true,
        name: "Pet Republic API",
        routes: {
          public: [
            "GET / -> catalog html",
            "GET /api/products -> list products",
            "GET /api/products/:sku -> get product",
            "GET /api/products/:sku/images -> product images",
            "GET /api/debug/counts -> products/images count"
          ],
          protected_basic_auth: [
            "GET /admin -> admin html",
            "POST /sync-airtable -> trigger import (Airtable)"
          ]
        }
      });
    }

    return notFound();
  },

  // Cron（wrangler.toml 的 triggers.crons 會呼叫這裡）
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await syncFromAirtable(env, env.DATABASE);
      } catch (e) {
        console.error("Cron sync error:", e);
      }
    })());
  }
};
