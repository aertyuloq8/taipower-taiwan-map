/**
 * 全台灣電桿 PMTiles 向量圖磚烘焙腳本 (記憶體優化版)
 * 1. 使用單一 GeoJSONVT 索引同時處理 Zoom 13 & 14 (100% 電桿)
 * 2. 釋放記憶體後，再處理 Zoom 10..12 (採樣降載)
 * 3. 寫入 SQLite MBTiles 資料庫
 * 4. 呼叫 go-pmtiles 轉檔為 taiwan_poles.pmtiles
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const gvt = require('geojson-vt');
const GeoJSONVT = typeof gvt === 'function' ? gvt : gvt.default;
const vtpbf = require('vt-pbf');

const ROOT = path.resolve(__dirname, '..');
const GEOJSON_SEQ = path.join(ROOT, 'data', 'processed', 'taiwan_poles.geojsonseq');
const MBTILES_PATH = path.join(ROOT, 'data', 'taiwan_poles.mbtiles');
const PMTILES_PATH = path.join(ROOT, 'data', 'taiwan_poles.pmtiles');
const PMTILES_EXE = path.join(__dirname, 'pmtiles_bin', 'pmtiles.exe');

function lng2tile(lng, zoom) {
  return Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
}
function lat2tile(lat, zoom) {
  const rad = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom));
}

async function main() {
  console.log('=== 開始烘焙全台灣 PMTiles 向量圖磚 (記憶體優化版) ===');
  const t0 = Date.now();

  if (!fs.existsSync(GEOJSON_SEQ)) {
    console.error('找不到輸入檔:', GEOJSON_SEQ);
    process.exit(1);
  }

  // 1. 初始化 MBTiles 資料庫
  if (fs.existsSync(MBTILES_PATH)) fs.unlinkSync(MBTILES_PATH);
  if (fs.existsSync(PMTILES_PATH)) fs.unlinkSync(PMTILES_PATH);

  const db = new Database(MBTILES_PATH);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -100000'); // 100MB cache

  db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
  `);

  const insertMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  insertMeta.run('name', 'taipower_taiwan_poles');
  insertMeta.run('format', 'pbf');
  insertMeta.run('minzoom', '10');
  insertMeta.run('maxzoom', '14');
  insertMeta.run('bounds', '119.0,21.5,122.5,26.5');
  insertMeta.run('center', '120.7,23.8,12');
  insertMeta.run('type', 'overlay');
  insertMeta.run('version', '2');
  insertMeta.run('description', '台電全台灣 296 萬筆電桿開放資料 (Dataset 33305)');
  insertMeta.run('json', JSON.stringify({
    vector_layers: [
      {
        id: 'poles',
        description: '台電電桿',
        minzoom: 10,
        maxzoom: 14,
        fields: {
          name: 'String',
          code: 'String',
          city: 'String',
          area: 'String',
          type: 'String',
          id: 'Number'
        }
      }
    ]
  }));

  const insertTile = db.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)');
  const insertBatch = db.transaction((tiles) => {
    for (const t of tiles) {
      const tmsY = (1 << t.z) - 1 - t.y;
      insertTile.run(t.z, t.x, tmsY, t.data);
    }
  });

  let totalWrittenTiles = 0;
  let batchBuffer = [];

  function flushBatch() {
    if (batchBuffer.length > 0) {
      insertBatch(batchBuffer);
      totalWrittenTiles += batchBuffer.length;
      batchBuffer = [];
    }
  }

  // 2. 第一階段：載入全量電桿並處理 Zoom 13 & 14 (100% 完整資料)
  console.log('\n[階段 1/2] 讀取全台 296 萬筆電桿資料...');
  let fullFeatures = [];
  const z14Keys = new Set();
  const z13Keys = new Set();

  const rl = readline.createInterface({
    input: fs.createReadStream(GEOJSON_SEQ, 'utf8'),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line) continue;
    const f = JSON.parse(line);
    const [lng, lat] = f.geometry.coordinates;

    fullFeatures.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        name: f.properties.name || '',
        code: f.properties.code || '',
        city: f.properties.city || '',
        area: f.properties.area || '',
        type: f.properties.type || '',
        id: f.properties.id
      }
    });

    z14Keys.add(lng2tile(lng, 14) + ',' + lat2tile(lat, 14));
    z13Keys.add(lng2tile(lng, 13) + ',' + lat2tile(lat, 13));
  }

  console.log(`載入完成：${fullFeatures.length.toLocaleString()} 筆電桿，耗時 ${((Date.now() - t0)/1000).toFixed(1)}s`);
  console.log(`即將產出圖磚：z14=${z14Keys.size}, z13=${z13Keys.size}`);

  console.log('建立 GeoJSONVT 索引 (z13-z14)...');
  const tIdx1 = Date.now();
  let index13_14 = new GeoJSONVT({ type: 'FeatureCollection', features: fullFeatures }, {
    minZoom: 13,
    maxZoom: 14,
    indexMaxZoom: 14,
    indexMaxPoints: 100000,
    tolerance: 2,
    extent: 4096,
    buffer: 64
  });
  console.log(`索引完成，耗時 ${((Date.now() - tIdx1)/1000).toFixed(1)}s`);

  // 產出 Zoom 14
  console.log('正在產出 Zoom 14 圖磚...');
  const tZ14 = Date.now();
  for (const k of z14Keys) {
    const [x, y] = k.split(',').map(Number);
    const tile = index13_14.getTile(14, x, y);
    if (!tile || !tile.features || tile.features.length === 0) continue;
    const pbf = vtpbf.fromGeojsonVt({ poles: tile });
    const compressed = zlib.gzipSync(pbf);
    batchBuffer.push({ z: 14, x, y, data: compressed });
    if (batchBuffer.length >= 500) flushBatch();
  }
  flushBatch();
  console.log(`Zoom 14 完成 (${z14Keys.size} 圖磚)，耗時 ${((Date.now() - tZ14)/1000).toFixed(1)}s`);

  // 產出 Zoom 13
  console.log('正在產出 Zoom 13 圖磚...');
  const tZ13 = Date.now();
  for (const k of z13Keys) {
    const [x, y] = k.split(',').map(Number);
    const tile = index13_14.getTile(13, x, y);
    if (!tile || !tile.features || tile.features.length === 0) continue;
    const pbf = vtpbf.fromGeojsonVt({ poles: tile });
    const compressed = zlib.gzipSync(pbf);
    batchBuffer.push({ z: 13, x, y, data: compressed });
    if (batchBuffer.length >= 500) flushBatch();
  }
  flushBatch();
  console.log(`Zoom 13 完成 (${z13Keys.size} 圖磚)，耗時 ${((Date.now() - tZ13)/1000).toFixed(1)}s`);

  // 關鍵步驟：主動銷毀大物件並觸發垃圾回收
  console.log('\n釋放全量索引記憶體...');
  index13_14 = null;
  fullFeatures = null;
  if (global.gc) global.gc();

  // 3. 第二階段：串流採樣產生 Zoom 10..12 (降載優化)
  console.log('\n[階段 2/2] 串流採樣並產生 Zoom 10..12 圖磚...');
  const sampleFeatures = [];
  const z12Keys = new Set();
  const z11Keys = new Set();
  const z10Keys = new Set();

  const rl2 = readline.createInterface({
    input: fs.createReadStream(GEOJSON_SEQ, 'utf8'),
    crlfDelay: Infinity
  });

  let sampleIdx = 0;
  for await (const line of rl2) {
    if (!line) continue;
    sampleIdx++;
    // 採樣 25% (1/4) 用於 z10..z12
    if (sampleIdx % 4 !== 0) continue;

    const f = JSON.parse(line);
    const [lng, lat] = f.geometry.coordinates;

    sampleFeatures.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        name: f.properties.name || '',
        code: f.properties.code || '',
        city: f.properties.city || '',
        area: f.properties.area || ''
      }
    });

    z12Keys.add(lng2tile(lng, 12) + ',' + lat2tile(lat, 12));
    z11Keys.add(lng2tile(lng, 11) + ',' + lat2tile(lat, 11));
    z10Keys.add(lng2tile(lng, 10) + ',' + lat2tile(lat, 10));
  }

  console.log(`採樣完成：${sampleFeatures.length.toLocaleString()} 筆電桿 (25% 採樣率)`);
  console.log(`即將產出圖磚：z12=${z12Keys.size}, z11=${z11Keys.size}, z10=${z10Keys.size}`);

  const index10_12 = new GeoJSONVT({ type: 'FeatureCollection', features: sampleFeatures }, {
    minZoom: 10,
    maxZoom: 12,
    indexMaxZoom: 12,
    indexMaxPoints: 50000,
    tolerance: 4,
    extent: 4096,
    buffer: 64
  });

  // Zoom 12
  for (const k of z12Keys) {
    const [x, y] = k.split(',').map(Number);
    const tile = index10_12.getTile(12, x, y);
    if (!tile || !tile.features || tile.features.length === 0) continue;
    const pbf = vtpbf.fromGeojsonVt({ poles: tile });
    const compressed = zlib.gzipSync(pbf);
    batchBuffer.push({ z: 12, x, y, data: compressed });
    if (batchBuffer.length >= 500) flushBatch();
  }
  flushBatch();
  console.log(`Zoom 12 完成 (${z12Keys.size} 圖磚)`);

  // Zoom 11
  for (const k of z11Keys) {
    const [x, y] = k.split(',').map(Number);
    const tile = index10_12.getTile(11, x, y);
    if (!tile || !tile.features || tile.features.length === 0) continue;
    const pbf = vtpbf.fromGeojsonVt({ poles: tile });
    const compressed = zlib.gzipSync(pbf);
    batchBuffer.push({ z: 11, x, y, data: compressed });
    if (batchBuffer.length >= 500) flushBatch();
  }
  flushBatch();
  console.log(`Zoom 11 完成 (${z11Keys.size} 圖磚)`);

  // Zoom 10
  for (const k of z10Keys) {
    const [x, y] = k.split(',').map(Number);
    const tile = index10_12.getTile(10, x, y);
    if (!tile || !tile.features || tile.features.length === 0) continue;
    const pbf = vtpbf.fromGeojsonVt({ poles: tile });
    const compressed = zlib.gzipSync(pbf);
    batchBuffer.push({ z: 10, x, y, data: compressed });
    if (batchBuffer.length >= 500) flushBatch();
  }
  flushBatch();
  console.log(`Zoom 10 完成 (${z10Keys.size} 圖磚)`);

  // 4. 建立索引並關閉 MBTiles
  console.log('\n正在建立 MBTiles 索引...');
  db.exec('CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);');
  db.close();

  const mbSize = (fs.statSync(MBTILES_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`MBTiles 建立完成：${MBTILES_PATH} (${mbSize} MB, 共 ${totalWrittenTiles} 圖磚)`);

  // 5. 呼叫 go-pmtiles 轉為 taiwan_poles.pmtiles
  console.log('\n正在轉檔為 PMTiles (含自動聚類)...');
  const tConv = Date.now();
  const convertCmd = `"${PMTILES_EXE}" convert "${MBTILES_PATH}" "${PMTILES_PATH}"`;
  console.log('執行:', convertCmd);
  execSync(convertCmd, { stdio: 'inherit' });
  console.log(`轉檔完成，耗時 ${((Date.now() - tConv)/1000).toFixed(1)}s`);

  // 6. 檢驗 PMTiles
  console.log('\n檢驗 PMTiles 資訊:');
  execSync(`"${PMTILES_EXE}" show "${PMTILES_PATH}"`, { stdio: 'inherit' });

  const pmSize = (fs.statSync(PMTILES_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`\n🎉 全台 PMTiles 向量圖磚製作成功！`);
  console.log(`檔案位置: ${PMTILES_PATH} (${pmSize} MB)`);
  console.log(`總耗時: ${((Date.now() - t0)/1000).toFixed(1)} 秒`);

  // 清除暫存 mbtiles
  if (fs.existsSync(MBTILES_PATH)) {
    fs.unlinkSync(MBTILES_PATH);
    console.log(`已清理暫存檔: ${MBTILES_PATH}`);
  }
}

main().catch(err => {
  console.error('烘焙失敗:', err);
  process.exit(1);
});
