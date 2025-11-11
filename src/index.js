/* * =================================================================
 * == 寵兒共和國-商品圖庫管理系統 v3.1 (Cron Trigger 版) ==
 * * =================================================================
 * 1. fetch()
 * - /sync-airtable: 從 Airtable 抓取「資料」存入 D1
 * - /: 顯示一個簡單的管理頁面
 * - /SKU/image.jpg: 處理 R2 圖片請求
 * 2. scheduled() (由 Cron 觸發)
 * - 在背景從 D1 讀取未下載的圖片，下載並存入 R2
 * =================================================================
 */

// ❗️❗️ 動作：請將這兩個值換成你 Airtable 上的資訊 ❗️❗️
const AIRTABLE_BASE_ID = "appXXXXXXXXXXXXXX"; // 你的 Base ID (app... 開頭)
const AIRTABLE_TABLE_NAME = "商品資料"; // 你的 Table Name (例如 "商品資料")
// ❗️❗️ 動作：請將這兩個值換成你 Airtable 上的資訊 ❗️❗️


export default {
  /**
   * 1. 處理 HTTP 請求 (瀏覽器)
   */
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    
    // --- 簡易認證 ---
    if (pathname.startsWith('/sync-airtable')) {
      if (!authenticate(request, env.USERNAME, env.PASSWORD)) {
         return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Admin"' } });
      }
    }

    // --- 路由 ---
    switch (pathname) {
      
      // 觸發同步
      case '/sync-airtable':
        // 立即回覆瀏覽器，並將 "syncFromAirtable" 任務丟到背景執行
        ctx.waitUntil(syncFromAirtable(env));
        return new Response(
          `✅ 收到請求！<br><br>系統正在背景從 Airtable 同步 1000+ 筆**商品資料**到 D1。<br>這可能需要 1-2 分鐘。<br><br>資料同步完成後，Cron Trigger 將會**自動**在背景開始批次下載**圖片**。<br><br>您可以關閉此頁面。`, 
          { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
        );

      // 圖片請求
      default:
        // 檢查是否是圖片路徑 (例如 /SKU/image.jpg)
        if (pathname.length > 1 && (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg') || pathname.endsWith('.png') || pathname.endsWith('.webp'))) {
          return await handleImageRequest(request, env.R2_BUCKET);
        }
        
        // 首頁
        return new Response(
          `<h1>寵兒共和國 API 系統 (v3.1 Cron)</h1><a href="/sync-airtable">點此開始同步 Airtable</a><p><small>(注意：這需要密碼)</small></p>`,
          { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
        );
    }
  },

  /**
   * 2. 處理 Cron Trigger 任務 (在背景執行)
   */
  async scheduled(controller, env, ctx) {
    // 每次 Cron 執行，處理 10 筆尚未同步的圖片
    const BATCH_SIZE = 10;
    
    try {
      // 1. 從 D1 抓出 10 筆「尚未同步」的商品
      const { results } = await env.DATABASE.prepare(
        "SELECT sku, image_file, airtable_image_url FROM products WHERE airtable_image_url IS NOT NULL AND image_synced = 'N' LIMIT ?"
      ).bind(BATCH_SIZE).all();

      if (!results || results.length === 0) {
        console.log("Cron: No images waiting for sync.");
        return; // 沒事做，結束
      }

      console.log(`Cron: Found ${results.length} images to sync.`);
      const d1UpdateStatements = [];

      for (const product of results) {
        const { sku, image_file, airtable_image_url } = product;
        const r2Key = `${sku}/${image_file}`; // 最終 R2 路徑

        try {
          // 2. 檢查 R2 上是否已存在
          const existing = await env.R2_BUCKET.head(r2Key);
          if (existing) {
            console.log(`Cron: Image already exists, skipping: ${r2Key}`);
          } else {
            // 3. 從 Airtable URL 下載圖片
            const response = await fetch(airtable_image_url, {
              headers: { 'User-Agent': 'Cloudflare-Worker-Image-Importer' }
            });
            
            if (!response.ok) {
              throw new Error(`Failed to fetch image: ${response.status} from ${airtable_image_url}`);
            }
            
            // 4. 將圖片存入 R2
            await env.R2_BUCKET.put(r2Key, response.body, {
              httpMetadata: response.headers, 
            });
            console.log(`Cron: Successfully imported image to ${r2Key}`);
          }

          // 5. 準備 D1 更新 (無論是否已存在，都標記為完成)
          d1UpdateStatements.push(
            env.DATABASE.prepare("UPDATE products SET image_synced = 'Y' WHERE sku = ?").bind(sku)
          );

        } catch (err) {
          console.error(`Cron: Failed to import image for SKU ${sku}: ${err.message}`);
          // 標記為失敗，稍後重試
          d1UpdateStatements.push(
            env.DATABASE.prepare("UPDATE products SET image_synced = 'F' WHERE sku = ?").bind(sku)
          );
        }
      }
      
      // 6. 批次更新 D1 狀態
      if (d1UpdateStatements.length > 0) {
        await env.DATABASE.batch(d1UpdateStatements);
      }
      
    } catch (e) {
      console.error(`Cron: Error in scheduled handler: ${e.message}`);
    }
  }
}; // --- export default 結束 ---

    
/**
 * [核心功能] 同步 Airtable 資料到 D1
 * (由 /sync-airtable 觸發)
 */
async function syncFromAirtable(env) {
  const { DATABASE, AIRTABLE_API_TOKEN } = env;
  const airtableApiUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`;

  let allRecords = [];
  let offset = null;

  try {
    console.log("Starting Airtable sync...");

    // 1. 分頁抓取所有 Airtable 資料
    do {
      const url = new URL(airtableApiUrl);
      if (offset) {
        url.searchParams.set('offset', offset);
      }
      
      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_TOKEN}`
        }
      });

      if (!response.ok) {
        throw new Error(`Airtable API error: ${response.status} ${await response.text()}`);
      }

      const data = await response.json();
      allRecords.push(...data.records);
      offset = data.offset;

    } while (offset);
    
    console.log(`Fetched ${allRecords.length} records from Airtable.`);
    if (allRecords.length === 0) return;

    // 2. 準備 D1 批次匯入
    const d1Statements = [];
    
    const sql = `
      INSERT INTO products (
        sku, title, title_en, brand, category, description, materials, 
        image_file, airtable_image_url, case_pack_size, msrp, barcode, 
        dimensions_cm, weight_g, origin, in_stock,
        image_synced -- [新] 設為 N，讓 Cron 去抓
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'N')
      ON CONFLICT(sku) DO UPDATE SET
        title=excluded.title, title_en=excluded.title_en, brand=excluded.brand,
        category=excluded.category, description=excluded.description, materials=excluded.materials,
        image_file=excluded.image_file, airtable_image_url=excluded.airtable_image_url,
        case_pack_size=excluded.case_pack_size, msrp=excluded.msrp, barcode=excluded.barcode,
        dimensions_cm=excluded.dimensions_cm, weight_g=excluded.weight_g,
        origin=excluded.origin, in_stock=excluded.in_stock,
        image_synced='N'; -- [新] 如果資料更新，也重設為 N，重新抓圖
    `;

    for (const record of allRecords) {
      const fields = record.fields;
      const cleaned = cleanAirtableRecord(fields); // 清理資料
      
      if (!cleaned.sku) continue; // 必須要有 SKU

      // 準備 D1 資料
      d1Statements.push(DATABASE.prepare(sql).bind(
        cleaned.sku, cleaned.title, cleaned.title_en, cleaned.brand, cleaned.category,
        cleaned.description, cleaned.materials, cleaned.image_file, cleaned.airtable_image_url,
        cleaned.case_pack_size, cleaned.msrp, cleaned.barcode, cleaned.dimensions_cm,
        cleaned.weight_g, cleaned.origin, cleaned.in_stock
      ));
    }

    // 3. 執行 D1 批次寫入
    if (d1Statements.length > 0) {
      console.log(`Writing ${d1Statements.length} records to D1...`);
      // D1 批次有大小限制，我們每 100 筆執行一次
      const batchSize = 100;
      for (let i = 0; i < d1Statements.length; i += batchSize) {
        const batch = d1Statements.slice(i, i + batchSize);
        await DATABASE.batch(batch);
        console.log(`Wrote batch ${i} to D1...`);
      }
      console.log("D1 sync complete.");
    }

  } catch (err) {
    console.error("Error during Airtable sync:", err.message);
  }
}

