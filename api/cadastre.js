const LCDETYPE_NAMES = {
  lcde_1: "本國人",
  lcde_2: "外國人",
  lcde_3: "國有",
  lcde_4: "省市",
  lcde_5: "縣市",
  lcde_6: "鄉鎮市",
  lcde_7: "本國私法人",
  lcde_8: "外國法人",
  lcde_9: "祭祀公業",
  lcde_a: "其他",
  lcde_b: "銀行法人",
  lcde_c: "大陸地區自然人",
  lcde_d: "大陸地區法人"
};

function parseLcdetype(lcdetype) {
  if (!lcdetype || typeof lcdetype !== "object") return "";
  const parts = [];

  // 1. 本國人加總 (lcde_1_m, lcde_1_f, lcde_1_o)
  let s1 = 0;
  for (const [k, v] of Object.entries(lcdetype)) {
    if (k.startsWith("lcde_1")) {
      const num = parseFloat(v);
      if (num > 0) s1 += num;
    }
  }
  if (s1 > 0) {
    const pct = s1 <= 1 ? (s1 * 100).toFixed(2) + "%" : "100.00%";
    parts.push(`本國人: ${pct}`);
  }

  // 2. 其他權利人類別
  for (const [k, v] of Object.entries(lcdetype)) {
    if (k.startsWith("lcde_") && !k.startsWith("lcde_1")) {
      const num = parseFloat(v);
      if (num > 0) {
        const pct = num <= 1 ? (num * 100).toFixed(2) + "%" : "100.00%";
        const label = LCDETYPE_NAMES[k] || k;
        parts.push(`${label}: ${pct}`);
      }
    }
  }

  return parts.join("、");
}

function parseLandUseXml(xmlText) {
  if (!xmlText || typeof xmlText !== "string") return [];
  const items = [];
  const itemMatches = xmlText.match(/<ITEM>([\s\S]*?)<\/ITEM>/gi) || [];
  for (const block of itemMatches) {
    const getTag = tag => {
      const m = block.match(new RegExp(`<${tag}>(.*?)</${tag}>`, "i"));
      return m ? m[1].trim() : "";
    };
    const year = getTag("YEAR");
    const month = getTag("LMONTH");
    const code = getTag("LCODE") || getTag("Lcode_C3") || getTag("Lcode_C2") || "";
    const name = getTag("NAME") || getTag("Lname_C2") || "";
    const category = getTag("Lname_C1") || "";
    let timeStr = "";
    if (year) timeStr += `${year}年`;
    if (month) timeStr += `${month}月`;
    if (year || code || name) {
      items.push({
        year,
        month,
        timeStr,
        code,
        name,
        category
      });
    }
  }
  return items.reverse(); // 依官方慣例：最新成果排最前
}

export default async function handler(req, res) {
  // CORS 跨域標頭允許任何來源呼叫
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, Origin, Accept");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, "http://localhost");
  const city = (parsedUrl.searchParams.get("city") || "").trim();
  const office = (parsedUrl.searchParams.get("office") || parsedUrl.searchParams.get("officeCode") || "").trim();
  const sect = (parsedUrl.searchParams.get("sect") || parsedUrl.searchParams.get("sectionCode") || parsedUrl.searchParams.get("section") || "").trim();
  const number = (parsedUrl.searchParams.get("number") || parsedUrl.searchParams.get("landno") || "").trim();
  const callback = (parsedUrl.searchParams.get("callback") || "").trim();

  let landno = number;
  if (/^\d{1,4}(?:-\d{1,4})?$/.test(number)) {
    const parts = number.split("-");
    landno = parts[0].padStart(4, "0") + (parts[1] || "0").padStart(4, "0");
  }

  const sendResponse = (statusCode, data) => {
    res.statusCode = statusCode;
    if (callback) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.end(`${callback}(${JSON.stringify(data)});`);
    } else {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    }
  };

  if (!office || !sect || !landno) {
    return sendResponse(400, { ok: false, error: "缺少必要參數（office, sect, number）" });
  }

  const queryUrl = `https://landmaps.nlsc.gov.tw/S_Maps/qryTileMapIndex?type=2&flag=2&office=${encodeURIComponent(office)}&sect=${encodeURIComponent(sect)}&landno=${encodeURIComponent(landno)}&alpah=0.5f&imgflag=1`;

  try {
    let payload = null;

    // 平行發起國土測繪切片查詢（含 Referer）
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await fetch(queryUrl, {
        headers: {
          "Referer": "https://maps.nlsc.gov.tw/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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
        // 設定 CDN 邊緣快取 24 小時（相同的地號在 Edge 直接秒回）
        res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800");
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

    // 成功取得地籍切片後，平行擴充「土地詳細屬性（含權利人）」與「國土利用歷年成果」
    if (payload.ok) {
      const tasks = [];

      // 任務 1：S09_Ralid 詳細屬性與權利人類別
      if (city) {
        tasks.push((async () => {
          try {
            const ralidRes = await fetch("https://api.nlsc.gov.tw/S09_Ralid/getLandInfoSect", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ city, sect: sect.slice(0, 4), landno }).toString(),
              signal: AbortSignal.timeout(3500)
            });
            const ralidJson = await ralidRes.json();
            if (ralidJson?.ralid) {
              payload.ralid = ralidJson.ralid;
              if (ralidJson.ralid.AA10) payload.area = ralidJson.ralid.AA10;
              if (ralidJson.ralid.AA16) payload.declaredValue = ralidJson.ralid.AA16;
              if (ralidJson.ralid.AA17) payload.declaredPrice = ralidJson.ralid.AA17;
              if (ralidJson.ralid.AA05) payload.regDate = ralidJson.ralid.AA05;
              if (ralidJson.ralid.AA11) {
                try { payload.zone = Buffer.from(ralidJson.ralid.AA11, "base64").toString("utf8"); } catch {}
              }
              if (ralidJson.ralid.AA12) {
                try { payload.landUse = Buffer.from(ralidJson.ralid.AA12, "base64").toString("utf8"); } catch {}
              }
            }
            if (ralidJson?.lcdetype) {
              payload.ownerCategory = parseLcdetype(ralidJson.lcdetype);
            }
            if (ralidJson?.land?.userList) {
              payload.userList = ralidJson.land.userList;
            }
          } catch {}
        })());
      }

      // 任務 2：國土利用現況調查歷年成果
      const extent = payload.imageLayers?.[0]?.extent;
      if (Array.isArray(extent) && extent.length === 4) {
        const cx = ((extent[0] + extent[2]) / 2).toFixed(6);
        const cy = ((extent[1] + extent[3]) / 2).toFixed(6);
        tasks.push((async () => {
          try {
            const landUseUrl = `https://api.nlsc.gov.tw/other/LandUsePointYears/0/${cx}/${cy}/4326`;
            const luRes = await fetch(landUseUrl, {
              headers: {
                "Referer": "https://maps.nlsc.gov.tw/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
              },
              signal: AbortSignal.timeout(3500)
            });
            if (luRes.ok) {
              const xml = await luRes.text();
              payload.landUseHistory = parseLandUseXml(xml);
            }
          } catch {}
        })());
      }

      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
    }

    sendResponse(200, payload);
  } catch (err) {
    sendResponse(500, { ok: false, error: `地籍伺服器連線失敗：${err.message}` });
  }
}
