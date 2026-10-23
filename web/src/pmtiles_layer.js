/**
 * PMTiles 全台灣向量圖磚 Leaflet 圖層
 * 1. 串流分片載入全台 296 萬筆電桿
 * 2. Canvas 繪製實心前綴彩色圓點 + 白色描邊 (避免任何圖磚邊界裁切)
 * 3. 提供 getVisiblePolesInBounds 供上層 Leaflet DOM 標籤層與路線圖層 (RouteLayer) 完美聯動
 */
import { PMTiles } from "pmtiles";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

function hashText(value) {
  let hash = 0;
  const str = String(value || "");
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function colorForPrefix(prefix) {
  if (!prefix || prefix === "未分類") return "#64748b";
  const h = hashText(prefix);
  const hue = (h * 137.508) % 360;
  const sat = 58 + (h % 22);
  const lit = 30 + (h % 16);
  return `hsl(${hue.toFixed(0)}, ${sat}%, ${lit}%)`;
}

function extractPrefix(name) {
  const match = String(name || "").trim().match(/^[\u3400-\u9fff]+/);
  if (match) return match[0].slice(0, 4);
  const codeMatch = String(name || "").trim().match(/^[A-Z]\d{2,4}/);
  if (codeMatch) return codeMatch[0];
  return "未分類";
}

function tilePoint2LatLng(tileX, tileY, z, px, py, extent = 4096) {
  const worldX = tileX + px / extent;
  const worldY = tileY + py / extent;
  const lng = (worldX / Math.pow(2, z)) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * worldY) / Math.pow(2, z);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

function latLng2Tile(lat, lng, zoom) {
  const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
  const rad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom));
  return { x, y };
}

