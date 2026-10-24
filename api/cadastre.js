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

    // 若有 city，嘗試平行補充 S09_Ralid 詳細屬性
    if (payload.ok && city) {
      try {
        const ralidRes = await fetch("https://api.nlsc.gov.tw/S09_Ralid/getLandInfoSect", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ city, sect: sect.slice(0, 4), landno }).toString(),
          signal: AbortSignal.timeout(3000)
        });
        const ralidJson = await ralidRes.json();
        if (ralidJson?.ralid) {
          payload.ralid = ralidJson.ralid;
          if (ralidJson.ralid.AA10) payload.area = ralidJson.ralid.AA10;
          if (ralidJson.ralid.AA16) payload.declaredValue = ralidJson.ralid.AA16;
          if (ralidJson.ralid.AA17) payload.declaredPrice = ralidJson.ralid.AA17;
          if (ralidJson.ralid.AA05) payload.regDate = ralidJson.ralid.AA05;
        }
        if (ralidJson?.land?.userList) {
          payload.userList = ralidJson.land.userList;
        }
      } catch {}
    }

    sendResponse(200, payload);
  } catch (err) {
    sendResponse(500, { ok: false, error: `地籍伺服器連線失敗：${err.message}` });
  }
}