/**
 * [輔助] 清理 Airtable 資料 (和 v3.0 一樣)
 */
function cleanAirtableRecord(fields) {
  let image_file = null;
  let airtable_image_url = null;
  if (fields['商品圖檔']) {
    const regex = /([\w.-]+\.(jpg|jpeg|png|webp))\s*\((https?:\/\/[^)]+)\)/i;
    const match = String(fields['商品圖檔']).match(regex);
    if (match) {
      image_file = match[1].replace(/\s+/g, '_'); // 清理檔名中的空格
      airtable_image_url = match[3];
    }
  }

  return {
    sku: fields['商品貨號'] || null,
    title: fields['產品名稱'] || null,
    title_en: fields['英文品名'] || null,
    brand: fields['品牌名稱'] || null,
    category: fields['類別'] || null,
    description: fields['商品介紹'] || null,
    materials: fields['成份/材質'] || null,
    image_file: image_file,
    airtable_image_url: airtable_image_url,
    case_pack_size: parseInt(fields['箱入數'], 10) || null,
    msrp: parseFloat(String(fields['建議售價']).replace(/[$,]/g, '')) || null,
    barcode: fields['國際條碼'] || null,
    dimensions_cm: fields['商品尺寸'] || null, 
    weight_g: parseFloat(String(fields['重量g']).replace('g', '')) || null,
    origin: fields['產地'] || null,
    in_stock: (fields['現貨商品'] === '是' || fields['現貨商品'] === 'Y') ? 'Y' : 'N'
  };
}

/**
 * [輔助] 處理圖片請求 (和 v3.0 一樣)
 */
async function handleImageRequest(request, R2_BUCKET) {
  const { pathname } = new URL(request.url);
  const r2Key = pathname.substring(1); // 移除開頭的 /

  try {
    const object = await R2_BUCKET.get(r2Key);
    if (!object) {
      return new Response('Image not found', { status: 404 });
    }
    
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Content-Disposition', 'inline');
    return new Response(object.body, { headers });
    
  } catch (e) {
     return new Response(`Error fetching image: ${e.message}`, { status: 500 });
  }
}

/**
 * [輔助] 認證 (和 v3.0 一樣)
 */
function authenticate(request, USERNAME, PASSWORD) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = atob(base64Credentials).split(':');
    return credentials[0] === USERNAME && credentials[1] === PASSWORD;
  } catch (e) {
    return false;
  }
}
