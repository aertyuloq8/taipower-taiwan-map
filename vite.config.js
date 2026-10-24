import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

let searchDbInstance = null;
function getSearchDb() {
  if (!searchDbInstance) {
    const dbPath = path.join(projectRoot, "data", "taiwan_poles_search.db");
    if (fs.existsSync(dbPath)) {
      searchDbInstance = new Database(dbPath, { readonly: true });
    }
  }
  return searchDbInstance;
}

function normalizePoleName(n) {
  return String(n || "")
    .trim()
    .replace(/高幹|高分|高枝|幹|分|枝/g, "")
    .replace(/#/g, "")
    .replace(/＃/g, "");
}

function parsePrefixAndNum(name) {
  const clean = normalizePoleName(name);
  const m = clean.match(/^([^\d]+)(\d+)(.*)$/);
  if (m) {
    return { clean, prefix: m[1], pole_num: parseInt(m[2], 10), branch: m[3] };
  }
  return { clean, prefix: clean, pole_num: 0, branch: "" };
}

let cachedCitiesList = null;
let cachedAreasList = null;

function getLocationLists(db) {
  if (!cachedCitiesList) {
    try {
      cachedCitiesList = db.prepare("SELECT DISTINCT city FROM poles").all().map(c => c.city);
      cachedAreasList = db.prepare("SELECT DISTINCT area, city FROM poles").all();
    } catch {
      cachedCitiesList = [];
      cachedAreasList = [];
    }
  }
  return { cities: cachedCitiesList, areas: cachedAreasList };
}

function parseLocationKeywords(rawQuery, cities, areas) {
  let text = rawQuery.trim();
  let city = "";
  let area = "";

  const parts = text.split(/[\s,，]+/);
  if (parts.length >= 2) {
    const candidates = [
      { part: parts[0], rest: parts.slice(1).join(" ") },
      { part: parts[parts.length - 1], rest: parts.slice(0, parts.length - 1).join(" ") }
    ];

    for (const { part, rest } of candidates) {
      if (!part) continue;
      for (const c of cities) {
        const shortC = c.replace(/縣|市/g, "");
        if (part === c || part === shortC || part === shortC.replace("臺", "台") || part === c.replace("臺", "台")) {
          city = c;
          text = rest.trim();
          break;
        }
      }
      if (city) break;

      for (const a of areas) {
        const shortA = a.area.replace(/鄉|鎮|市|區/g, "");
        if (part === a.area || (shortA.length >= 2 && part === shortA)) {
          area = a.area;
          city = a.city;
          text = rest.trim();
          break;
        }
      }
      if (area) break;
    }
  }

  return { query: text, city, area };
}

function handleSearchApi(req, res) {
  const parsedUrl = new URL(req.url, "http://localhost:5173");
  const rawQuery = (parsedUrl.searchParams.get("q") || "").trim();
  let city = (parsedUrl.searchParams.get("city") || "").trim();
  let area = (parsedUrl.searchParams.get("area") || "").trim();
  const limit = Math.min(parseInt(parsedUrl.searchParams.get("limit") || "50", 10), 100);

  const lat = parseFloat(parsedUrl.searchParams.get("lat") || "");
  const lng = parseFloat(parsedUrl.searchParams.get("lng") || "");
  const hasCoord = !isNaN(lat) && !isNaN(lng) && lat >= 21.0 && lat <= 26.5 && lng >= 119.0 && lng <= 122.5;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const db = getSearchDb();
  if (!db || !rawQuery) {
    res.end(JSON.stringify([]));
    return;
  }

  const { cities, areas } = getLocationLists(db);
  const locParsed = parseLocationKeywords(rawQuery, cities, areas);
  if (locParsed.city && (!city || city === "全台灣")) city = locParsed.city;
  if (locParsed.area && !area) area = locParsed.area;

  const q = locParsed.query.replace(/＃/g, "#");
  if (!q) {
    res.end(JSON.stringify([]));
    return;
  }

  const isCode = /^[A-Z0-9]+$/i.test(q);

  const cityParams = [];
  let cityClause = "";
  if (city && city !== "全台灣") {
    cityClause += " AND city = ?";
    cityParams.push(city);
  }
  if (area) {
    cityClause += " AND area = ?";
    cityParams.push(area);
  }

  let rows = [];

  if (isCode) {
    if (hasCoord) {
      const sql = `
        SELECT *, ((lat - ?) * (lat - ?) + (lng - ?) * (lng - ?) * 0.85) AS dist_sq
        FROM poles
        WHERE code LIKE ? ${cityClause}
        ORDER BY dist_sq ASC, code ASC
        LIMIT ${limit}
      `;
      rows = db.prepare(sql).all(lat, lat, lng, lng, `${q}%`, ...cityParams);
    } else {
      const stmt = db.prepare(`SELECT * FROM poles WHERE code LIKE ? ${cityClause} ORDER BY code ASC LIMIT ${limit}`);
      rows = stmt.all(`${q}%`, ...cityParams);
    }
  } else {
    const parsed = parsePrefixAndNum(q);

    if (parsed.pole_num > 0) {
      // 帶有桿號數字的自然排序查詢 (例如 '尖峰1', '尖峰高幹1', '國小17右13')
      if (hasCoord) {
        const sql = `
          SELECT *, ((lat - ?) * (lat - ?) + (lng - ?) * (lng - ?) * 0.85) AS dist_sq
          FROM poles
          WHERE (prefix = ? AND (clean_name = ? OR clean_name LIKE ? OR pole_num >= ?)) ${cityClause}
          ORDER BY
            CASE
              WHEN clean_name = ? THEN 0
              WHEN pole_num = ? AND branch != '' THEN 1
              WHEN pole_num = ? THEN 2
              ELSE 3
            END,
            dist_sq ASC,
            pole_num ASC,
            branch ASC
          LIMIT ${limit}
        `;
        const stmt = db.prepare(sql);
        rows = stmt.all(
          lat,
          lat,
          lng,
          lng,
          parsed.prefix,
          parsed.clean,
          parsed.clean + "%",
          parsed.pole_num,
          ...cityParams,
          parsed.clean,
          parsed.pole_num,
          parsed.pole_num
        );
      } else {
        const sql = `
          SELECT *
          FROM poles
          WHERE (prefix = ? AND (clean_name = ? OR clean_name LIKE ? OR pole_num >= ?)) ${cityClause}
          ORDER BY
            CASE
              WHEN clean_name = ? THEN 0
              WHEN pole_num = ? AND branch != '' THEN 1
              WHEN pole_num = ? THEN 2
              ELSE 3
            END,
            pole_num ASC,
            branch ASC
          LIMIT ${limit}
        `;
        const stmt = db.prepare(sql);
        rows = stmt.all(
          parsed.prefix,
          parsed.clean,
          parsed.clean + "%",
          parsed.pole_num,
          ...cityParams,
          parsed.clean,
          parsed.pole_num,
          parsed.pole_num
        );
      }
    } else {
      // 純前綴文字查詢 (例如 '尖峰', '國小', '山拔')
      if (hasCoord) {
        const sql = `
          SELECT *, ((lat - ?) * (lat - ?) + (lng - ?) * (lng - ?) * 0.85) AS dist_sq
          FROM poles
          WHERE (prefix = ? OR clean_name LIKE ? OR name LIKE ?) ${cityClause}
          ORDER BY
            dist_sq ASC,
            pole_num ASC,
            branch ASC
          LIMIT ${limit}
        `;
        const stmt = db.prepare(sql);
        rows = stmt.all(lat, lat, lng, lng, parsed.prefix, parsed.clean + "%", q + "%", ...cityParams);
      } else {
        const sql = `
          SELECT *
          FROM poles
          WHERE (prefix = ? OR clean_name LIKE ? OR name LIKE ?) ${cityClause}
          ORDER BY
            pole_num ASC,
            branch ASC
          LIMIT ${limit}
        `;
        const stmt = db.prepare(sql);
        rows = stmt.all(parsed.prefix, parsed.clean + "%", q + "%", ...cityParams);
      }
    }
  }

  // 格式化距離公里數
  for (const r of rows) {
    if (r.dist_sq != null) {
      r.dist_km = Math.round(Math.sqrt(r.dist_sq) * 111 * 10) / 10;
    }
  }

  res.end(JSON.stringify(rows));
}

async function handleCadastreApi(req, res) {
  const parsedUrl = new URL(req.url, "http://localhost:5173");
  const office = (parsedUrl.searchParams.get("office") || parsedUrl.searchParams.get("officeCode") || "").trim();
  const sect = (parsedUrl.searchParams.get("sect") || parsedUrl.searchParams.get("sectionCode") || parsedUrl.searchParams.get("section") || "").trim();
  const number = (parsedUrl.searchParams.get("number") || parsedUrl.searchParams.get("landno") || "").trim();
  const callback = (parsedUrl.searchParams.get("callback") || "").trim();

  let landno = number;
  if (/^\d{1,4}(?:-\d{1,4})?$/.test(number)) {
    const parts = number.split("-");
    landno = parts[0].padStart(4, "0") + (parts[1] || "0").padStart(4, "0");
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Origin, Content-Type, Accept");

  if (!office || !sect || !landno) {
    const errPayload = { ok: false, error: "缺少必要參數（office, sect, number）" };
    const body = callback ? `${callback}(${JSON.stringify(errPayload)});` : JSON.stringify(errPayload);
    res.writeHead(400, { "Content-Type": callback ? "application/javascript; charset=utf-8" : "application/json; charset=utf-8" });
    res.end(body);
    return;
  }

  const queryUrl = `https://landmaps.nlsc.gov.tw/S_Maps/qryTileMapIndex?type=2&flag=2&office=${encodeURIComponent(office)}&sect=${encodeURIComponent(sect)}&landno=${encodeURIComponent(landno)}&alpah=0.5f&imgflag=1`;

  try {
    let payload = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await fetch(queryUrl, {
        headers: {
          "Referer": "https://maps.nlsc.gov.tw/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });
      const json = await response.json();
      if (json[0]?.msg === "影像產置中，請稍候") {
        await new Promise(r => setTimeout(r, 450));
        continue;
      }
      if (json[0]?.msg) {
        payload = { ok: false, error: json[0].msg };
        break;
      }
      if (Array.isArray(json) && json.length >= 2 && json[1]?.image) {
        payload = {
          ok: true,
          type: "imageLayers",
          office,
          sect,
          landno,
          sectName: json[0].sectStr ? Buffer.from(json[0].sectStr, "base64").toString("utf8") : "",
          officeName: json[0].officeStr ? Buffer.from(json[0].officeStr, "base64").toString("utf8") : "",
          imageLayers: [
            {
              image: json[1].image,
              extent: [json[1].lx, json[1].ly, json[1].rx, json[1].ry],
              mimeType: "image/png"
            }
          ]
        };
        break;
      }
      payload = { ok: false, error: "查無此地號影像圖資" };
    }

    if (!payload) payload = { ok: false, error: "地籍圖資服務回應逾時，請稍後再試" };

    const body = callback ? `${callback}(${JSON.stringify(payload)});` : JSON.stringify(payload);
    res.writeHead(200, { "Content-Type": callback ? "application/javascript; charset=utf-8" : "application/json; charset=utf-8" });
    res.end(body);
  } catch (err) {
    const errPayload = { ok: false, error: `地籍伺服器連線失敗：${err.message}` };
    const body = callback ? `${callback}(${JSON.stringify(errPayload)});` : JSON.stringify(errPayload);
    res.writeHead(500, { "Content-Type": callback ? "application/javascript; charset=utf-8" : "application/json; charset=utf-8" });
    res.end(body);
  }
}

// dev 專用：把 /data/* 代理到專案根目錄的 data/，並支援 HTTP Range Request (供 PMTiles 分片下載)
function dataDirPlugin() {
  const dataDir = path.join(projectRoot, "data");
  return {
    name: "serve-project-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith("/api/search")) {
          return handleSearchApi(req, res);
        }
        if (req.url && req.url.startsWith("/api/cadastre")) {
          return handleCadastreApi(req, res);
        }

        let urlPath = req.url?.split("?")[0] || "";
        try { urlPath = decodeURIComponent(urlPath); } catch {}
        if (!urlPath.startsWith("/data/")) return next();
        const target = path.join(dataDir, urlPath.slice("/data/".length));
        if (!target.startsWith(dataDir)) return next();
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return next();
        
        const ext = path.extname(target).toLowerCase();
        const types = {
          ".json": "application/json; charset=utf-8",
          ".csv": "text/csv; charset=utf-8",
          ".pmtiles": "application/octet-stream",
          ".pbf": "application/x-protobuf"
        };
        const contentType = types[ext] || "application/octet-stream";
        const stat = fs.statSync(target);
        const totalSize = stat.size;

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Range, Origin, Content-Type, Accept");
        res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
        res.setHeader("Accept-Ranges", "bytes");

        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }

        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

          if (start >= totalSize || end >= totalSize) {
            res.writeHead(416, {
              "Content-Range": `bytes */${totalSize}`
            });
            res.end();
            return;
          }

          const chunkSize = (end - start) + 1;
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${totalSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": contentType,
            "Cache-Control": "no-store",
          });
          fs.createReadStream(target, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            "Content-Length": totalSize,
            "Content-Type": contentType,
            "Cache-Control": "no-store",
          });
          fs.createReadStream(target).pipe(res);
        }
      });
    },
  };
}

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [dataDirPlugin()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "web/index.html"
    }
  },
  server: {
    open: false,
    fs: {
      allow: [".."]
    }
  }
});
