const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(ROOT, 'data', 'processed', 'taiwan_poles.geojsonseq');
const DB_FILE = path.join(ROOT, 'data', 'taiwan_poles_search.db');

function normalizePoleName(n) {
  return String(n || '')
    .trim()
    .replace(/高幹|高分|高枝|幹|分|枝/g, '')
    .replace(/#/g, '')
    .replace(/＃/g, '');
}

function parsePrefixAndNum(name) {
  const clean = normalizePoleName(name);
  const m = clean.match(/^([^\d]+)(\d+)(.*)$/);
  if (m) {
    return {
      clean,
      prefix: m[1],
      pole_num: parseInt(m[2], 10),
      branch: m[3]
    };
  }
  return {
    clean,
    prefix: clean,
    pole_num: 0,
    branch: ''
  };
}

async function main() {
  console.log('=== 開始建置全台灣電桿自然排序搜尋資料庫 ===');
  const t0 = Date.now();

  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const db = new Database(DB_FILE);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -200000'); // 200MB cache

  db.exec(`
    CREATE TABLE poles (
      id INTEGER,
      name TEXT,
      clean_name TEXT,
      prefix TEXT,
      pole_num INTEGER,
      branch TEXT,
      code TEXT,
      city TEXT,
      area TEXT,
      lat REAL,
      lng REAL
    );
  `);

  const insert = db.prepare('INSERT INTO poles VALUES (@id, @name, @clean_name, @prefix, @pole_num, @branch, @code, @city, @area, @lat, @lng)');
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(r);
  });

  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_FILE, 'utf8'),
    crlfDelay: Infinity
  });

  let buffer = [];
  let count = 0;

  for await (const line of rl) {
    if (!line) continue;
    const f = JSON.parse(line);
    const [lng, lat] = f.geometry.coordinates;
    const name = f.properties.name || '';
    const parsed = parsePrefixAndNum(name);

    buffer.push({
      id: f.properties.id || 0,
      name,
      clean_name: parsed.clean,
      prefix: parsed.prefix,
      pole_num: parsed.pole_num,
      branch: parsed.branch,
      code: f.properties.code || '',
      city: f.properties.city || '',
      area: f.properties.area || '',
      lat: Math.round(lat * 10000000) / 10000000,
      lng: Math.round(lng * 10000000) / 10000000
    });

    if (buffer.length >= 25000) {
      insertMany(buffer);
      count += buffer.length;
      buffer = [];
      if (count % 250000 === 0) {
        process.stdout.write(`已寫入 ${count} 筆...\r`);
      }
    }
  }

  if (buffer.length > 0) {
    insertMany(buffer);
    count += buffer.length;
  }

  console.log(`\n全數寫入 ${count} 筆，正在建立多維搜尋與自然排序索引 (B-Tree)...`);
  const tIndex0 = Date.now();
  db.exec('CREATE INDEX idx_poles_clean_name ON poles(clean_name COLLATE NOCASE);');
  db.exec('CREATE INDEX idx_poles_prefix ON poles(prefix);');
  db.exec('CREATE INDEX idx_poles_prefix_num ON poles(prefix, pole_num);');
  db.exec('CREATE INDEX idx_poles_name ON poles(name COLLATE NOCASE);');
  db.exec('CREATE INDEX idx_poles_code ON poles(code COLLATE NOCASE);');
  console.log(`索引建立完成，耗時 ${((Date.now() - tIndex0) / 1000).toFixed(1)} 秒`);

  db.close();

  const stat = fs.statSync(DB_FILE);
  console.log(`=== 搜尋資料庫建置完成！===`);
  console.log(`檔案路徑: ${DB_FILE}`);
  console.log(`檔案大小: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`總耗時: ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

main().catch(err => {
  console.error('建置失敗:', err);
  process.exit(1);
});
