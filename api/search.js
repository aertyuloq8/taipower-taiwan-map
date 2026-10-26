import fs from "fs";
import path from "path";
import { PMTiles } from "pmtiles";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

class FileSource {
  constructor(filePath) {
    this.fd = fs.openSync(filePath, "r");
  }
  async getBytes(offset, length) {
    const buffer = Buffer.alloc(length);
    fs.readSync(this.fd, buffer, 0, length, offset);
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  }
  getKey() { return "local"; }
}

function latLng2Tile(lat, lng, zoom) {
  const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
  return { x, y };
}

function tilePoint2LatLng(tileX, tileY, z, px, py, extent = 4096) {
  const worldX = tileX + px / extent;
  const worldY = tileY + py / extent;
  const lng = (worldX / Math.pow(2, z)) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * worldY) / Math.pow(2, z);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

let _index = null;
let _pmtiles = null;

function getResources() {
  if (!_index) {
    const indexPath = path.join(process.cwd(), "data", "pole_prefix_index.json");
    if (fs.existsSync(indexPath)) {
      _index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    }
  }
  if (!_pmtiles) {
    const pmtilesPath = path.join(process.cwd(), "data", "taiwan_poles.pmtiles");
    if (fs.existsSync(pmtilesPath)) {
      _pmtiles = new PMTiles(new FileSource(pmtilesPath));
    }
  }
  return { index: _index, pmtiles: _pmtiles };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end();
  }

  const { query } = req;
  const q = String(query.q || "").trim();
  const cityName = String(query.city || "").trim();
  const areaName = String(query.area || "").trim();

  if (!q) {
    return res.end(JSON.stringify([]));
  }

  const { index, pmtiles } = getResources();
  if (!index || !pmtiles) {
    return res.end(JSON.stringify([]));
  }

  try {
    const cleanQ = q.replace(/[#＃]/g, "");
    const match = cleanQ.match(/^([^\d]+)(\d+)?/);
    if (!match) return res.end(JSON.stringify([]));

    const prefix = match[1];
    const num = match[2] ? parseInt(match[2], 10) : null;
    const basePrefix = prefix.replace(/(高幹|高分|幹|支|線)$/, "");

    const candidatePrefixes = new Set();
    for (const p of [prefix, basePrefix]) {
      if (p && index.p[p]) candidatePrefixes.add(p);
    }
    for (const p in index.p) {
      if (candidatePrefixes.size >= 12) break;
      if (p.startsWith(prefix) || (basePrefix && p.startsWith(basePrefix))) {
        candidatePrefixes.add(p);
      }
    }

    function parsePoleNameStructure(name) {
      const clean = String(name || "").replace(/[#＃\s]/g, "");
      const m = clean.match(/^([^\d]+?)(高幹|高分|幹|支|分|線)?(\d+)(.*)$/);
      if (m) {
        return {
          raw: name,
          clean,
          basePrefix: m[1],
          typeTag: m[2] || "",
          primaryNum: parseInt(m[3], 10),
          numStr: m[3],
          rest: m[4] || "",
          normShort: `${m[1]}${m[3]}`
        };
      }
      return { raw: name, clean, basePrefix: clean, typeTag: "", primaryNum: null, numStr: "", rest: "", normShort: clean };
    }

    const numStr = match[2] || "";
    const tilesToFetch = new Map();
    for (const p of candidatePrefixes) {
      const clusters = index.p[p];
      if (!clusters) continue;
      for (const item of clusters) {
        const [caId, min_num, max_num, x1, y1, x2, y2, count] = item;
        const cityArea = index.ca[caId];
        if (cityName && cityName !== "全台灣" && cityArea[0] !== cityName) continue;
        if (areaName && cityArea[1] !== areaName) continue;

        const hasBounds = x2 !== undefined && y2 !== undefined;
        if (hasBounds) {
          if (num !== null && (num < min_num || num > max_num + 50)) {
            const minStr = String(min_num);
            const maxStr = String(max_num);
            if (!minStr.startsWith(numStr) && !maxStr.startsWith(numStr)) {
              continue;
            }
          }
          for (let x = x1; x <= Math.min(x2, x1 + 2); x++) {
            for (let y = y1; y <= Math.min(y2, y1 + 2); y++) {
              const key = `13_${x}_${y}`;
              if (!tilesToFetch.has(key)) {
                tilesToFetch.set(key, { z: 13, x, y, cityArea });
              }
              if (tilesToFetch.size >= 12) break;
            }
            if (tilesToFetch.size >= 12) break;
          }
        } else {
          const [,, lat, lng] = item;
          const tile = latLng2Tile(lat, lng, 13);
          const key = `13_${tile.x}_${tile.y}`;
          if (!tilesToFetch.has(key)) {
            tilesToFetch.set(key, { z: 13, x: tile.x, y: tile.y, cityArea });
          }
        }
        if (tilesToFetch.size >= 12) break;
      }
      if (tilesToFetch.size >= 12) break;
    }

    const results = [];
    const seen = new Set();

    for (const [key, t] of tilesToFetch) {
      const resp = await pmtiles.getZxy(t.z, t.x, t.y);
      if (!resp || !resp.data) continue;
      const pbf = new PbfReader(resp.data);
      const vt = new VectorTile(pbf);
      const layer = vt.layers["poles"];
      if (!layer) continue;

      for (let i = 0; i < layer.length; i++) {
        const feat = layer.feature(i);
        const name = feat.properties.name || "";
        const code = feat.properties.code || "";
        const cleanName = name.replace(/[#＃\s]/g, "");
        const parsed = parsePoleNameStructure(name);

        const isMatch = cleanName.includes(cleanQ) || 
                        code.includes(cleanQ) || 
                        parsed.normShort.includes(cleanQ) ||
                        (parsed.basePrefix === prefix && numStr && parsed.numStr.startsWith(numStr));

        if (isMatch) {
          const geom = feat.loadGeometry();
          const pt = geom[0][0];
          const coords = tilePoint2LatLng(t.x, t.y, t.z, pt.x, pt.y);
          const k = feat.properties.id != null ? feat.properties.id : `${name}_${coords.lat.toFixed(6)}`;
          if (seen.has(k)) continue;
          seen.add(k);

          results.push({
            id: feat.properties.id,
            name: name || code,
            code: code || name,
            city: feat.properties.city || t.cityArea[0],
            area: feat.properties.area || t.cityArea[1],
            type: feat.properties.type || "水泥桿",
            lat: coords.lat,
            lng: coords.lng,
            parsed
          });
        }
      }
    }

    results.sort((a, b) => {
      const pA = a.parsed || parsePoleNameStructure(a.name);
      const pB = b.parsed || parsePoleNameStructure(b.name);

      const aExactPrefix = pA.basePrefix === prefix;
      const bExactPrefix = pB.basePrefix === prefix;
      if (aExactPrefix && !bExactPrefix) return -1;
      if (!aExactPrefix && bExactPrefix) return 1;

      const aExactShort = pA.normShort === cleanQ && !pA.rest;
      const bExactShort = pB.normShort === cleanQ && !pB.rest;
      if (aExactShort && !bExactShort) return -1;
      if (!aExactShort && bExactShort) return 1;

      const aExactClean = pA.clean === cleanQ || a.code === cleanQ;
      const bExactClean = pB.clean === cleanQ || b.code === cleanQ;
      if (aExactClean && !bExactClean) return -1;
      if (!aExactClean && bExactClean) return 1;

      const aDirectBranch = pA.normShort === cleanQ && pA.rest;
      const bDirectBranch = pB.normShort === cleanQ && pB.rest;
      if (aDirectBranch && !bDirectBranch) return -1;
      if (!aDirectBranch && bDirectBranch) return 1;

      if (num !== null && pA.primaryNum !== null && pB.primaryNum !== null) {
        const isRoundA = pA.numStr === numStr || pA.numStr === numStr + "0" || pA.numStr === numStr + "00";
        const isRoundB = pB.numStr === numStr || pB.numStr === numStr + "0" || pB.numStr === numStr + "00";
        if (isRoundA && !isRoundB) return -1;
        if (!isRoundA && isRoundB) return 1;

        if (pA.primaryNum !== pB.primaryNum) {
          return pA.primaryNum - pB.primaryNum;
        }
        
        const aIsTrunk = !pA.rest;
        const bIsTrunk = !pB.rest;
        if (aIsTrunk && !bIsTrunk) return -1;
        if (!aIsTrunk && bIsTrunk) return 1;
      }

      return a.name.localeCompare(b.name, "zh-Hant", { numeric: true });
    });

    res.statusCode = 200;
    res.end(JSON.stringify(results.slice(0, 50)));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
}
