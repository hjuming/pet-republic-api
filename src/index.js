// src/index.js
// Pet Republic API + Built-in Frontend (catalog at '/', admin at '/admin')

/* ===== Helper: Basic JSON Response ===== */
const j = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/* ===== Helper: Basic Auth (admin only) ===== */
function requireBasicAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Basic ")) return false;
  const [, b64] = auth.split(" ");
  try {
    const [u, p] = atob(b64).split(":");
    return u === env.USERNAME && p === env.PASSWORD;
  } catch {
    return false;
  }
}
const needAuth = () =>
  new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Pet Republic Admin"' },
  });

/* ===== HTML: Catalog (served at "/") ===== */
function renderCatalogHTML(origin) {
  return new Response(
    `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>商品清單｜Pet Republic</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js" crossorigin="anonymous"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js" crossorigin="anonymous"></script>
  <style>
    :root { color-scheme: light dark; }
    .thumb { width: 140px; height: 140px; object-fit: contain; background:#fff; }
    .chip{padding:.25rem .5rem;border-radius:9999px;font-size:.75rem}
    .line-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  </style>
</head>
<body class="bg-gray-50 text-gray-800">
  <header class="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
      <h1 class="text-lg font-bold">Pet Republic｜商品清單</h1>
      <div class="ml-auto flex items-center gap-2">
        <input id="q" class="w-64 md:w-96 rounded-lg border px-3 py-2" placeholder="輸入關鍵字或 SKU…" />
        <button id="btnSearch" class="px-3 py-2 rounded-lg bg-teal-600 text-white hover:bg-teal-700">搜尋</button>
        <button id="btnMode" class="px-3 py-2 rounded-lg border">切換：縮圖 / 列表</button>
        <button id="btnExportCSV" class="px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">匯出選取 CSV</button>
        <button id="btnExportZIP" class="px-3 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">打包圖片 ZIP</button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 py-6 grid grid-cols-12 gap-6">
    <!-- Filters -->
    <aside class="col-span-12 md:col-span-3 lg:col-span-3">
      <div class="bg-white rounded-xl shadow border p-4 space-y-4">
        <h2 class="font-semibold text-gray-700">快速篩選</h2>
        <div>
          <div class="text-xs text-gray-500 mb-1">品牌</div>
          <div id="brandList" class="flex flex-wrap gap-2"></div>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">類別</div>
          <div id="categoryList" class="flex flex-wrap gap-2"></div>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">狀態</div>
          <div class="flex gap-2 flex-wrap" id="statusList">
            <button data-k="status" data-v="" class="chip border">全部</button>
            <button data-k="status" data-v="active" class="chip border">active</button>
            <button data-k="status" data-v="draft" class="chip border">draft</button>
            <button data-k="status" data-v="archived" class="chip border">archived</button>
          </div>
        </div>
        <div class="text-xs text-gray-400">點擊晶片切換（可多選品牌/類別）</div>
      </div>
    </aside>

    <!-- List -->
    <section class="col-span-12 md:col-span-9 lg:col-span-9">
      <div id="resultInfo" class="text-sm text-gray-500 mb-3"></div>
      <div id="thumbGrid" class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4"></div>
      <table id="listTable" class="hidden w-full text-sm">
        <thead>
          <tr class="bg-gray-100">
            <th class="p-2"><input type="checkbox" id="checkAll"/></th>
            <th class="p-2">縮圖</th>
            <th class="p-2">SKU</th>
            <th class="p-2">品名</th>
            <th class="p-2">品牌</th>
            <th class="p-2">類別</th>
            <th class="p-2 text-right">售價</th>
            <th class="p-2">狀態</th>
          </tr>
        </thead>
        <tbody id="listBody"></tbody>
      </table>
      <div class="mt-6 flex items-center gap-2">
        <button id="prev" class="px-3 py-1.5 rounded border">上一頁</button>
        <button id="next" class="px-3 py-1.5 rounded border">下一頁</button>
        <span id="pageInfo" class="text-sm text-gray-500 ml-2"></span>
      </div>
    </section>
  </main>

  <template id="card-tpl">
    <label class="bg-white rounded-xl shadow border p-3 flex flex-col gap-2 cursor-pointer">
      <input type="checkbox" class="select hidden" />
      <img class="thumb rounded" src="" alt=""/>
      <div class="text-sm font-medium line-clamp-2 name"></div>
      <div class="text-xs text-gray-500">SKU：<span class="sku"></span></div>
      <div class="flex items-center gap-2 text-xs">
        <span class="chip border brand"></span>
        <span class="chip border category"></span>
      </div>
    </label>
  </template>

  <script>
    const API = "${origin}/api";
    const IMG = "${origin}";
    let page = 1, size = 24, mode = "thumb"; // thumb | list
    let brands = new Set(), cats = new Set();
    let status = "";
    let q = "";
    const selected = new Map(); // sku -> product

    const brandList = document.getElementById("brandList");
    const categoryList = document.getElementById("categoryList");
    const resultInfo = document.getElementById("resultInfo");
    const grid = document.getElementById("thumbGrid");
    const table = document.getElementById("listTable");
    const tbody = document.getElementById("listBody");
    const pageInfo = document.getElementById("pageInfo");
    const btnMode = document.getElementById("btnMode");

    document.getElementById("btnSearch").onclick = () => {
      q = document.getElementById("q").value.trim();
      page = 1; load();
    };
    document.getElementById("prev").onclick = ()=>{ if(page>1){page--; load();}};
    document.getElementById("next").onclick = ()=>{ page++; load(); };
    btnMode.onclick = () => {
      mode = mode === "thumb" ? "list" : "thumb";
      grid.classList.toggle("hidden", mode!=="thumb");
      table.classList.toggle("hidden", mode!=="list");
      load(true);
    };
    document.getElementById("checkAll").onchange = (e)=>{
      const on = e.target.checked;
      tbody.querySelectorAll('input[type="checkbox"]').forEach(cb=>{
        cb.checked = on; cb.dispatchEvent(new Event("change"));
      });
    };

    // chips click
    document.getElementById("statusList").addEventListener("click",(e)=>{
      const btn = e.target.closest("button"); if(!btn) return;
      status = btn.dataset.v;
      highlight(btn, "statusList");
      page=1; load();
    });

    function highlight(btn, wrapId){
      document.getElementById(wrapId).querySelectorAll("button").forEach(b=>{
        b.classList.toggle("bg-gray-900 text-white", b===btn && b.dataset.v!=="");
      });
    }

    function chip(k, v){
      const b = document.createElement("button");
      b.className = "chip border";
      b.textContent = v;
      b.dataset.k = k; b.dataset.v = v;
      b.onclick = ()=>{
        const set = k==="brand"?brands:cats;
        if (set.has(v)) set.delete(v); else set.add(v);
        b.classList.toggle("bg-gray-900"); b.classList.toggle("text-white");
        page=1; load();
      };
      return b;
    }

    async function load(onlyRender=false){
      // build query
      const params = new URLSearchParams({ page, size });
      if(q) params.set("q", q);
      if(status) params.set("status", status);
      if(brands.size) params.set("brand", Array.from(brands).join(","));
      if(cats.size) params.set("category", Array.from(cats).join(","));

      const res = await fetch(\`\${API}/products?\${params}\`);
      const data = await res.json();
      if(!data.ok){ resultInfo.textContent = "讀取失敗"; return; }

      // fill facets (首次或切頁都重抓)
      if(!onlyRender){
        brandList.innerHTML=""; categoryList.innerHTML="";
        (data.facets?.brands||[]).forEach(v=>brandList.appendChild(chip("brand", v)));
        (data.facets?.categories||[]).forEach(v=>categoryList.appendChild(chip("category", v)));
        // keep selected highlight
        brandList.querySelectorAll("button").forEach(b=>{
          if(brands.has(b.dataset.v)) b.classList.add("bg-gray-900","text-white");
        });
        categoryList.querySelectorAll("button").forEach(b=>{
          if(cats.has(b.dataset.v)) b.classList.add("bg-gray-900","text-white");
        });
      }

      resultInfo.textContent = \`共 \${data.total} 筆，當前 \${data.items.length} 筆\`;
      pageInfo.textContent = \`第 \${page} 頁\`;

      // render
      grid.innerHTML = ""; tbody.innerHTML="";
      for(const p of data.items){
        const cover = p.images?.[0]?.r2_key ? \`\${IMG}/\${p.images[0].r2_key}\` : "";
        if(mode==="thumb"){
          const t = document.getElementById("card-tpl").content.cloneNode(true);
          const card = t.querySelector("label");
          const cb = t.querySelector(".select");
          const img = t.querySelector("img"); img.src = cover || "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'/>"; img.alt = p.name||p.sku;
          t.querySelector(".name").textContent = p.name||"";
          t.querySelector(".sku").textContent = p.sku;
          t.querySelector(".brand").textContent = p.brand||"-";
          t.querySelector(".category").textContent = p.category||"-";
          cb.onchange = (e)=>{ if(e.target.checked) selected.set(p.sku, p); else selected.delete(p.sku); };
          card.addEventListener("click",(e)=>{ if(e.target.tagName!=="INPUT") { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }});
          grid.appendChild(t);
        }else{
          const tr = document.createElement("tr");
          tr.innerHTML = \`
            <td class="p-2 text-center"><input type="checkbox" class="rowCheck"/></td>
            <td class="p-2"><img class="thumb rounded" src="\${cover}" alt=""/></td>
            <td class="p-2 font-mono">\${p.sku}</td>
            <td class="p-2">\${p.name||""}</td>
            <td class="p-2">\${p.brand||"-"}</td>
            <td class="p-2">\${p.category||"-"}</td>
            <td class="p-2 text-right">\${(p.price??0)/100}</td>
            <td class="p-2">\${p.status}</td>\`;
          tr.querySelector(".rowCheck").onchange = (e)=>{ if(e.target.checked) selected.set(p.sku, p); else selected.delete(p.sku); };
          tbody.appendChild(tr);
        }
      }
    }

    // export CSV
    document.getElementById("btnExportCSV").onclick = ()=>{
      if(!selected.size){ alert("請先勾選商品"); return; }
      const cols = ["sku","name","brand","category","price","status"];
      const rows = [cols.join(",")];
      for(const p of selected.values()){
        rows.push(cols.map(k=>{
          let v = p[k] ?? "";
          if(k==="price") v = (v/100)||0;
          return \`\${(\\""+v).replace(/[\\\\n\\\\r,]/g," ")}\`;
        }).join(","));
      }
      const blob = new Blob([rows.join("\\n")], {type:"text/csv;charset=utf-8"});
      saveAs(blob, "products.csv");
    };

    // export ZIP (download first image by sku)
    document.getElementById("btnExportZIP").onclick = async ()=>{
      if(!selected.size){ alert("請先勾選商品"); return; }
      const zip = new JSZip();
      let count = 0;
      for(const p of selected.values()){
        const img = p.images?.[0]?.r2_key;
        if(!img) continue;
        const url = \`\${IMG}/\${img}\`;
        try{
          const ab = await (await fetch(url)).arrayBuffer();
          const ext = img.split(".").pop()||"jpg";
          zip.file(\`\${p.sku}.\${ext}\`, ab);
          count++;
        }catch(e){}
      }
      if(!count){ alert("選取商品沒有可下載的首圖"); return; }
      const blob = await zip.generateAsync({type:"blob"});
      saveAs(blob, "images.zip");
    };

    // init
    load();
  </script>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

/* ===== HTML: Admin (served at "/admin", Basic Auth) ===== */
function renderAdminHTML(origin) {
  return new Response(
    `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>後台｜Pet Republic</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800">
  <div class="max-w-3xl mx-auto p-6 space-y-6">
    <h1 class="text-xl font-bold">Pet Republic｜後台</h1>
    <div class="bg-white rounded-xl shadow border p-4 space-y-3">
      <h2 class="font-semibold">Airtable 同步</h2>
      <p class="text-sm text-gray-500">按下即可觸發一次匯入（僅管理員可用）。</p>
      <button id="btnSync" class="px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">開始同步</button>
      <pre id="log" class="mt-3 text-xs bg-gray-900 text-gray-100 p-3 rounded"></pre>
    </div>
    <a class="text-teal-700 underline" href="/">回前台清單頁</a>
  </div>

  <script>
    const log = (t)=>document.getElementById("log").textContent = t;
    document.getElementById("btnSync").onclick = async ()=>{
      log("同步中…");
      const r = await fetch("${origin}/sync-airtable", { method:"POST" });
      const j = await r.json().catch(()=>({}));
      log(JSON.stringify(j, null, 2));
    };
  </script>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

/* ===== Worker API ===== */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams, origin } = url;

    // CORS for API/Images
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    const cors = (res) => {
      res.headers.set("Access-Control-Allow-Origin", "*");
      return res;
    };

    /* ---- 1) Public pages ---- */
    if (request.method === "GET" && pathname === "/") {
      return renderCatalogHTML(origin);
    }
    if (request.method === "GET" && pathname === "/admin") {
      if (!requireBasicAuth(request, env)) return needAuth();
      return renderAdminHTML(origin);
    }

    /* ---- 2) Public image passthrough: /{sku}/{filename} -> R2 object ---- */
    const parts = pathname.split("/").filter(Boolean);
    if (request.method === "GET" && parts.length === 2) {
      const [sku, filename] = parts;
      const key = `${sku}/${filename}`;
      const obj = await env.R2_BUCKET.get(key);
      if (!obj) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      return cors(new Response(obj.body, { headers }));
    }

    /* ---- 3) API: GET /api/products (list with facets/pagination) ---- */
    if (request.method === "GET" && pathname === "/api/products") {
      const q = (searchParams.get("q") || "").trim();
      const brand = (searchParams.get("brand") || "").trim();
      const category = (searchParams.get("category") || "").trim();
      const status = (searchParams.get("status") || "").trim();
      const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
      const size = Math.min(50, Math.max(1, parseInt(searchParams.get("size") || "24", 10)));

      const where = [];
      const params = [];

      if (q) {
        where.push("(sku LIKE ? OR name LIKE ?)");
        params.push(`%${q}%`, `%${q}%`);
      }
      if (brand) {
        const arr = brand.split(",").map((v) => v.trim()).filter(Boolean);
        if (arr.length) {
          where.push(\`(\${arr.map(()=> "brand = ?").join(" OR ")})\`);
          params.push(...arr);
        }
      }
      if (category) {
        const arr = category.split(",").map((v) => v.trim()).filter(Boolean);
        if (arr.length) {
          where.push(\`(\${arr.map(()=> "category = ?").join(" OR ")})\`);
          params.push(...arr);
        }
      }
      if (status) {
        where.push("status = ?");
        params.push(status);
      }

      const whereSql = where.length ? \`WHERE \${where.join(" AND ")}\` : "";
      const offset = (page - 1) * size;

      const totalRow = await env.DATABASE.prepare(\`SELECT COUNT(*) as c FROM products \${whereSql}\`).bind(...params).first();
      const total = totalRow?.c ?? 0;

      const rows = await env.DATABASE.prepare(
        \`SELECT id, sku, name, brand, category, price, status
           FROM products \${whereSql}
           ORDER BY updated_at DESC
           LIMIT ? OFFSET ?\`
      ).bind(...params, size, offset).all();

      // images for listed skus
      const skus = rows.results.map(r => r.sku);
      let imagesBySku = {};
      if (skus.length) {
        const placeholders = skus.map(() => "?").join(",");
        const picRows = await env.DATABASE.prepare(
          \`SELECT sku, filename, r2_key, alt, sort FROM product_images
            WHERE sku IN (\${placeholders}) ORDER BY sort ASC, id ASC\`
        ).bind(...skus).all();
        imagesBySku = (picRows.results || []).reduce((acc, r) => {
          (acc[r.sku] ||= []).push(r);
          return acc;
        }, {});
      }

      // facets
      const brands = await env.DATABASE.prepare(`SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand!='' ORDER BY brand`).all();
      const categories = await env.DATABASE.prepare(`SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category!='' ORDER BY category`).all();

      const items = rows.results.map(r => ({ ...r, images: imagesBySku[r.sku] || [] }));
      return cors(j({ ok: true, items, total, page, size, facets: {
        brands: (brands.results||[]).map(x=>x.brand),
        categories: (categories.results||[]).map(x=>x.category),
      }}));
    }

    /* ---- 4) API: GET /api/products/:sku ---- */
    if (request.method === "GET" && /^\/api\/products\/[^/]+$/.test(pathname)) {
      const sku = decodeURIComponent(pathname.split("/").pop());
      const prod = await env.DATABASE.prepare(
        `SELECT id, sku, name, brand, category, price, compare_at_price, status, stock, short_desc, description, specs, tags
           FROM products WHERE sku = ?`
      ).bind(sku).first();
      if (!prod) return cors(j({ ok: false, error: "Not Found" }, 404));
      const pics = await env.DATABASE.prepare(
        `SELECT id, filename, r2_key, alt, sort FROM product_images WHERE sku=? ORDER BY sort ASC, id ASC`
      ).bind(sku).all();
      return cors(j({ ok: true, product: { ...prod, images: pics.results || [] } }));
    }

    /* ---- 5) API: GET /api/products/:sku/images ---- */
    if (request.method === "GET" && /^\/api\/products\/[^/]+\/images$/.test(pathname)) {
      const sku = decodeURIComponent(pathname.split("/")[3]);
      const pics = await env.DATABASE.prepare(
        `SELECT id, filename, r2_key, alt, sort FROM product_images WHERE sku=? ORDER BY sort ASC, id ASC`
      ).bind(sku).all();
      return cors(j({ ok: true, items: pics.results || [] }));
    }

    /* ---- 6) Protected write APIs ---- */
    const isProtected =
      pathname === "/sync-airtable" ||
      (pathname.startsWith("/api/") && request.method !== "GET");

    if (isProtected) {
      if (!requireBasicAuth(request, env)) return needAuth();
    }

    // POST /sync-airtable
    if (request.method === "POST" && pathname === "/sync-airtable") {
      // NOTE: 此處僅回覆啟動訊息；實際同步程式你已在先前版本加入。
      // 這裡簡化為 queue 任務 / 或直接返回提示。
      return j({
        ok: true,
        message:
          "已接收同步請求。請留意 D1 儀表板查詢數與 logs（此示範版回覆成功，不執行真實抓取）。",
      });
    }

    // POST /api/products  (create)
    if (request.method === "POST" && pathname === "/api/products") {
      const body = await request.json().catch(() => ({}));
      const {
        sku, name, brand, category,
        price = 0, compare_at_price = null,
        status = "active", stock = 0,
        short_desc = "", description = "", specs = null, tags = null,
      } = body;

      if (!sku || !name) return j({ ok: false, error: "sku & name required" }, 400);

      await env.DATABASE.prepare(
        `INSERT INTO products (sku,name,brand,category,price,compare_at_price,status,stock,short_desc,description,specs,tags)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        sku, name, brand||null, category||null, price|0, compare_at_price,
        status, stock|0, short_desc, description, specs ? JSON.stringify(specs): null, tags
      ).run();

      return j({ ok: true, sku });
    }

    // PUT /api/products/:sku  (update)
    if (request.method === "PUT" && /^\/api\/products\/[^/]+$/.test(pathname)) {
      const sku = decodeURIComponent(pathname.split("/").pop());
      const body = await request.json().catch(()=> ({}));
      const fields = ["name","brand","category","price","compare_at_price","status","stock","short_desc","description","specs","tags"];
      const sets = [];
      const params = [];
      for (const k of fields) {
        if (k in body) {
          sets.push(\`\${k} = ?\`);
          params.push(k==="specs" && body[k]!=null ? JSON.stringify(body[k]) : body[k]);
        }
      }
      if (!sets.length) return j({ ok:false, error:"no fields" }, 400);
      params.push(sku);
      await env.DATABASE.prepare(\`UPDATE products SET \${sets.join(", ")} WHERE sku = ?\`).bind(...params).run();
      return j({ ok:true, sku });
    }

    // DELETE /api/products/:sku
    if (request.method === "DELETE" && /^\/api\/products\/[^/]+$/.test(pathname)) {
      const sku = decodeURIComponent(pathname.split("/").pop());
      await env.DATABASE.prepare(`DELETE FROM product_images WHERE sku=?`).bind(sku).run();
      await env.DATABASE.prepare(`DELETE FROM products WHERE sku=?`).bind(sku).run();
      return j({ ok:true });
    }

    // POST /api/products/:sku/images  (add image record)
    if (request.method === "POST" && /^\/api\/products\/[^/]+\/images$/.test(pathname)) {
      const sku = decodeURIComponent(pathname.split("/")[3]);
      const { filename, r2_key, alt = "", sort = 0 } = await request.json().catch(()=> ({}));
      if (!filename || !r2_key) return j({ ok:false, error:"filename & r2_key required" }, 400);
      await env.DATABASE.prepare(
        `INSERT OR IGNORE INTO product_images (sku, filename, r2_key, alt, sort) VALUES (?,?,?,?,?)`
      ).bind(sku, filename, r2_key, alt, sort|0).run();
      return j({ ok:true });
    }

    // DELETE /api/products/:sku/images/:filename
    if (request.method === "DELETE" && /^\/api\/products\/[^/]+\/images\/.+$/.test(pathname)) {
      const [, , , sku, , filename] = pathname.split("/");
      await env.DATABASE.prepare(
        `DELETE FROM product_images WHERE sku=? AND filename=?`
      ).bind(decodeURIComponent(sku), decodeURIComponent(filename)).run();
      return j({ ok:true });
    }

    /* ---- Fallback: API index/help ---- */
    if (request.method === "GET" && pathname === "/api") {
      return j({
        ok: true,
        name: "Pet Republic API",
        routes: {
          public: [
            "GET / -> catalog html",
            "GET /{sku}/{filename} -> public image (R2)",
            "GET /api/products -> list products",
            "GET /api/products/:sku -> get product",
            "GET /api/products/:sku/images -> product images",
          ],
          protected_basic_auth: [
            "GET /admin -> admin html",
            "POST /api/products -> create",
            "PUT /api/products/:sku -> update",
            "DELETE /api/products/:sku -> delete",
            "POST /api/products/:sku/images -> add image record",
            "DELETE /api/products/:sku/images/:filename -> delete image record",
            "POST /sync-airtable -> trigger import (placeholder)",
          ],
        },
      });
    }

    return j({ ok: false, error: "Not Found" }, 404);
  },
};
