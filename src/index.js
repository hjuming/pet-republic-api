// src/index.js
// Pet Republic API (Cloudflare Workers) — Safe build version
// - R2: image storage
// - D1: metadata index
// - Admin UI & Catalog UI (no unescaped ${} in templates)
// - CSV export
//
// Required bindings in wrangler.toml:
// main = "src/index.js"
// [[r2_buckets]] binding="R2_BUCKET" bucket_name="my-images-bucket"
// [[d1_databases]] binding="DATABASE" database_name="image-db" migrations_dir="migrations"
// [vars] MAX_IMAGE_MB="20"
//
// Optional secrets (via wrangler secret put):
// AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, USERNAME, PASSWORD

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      // --- routes ---
      if (request.method === 'GET' && pathname === '/') {
        return jsonOK({ ok: true, name: 'pet-republic-api', time: new Date().toISOString() });
      }

      if (request.method === 'GET' && pathname === '/health') {
        return text('ok');
      }

      // HTML pages
      if (request.method === 'GET' && pathname === '/admin') {
        return htmlResponse(ADMIN_HTML);
      }
      if (request.method === 'GET' && pathname === '/catalog') {
        return htmlResponse(CATALOG_HTML);
      }

      // CSV export
      if (request.method === 'GET' && pathname === '/export.csv') {
        const rows = await listRows(env);
        const header = [
          'id','sku','filename','mime','size','r2_key','url','width','height','created_at'
        ];
        const toCsvCell = (v) => {
          const s = String(v ?? '');
          // Wrap in quotes and escape internal quotes by doubling them
          return '"' + s.replace(/"/g, '""') + '"';
        };
        const csv = [
          header.map(toCsvCell).join(','),
          ...rows.map(r => header.map(k => toCsvCell(r[k])).join(','))
        ].join('\n');
        return new Response(csv, {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="images_${Date.now()}.csv"`
          }
        });
      }

      // GET image (proxy) → /images/:key
      if (request.method === 'GET' && pathname.startsWith('/images/')) {
        const key = decodeURIComponent(pathname.slice('/images/'.length));
        if (!key) return notFound('missing key');
        const obj = await env.R2_BUCKET.get(key);
        if (!obj) return notFound('not found');
        return new Response(obj.body, {
          headers: {
            'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'cache-control': 'public, max-age=31536000, immutable',
            'etag': obj.httpEtag
          }
        });
      }

      // Upload (multipart/form-data)
      if (request.method === 'POST' && pathname === '/upload') {
        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('multipart/form-data')) {
          return badRequest('Content-Type must be multipart/form-data');
        }

        const form = await request.formData();
        const file = form.get('file');
        const sku  = (form.get('sku') || '').toString().trim();

        if (!file || typeof file === 'string') return badRequest('file missing');
        if (!sku) return badRequest('sku missing');

        const maxMB = Number(env.MAX_IMAGE_MB || '20');
        const maxBytes = maxMB * 1024 * 1024;
        if (file.size > maxBytes) {
          return badRequest(`file too large (>${maxMB}MB)`);
        }

        // derive key
        const ext = mimeToExt(file.type) || guessExt(file.name) || 'bin';
        const safeName = (file.name || `upload.${ext}`).replace(/[^\w.\-]/g, '_');
        const r2Key = `images/${sku}/${Date.now()}_${safeName}`;

        // upload to R2
        const put = await env.R2_BUCKET.put(r2Key, file.stream(), {
          httpMetadata: { contentType: file.type || 'application/octet-stream' }
        });

        // insert metadata to D1
        const urlPublic = url.origin + '/images/' + encodeURIComponent(r2Key);
        const nowISO = new Date().toISOString();
        const mime = file.type || '';
        const size = file.size;

        await env.DATABASE.prepare(
          `INSERT INTO images
           (sku, filename, mime, size, r2_key, url, width, height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          sku, safeName, mime, size, r2Key, urlPublic, null, null, nowISO
        ).run();

        return jsonOK({ ok: true, sku, key: r2Key, url: urlPublic, etag: put.httpEtag });
      }

      // List
      if (request.method === 'GET' && pathname === '/list') {
        const rows = await listRows(env, {
          sku: url.searchParams.get('sku') || undefined,
          limit: Number(url.searchParams.get('limit') || '50'),
          offset: Number(url.searchParams.get('offset') || '0')
        });
        return jsonOK({ ok: true, rows });
      }

      return notFound('route not found');
    } catch (err) {
      console.error(err);
      return jsonError(err);
    }
  }
};

// ========== helpers ==========
function text(s, status = 200, headers = {}) {
  return new Response(s, { status, headers: { 'content-type':'text/plain; charset=utf-8', ...headers }});
}
function htmlResponse(s, status = 200, headers = {}) {
  return new Response(s, { status, headers: { 'content-type':'text/html; charset=utf-8', ...headers }});
}
function jsonOK(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type':'application/json' }}); }
function jsonError(err, status = 500) {
  return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
    status, headers: { 'content-type':'application/json' }
  });
}
function badRequest(msg) { return new Response(JSON.stringify({ ok:false, error: msg }), { status: 400, headers: { 'content-type':'application/json' }}); }
function notFound(msg) { return new Response(JSON.stringify({ ok:false, error: msg }), { status: 404, headers: { 'content-type':'application/json' }}); }