export function createPMTilesLayer(pmtilesUrl, options = {}) {
  const pmtiles = new PMTiles(pmtilesUrl);

  const tileCache = new Map();
  const CACHE_LIMIT = 200;

  async function getTileFeatures(z, x, y) {
    const key = `${z}_${x}_${y}`;
    if (tileCache.has(key)) return tileCache.get(key);

    try {
      const resp = await pmtiles.getZxy(z, x, y);
      if (!resp || !resp.data) {
        tileCache.set(key, []);
        return [];
      }

      const pbf = new PbfReader(resp.data);
      const vt = new VectorTile(pbf);
      const layer = vt.layers["poles"];
      if (!layer) {
        tileCache.set(key, []);
        return [];
      }

      const feats = [];
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const geom = f.loadGeometry();
        if (geom && geom[0] && geom[0][0]) {
          const pt = geom[0][0];
          feats.push({
            px: pt.x,
            py: pt.y,
            name: f.properties.name || "",
            code: f.properties.code || "",
            city: f.properties.city || "",
            area: f.properties.area || "",
            type: f.properties.type || "",
            id: f.properties.id || i
          });
        }
      }

      if (tileCache.size >= CACHE_LIMIT) {
        const oldest = tileCache.keys().next().value;
        tileCache.delete(oldest);
      }
      tileCache.set(key, feats);
      return feats;
    } catch (err) {
      console.warn(`PMTiles fetch error (${z}/${x}/${y}):`, err);
      return [];
    }
  }

  // 建立自訂 Leaflet GridLayer
  const PMTilesGridLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("canvas");
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      tile.style.width = `${size.x}px`;
      tile.style.height = `${size.y}px`;

      const ctx = tile.getContext("2d");
      const z = coords.z;

      if (z < 10) {
        setTimeout(() => done(null, tile), 0);
        return tile;
      }

      (async () => {
        try {
          if (z <= 14) {
            const features = await getTileFeatures(z, coords.x, coords.y);
            this.renderTileDots(ctx, features, z, 0, 0, 4096, size.x);
          } else {
            const dz = z - 14;
            const parentX = coords.x >> dz;
            const parentY = coords.y >> dz;
            const subSize = 4096 >> dz;
            const subMinX = (coords.x & ((1 << dz) - 1)) * subSize;
            const subMinY = (coords.y & ((1 << dz) - 1)) * subSize;

            const parentFeatures = await getTileFeatures(14, parentX, parentY);
            const subFeatures = [];
            for (const f of parentFeatures) {
              if (f.px >= subMinX && f.px < subMinX + subSize &&
                  f.py >= subMinY && f.py < subMinY + subSize) {
                subFeatures.push({
                  ...f,
                  px: Math.round((f.px - subMinX) * (4096 / subSize)),
                  py: Math.round((f.py - subMinY) * (4096 / subSize))
                });
              }
            }
            this.renderTileDots(ctx, subFeatures, z, 0, 0, 4096, size.x);
          }
          done(null, tile);
        } catch (e) {
          done(e, tile);
        }
      })();

      return tile;
    },

    /**
     * 在圖磚 Canvas 上繪製實心前綴圓點
     * （文字標籤交由 Leaflet labelsLayer 渲染，徹底避免 256px 圖磚邊界文字被裁切的硬體缺陷）
     */
    renderTileDots(ctx, features, zoom, subMinX, subMinY, subSize, tileSize) {
      if (!features || features.length === 0) return;

      const scale = tileSize / subSize;
      const selectedId = options.getSelectedId ? options.getSelectedId() : null;

      // 1. Zoom 10 - 12: 清新微光電網骨幹
      if (zoom <= 12) {
        if (zoom < 11) return;
        ctx.fillStyle = "rgba(14, 116, 144, 0.45)";
        const step = zoom === 11 ? 5 : 2;
        for (let i = 0; i < features.length; i += step) {
          const f = features[i];
          ctx.beginPath();
          ctx.arc(f.px * scale, f.py * scale, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }

      // 2. Zoom 13: 實心前綴彩點
      if (zoom === 13) {
        for (const f of features) {
          const cx = f.px * scale;
          const cy = f.py * scale;
          const color = colorForPrefix(extractPrefix(f.name));

          ctx.beginPath();
          ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
          ctx.stroke();
        }
        return;
      }

      // 3. Zoom 14+: 精緻實心彩色圓點 + 純白描邊 (完全比照原版 drawPoints)
      const dotRadius = zoom >= 17 ? 5.2 : 4.5;

      for (const f of features) {
        const cx = f.px * scale;
        const cy = f.py * scale;
        const isSelected = selectedId === f.id;
        const color = colorForPrefix(extractPrefix(f.name));

        // 選中高亮外光環
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(cx, cy, 10, 0, Math.PI * 2);
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "#f59e0b";
          ctx.stroke();
        }

        // 實心電桿圓點
        ctx.beginPath();
        ctx.arc(cx, cy, isSelected ? 6.0 : dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? "#f59e0b" : color;
        ctx.fill();
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        ctx.stroke();
      }
    }
  });

  const layer = new PMTilesGridLayer({
    tileSize: 256,
    minZoom: 10,
    maxZoom: 21,
    keepBuffer: 3,
    updateWhenIdle: false,
    updateWhenZooming: false
  });

  /**
   * 根據視窗邊界，從 PMTiles 快取中提取視野內的所有電桿完整資訊
   * 供 Leaflet DOM 標籤層（避免邊界裁切）與路線圖層（推算供電線路）使用
   */
  layer.getVisiblePolesInBounds = async function(bounds, zoom = 15) {
    const zNative = Math.min(zoom, 14);
    const nw = bounds.getNorthWest();
    const se = bounds.getSouthEast();

    const tNW = latLng2Tile(nw.lat, nw.lng, zNative);
    const tSE = latLng2Tile(se.lat, se.lng, zNative);

    const minX = Math.min(tNW.x, tSE.x);
    const maxX = Math.max(tNW.x, tSE.x);
    const minY = Math.min(tNW.y, tSE.y);
    const maxY = Math.max(tNW.y, tSE.y);

    const tileCount = (maxX - minX + 1) * (maxY - minY + 1);
    if (tileCount > 64) {
      // 視野範圍過大，不取點以保障效能
      return [];
    }

    const tileCoords = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        tileCoords.push({ x, y });
      }
    }

    const featureArrays = await Promise.all(
      tileCoords.map(t => getTileFeatures(zNative, t.x, t.y))
    );

    const poles = [];
    const seenKeys = new Set();

    for (let i = 0; i < tileCoords.length; i++) {
      const t = tileCoords[i];
      const feats = featureArrays[i];
      if (!feats) continue;

      for (const f of feats) {
        const { lat, lng } = tilePoint2LatLng(t.x, t.y, zNative, f.px, f.py);
        if (!bounds.contains([lat, lng])) continue;

        const key = f.id != null ? f.id : `${f.name}_${lat.toFixed(6)}_${lng.toFixed(6)}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        poles.push({
          id: f.id,
          name: f.name || f.code,
          code: f.code || f.name,
          city: f.city,
          area: f.area,
          type: f.type,
          lat,
          lng
        });
      }
    }

    return poles;
  };

  // 供點擊反查電桿特徵
  layer.findPoleAtLatLng = async function(map, latlng, maxPixelDist = 20) {
    const zoom = map.getZoom();
    if (zoom < 12) return null;

    const tileCoord = latLng2Tile(latlng.lat, latlng.lng, zoom <= 14 ? zoom : 14);
    let features = [];

    if (zoom <= 14) {
      features = await getTileFeatures(zoom, tileCoord.x, tileCoord.y);
    } else {
      features = await getTileFeatures(14, tileCoord.x, tileCoord.y);
    }

    if (!features || features.length === 0) return null;

    let closest = null;
    let minD = Infinity;

    for (const f of features) {
      const poleLatLng = tilePoint2LatLng(tileCoord.x, tileCoord.y, zoom <= 14 ? zoom : 14, f.px, f.py);
      const polePoint = map.latLngToContainerPoint([poleLatLng.lat, poleLatLng.lng]);
      const clickPoint = map.latLngToContainerPoint(latlng);
      const dist = Math.hypot(polePoint.x - clickPoint.x, polePoint.y - clickPoint.y);

      if (dist <= maxPixelDist && dist < minD) {
        minD = dist;
        closest = {
          ...f,
          lat: poleLatLng.lat,
          lng: poleLatLng.lng
        };
      }
    }

    return closest;
  };

  return layer;
}