function mimeToExt(m) {
  if (!m) return '';
  const map = {
    'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif','image/gif':'gif','image/svg+xml':'svg'
  };
  return map[m] || '';
}
function guessExt(name='') {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

async function listRows(env, opt={}) {
  const { sku, limit = 50, offset = 0 } = opt;
  if (sku) {
    const stmt = await env.DATABASE.prepare(
      `SELECT id, sku, filename, mime, size, r2_key, url, width, height, created_at
       FROM images WHERE sku = ? ORDER BY id DESC LIMIT ? OFFSET ?`
    ).bind(sku, limit, offset).all();
    return stmt.results || [];
  }
  const stmt = await env.DATABASE.prepare(
    `SELECT id, sku, filename, mime, size, r2_key, url, width, height, created_at
     FROM images ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  return stmt.results || [];
}

// ========== HTML (NO ${} interpolation inside) ==========
// 注意：以下模板使用 \${ 以避免被 JS 模板插值。
// 也避免在模板中放置未轉義的反引號或正則寫法，所有示例 JS 以純字串呈現。

const CATALOG_HTML = `
<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catalog</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>
  body{font-family:system-ui,-apple-system,"Noto Sans TC","Microsoft JhengHei",Arial,sans-serif;margin:0;background:#f7fafc;color:#1f2937}
  .wrap{max-width:1000px;margin:24px auto;padding:0 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .thumb{aspect-ratio:1/1;object-fit:cover;width:100%}
  header h1{font-size:20px;margin:0 0 8px}
  .bar{display:flex;gap:8px;margin:12px 0}
  input,button{padding:10px 12px;border:1px solid #d1d5db;border-radius:10px}
  button{background:#0d9488;color:#fff;border-color:#0d9488;cursor:pointer}
  button:hover{background:#0b7f75}
  .muted{color:#6b7280}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>📁 圖片目錄（Catalog）</h1>
      <div class="bar">
        <input id="sku" placeholder="輸入 SKU（可留空）">
        <button id="load">載入</button>
        <a id="csv" href="/export.csv"><button type="button">下載 CSV</button></a>
      </div>
      <p class="muted">此頁僅作為示範清單與下載 CSV。實際權限請以 Worker 驗證補強。</p>
    </header>
    <div id="list" class="grid"></div>
  </div>
<script>
(function(){
  const $ = (q) => document.querySelector(q);
  $('#load').addEventListener('click', async () => {
    const sku = $('#sku').value.trim();
    const url = '/list' + (sku ? ('?sku=' + encodeURIComponent(sku)) : '');
    const res = await fetch(url);
    const data = await res.json();
    const box = $('#list');
    box.innerHTML = '';
    (data.rows || []).forEach(r => {
      const el = document.createElement('div');
      el.className = 'card';
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = r.url;
      img.alt = r.filename || '';
      const cap = document.createElement('div');
      cap.style.padding = '10px 12px';
      cap.innerHTML = '<div><b>' + (r.sku||'') + '</b></div><div class="muted" style="font-size:12px">' + (r.filename||'') + '</div>';
      el.appendChild(img); el.appendChild(cap);
      box.appendChild(el);
    });
  });
})();
</script>
</body>
</html>
`;

const ADMIN_HTML = `
<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Upload</title>
<style>
  body{font-family:system-ui,-apple-system,"Noto Sans TC","Microsoft JhengHei",Arial,sans-serif;margin:0;background:#f7fafc;color:#1f2937}
  .wrap{max-width:720px;margin:24px auto;padding:0 16px}
  .panel{background:#fff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .pad{padding:16px}
  input,button{padding:10px 12px;border:1px solid #d1d5db;border-radius:10px}
  button{background:#0d9488;color:#fff;border-color:#0d9488;cursor:pointer}
  button:hover{background:#0b7f75}
  .row{display:flex;gap:8px;align-items:center;margin:8px 0}
  label{width:80px}
  .muted{color:#6b7280}
  pre{white-space:pre-wrap;word-break:break-all;background:#0b1020;color:#c8d3f5;border-radius:12px;padding:12px}
</style>
</head>
<body>
  <div class="wrap">
    <h1>🛠 圖片上傳（R2）</h1>
    <div class="panel">
      <div class="pad">
        <div class="row"><label>SKU</label><input id="sku" placeholder="例如 ABC-001"></div>
        <div class="row"><label>檔案</label><input id="file" type="file" accept="image/*"></div>
        <div class="row"><button id="go">上傳</button><a href="/catalog" target="_blank" style="margin-left:8px">查看 Catalog</a></div>
        <p class="muted">大小限制依 Worker 變數設定（MAX_IMAGE_MB）。</p>
        <pre id="log">等待操作…</pre>
      </div>
    </div>
  </div>
<script>
(function(){
  const $ = (q) => document.querySelector(q);
  $('#go').addEventListener('click', async () => {
    const sku = $('#sku').value.trim();
    const file = $('#file').files[0];
    const log = $('#log');
    if (!sku) { log.textContent = '請輸入 SKU'; return; }
    if (!file) { log.textContent = '請選擇檔案'; return; }

    const fd = new FormData();
    fd.append('sku', sku);
    fd.append('file', file);

    log.textContent = '上傳中…';
    try {
      const res = await fetch('/upload', { method:'POST', body: fd });
      const data = await res.json();
      log.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      log.textContent = '上傳失敗：' + String(e);
    }
  });
})();
</script>
</body>
</html>
`;
