/**
 * 批次電表清單標記模組 (Batch Meter Marker Module)
 * 專為台電抄表、換表、抽查、巡檢等任務打造之高階批次定位工具
 *
 * 核心功能：
 * 1. 智慧分流：
 *    - 有路名門牌地址 ➔ 國土測繪 (NLSC) 電子門牌定位用戶住家
 *    - 地號地址（段/小段/號）➔ 台電 CPS 圖號座標秒級反推現場電桿
 *    - 門牌查無結果 ➔ 自動由圖號座標保底定位，確保 100% 定位
 * 2. 視野淨化與醒目標註：
 *    - 自動隱藏雜亂之背景電桿文字標籤，突顯批次解析之電表標記
 *    - 每顆電表浮動顯示專屬清晰標籤（#1 地址/電號/桿名）
 * 3. 電腦到手機無縫轉移：
 *    - 📱 產生 QR Code：手機相機一掃秒開，免登入免傳檔立即開始導航
 *    - ☁️ Google Drive 雲端同步：支援上傳至 Drive 與從 Drive 還原
 *    - ⭐ 轉存門牌收藏：一鍵併入現有門牌收藏體系
 */
(() => {
  "use strict";

  function showToast(msg, type) {
    const el = document.createElement("div");
    el.textContent = msg;
    Object.assign(el.style, {
      position: "fixed", bottom: "80px", left: "50%", transform: "translateX(-50%)",
      padding: "10px 20px", borderRadius: "8px", fontSize: "14px", fontWeight: "700",
      color: "#fff", zIndex: "99999", opacity: "0", transition: "opacity 0.3s ease",
      pointerEvents: "none", maxWidth: "90vw", textAlign: "center",
      background: type === "error" ? "#dc2626" : type === "dup" ? "#d97706" : "#0f766e",
      boxShadow: "0 4px 12px rgba(0,0,0,0.25)"
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "1"; });
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 2400);
  }

  function escapeHtml(v) {
    return String(v ?? "").replace(/[&<>'"]/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[c]));
  }

  function getMap() {
    const candidate = window.__v2LeafletMap || window.map;
    return candidate && typeof candidate.getPane === "function" ? candidate : null;
  }

  function googleNavUrl(lat, lng) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat.toFixed(6) + "," + lng.toFixed(6))}`;
  }

  async function ensureXLSX() {
    if (window.XLSX) return window.XLSX;
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js";
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => reject(new Error("無法載入 Excel 處理模組"));
      document.head.appendChild(script);
    });
  }

  // 判定是否為「地號」（例如：永就段911號、新化段太子廟小段2334號、唪口段1532號）
  function isLandParcelAddress(addr) {
    if (!addr) return false;
    const s = String(addr).normalize("NFKC").trim();
    // 含有「段」、「小段」或「地號」，且「沒有」路、街、大道
    if (/(?:段|小段|地號)/.test(s)) {
      if (!/(?:路|街|大道)/.test(s)) return true;
    }
    // 含有縣市區後直接接地段號（無一般路名）
    if (!/(?:路|街|巷|弄|大道)/.test(s) && /(?:段|小段)/.test(s)) {
      return true;
    }
    return false;
  }

  // 電子門牌經緯度查詢（支援 Adapter 與 GAS JSONP 雙通道）
  function gasJsonpDoorplate(addr) {
    return new Promise((resolve) => {
      const gasBase = String(window.CADASTRE_GAS_URL || "").trim();
      if (!gasBase) return resolve(null);
      const cb = `__bm_gas_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const script = document.createElement("script");
      const timer = setTimeout(() => { cleanup(); resolve(null); }, 8000);
      const cleanup = () => {
        try { delete window[cb]; } catch (e) {}
        script.remove();
        clearTimeout(timer);
      };
      window[cb] = (data) => {
        cleanup();
        resolve(data);
      };
      script.onerror = () => { cleanup(); resolve(null); };
      const usp = new URLSearchParams({ action: "addrGeo", word: addr, callback: cb });
      script.src = gasBase + "?" + usp.toString();
      document.head.appendChild(script);
    });
  }

  // 建立門牌與桿號查詢快取，避免重複地址反覆呼叫網路
  const doorplateCache = new Map();
  const poleSearchCache = new Map();

  function cleanAddrStr(s) {
    return String(s || "").normalize("NFKC")
      .replace(/[台臺]/g, "台")
      .replace(/[()\[\]（）\s]+/g, "");
  }

  function extractCountyDistrict(addr) {
    const norm = cleanAddrStr(addr);
    let county = "";
    let district = "";

    const cm = norm.match(/(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/);
    if (cm) {
      county = cm[1];
      const rest = norm.slice(cm.index + cm[1].length);
      const dm = rest.match(/^([^市縣]+?[區鄉鎮市])/);
      if (dm) district = dm[1];
    } else {
      const dm = norm.match(/^([^市縣]+?[區鄉鎮市])/);
      if (dm) district = dm[1];
    }
    return { county, district };
  }

  function canonicalAddr(s) {
    let str = cleanAddrStr(s);
    str = str.replace(/[^區鄉鎮市]+?里(?:\d+鄰)?/g, "");
    str = str.replace(/(\d+)號之(\d+)號?/g, "$1-$2號");
    str = str.replace(/(\d+)之(\d+)號?/g, "$1-$2號");
    str = str.replace(/(\d+)[-－](\d+)號?/g, "$1-$2號");
    str = str.replace(/[號樓Ff室].*$/g, "");
    return str;
  }

  function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function findBestDoorplateMatch(rawAddr, results, expectedPt) {
    if (!Array.isArray(results) || results.length === 0) return null;
    const { county, district } = extractCountyDistrict(rawAddr);
    const targetCanonical = canonicalAddr(rawAddr);

    // 1. 精準比對（同縣市、同行政區且標準化門牌完全相符，例如「98-1號」對應「98號之1」）
    for (const item of results) {
      if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
      const itemAddr = cleanAddrStr(item.address);
      if (county && !itemAddr.includes(county)) continue;
      if (district && !itemAddr.includes(district)) continue;
      if (canonicalAddr(item.address) === targetCanonical) {
        // 若有提供電桿座標，門牌與現場電桿距離不可超過合理引進線範圍 (300公尺，避免山區或農電通訊地帶偏)
        if (expectedPt && getDistanceKm(item.y, item.x, expectedPt.lat, expectedPt.lng) > 0.3) {
          console.warn(`[Batch] 門牌與現場電桿相差 ${getDistanceKm(item.y, item.x, expectedPt.lat, expectedPt.lng).toFixed(2)} km，自動以電桿現場為準`);
          return null; // 回傳 null 自動觸發保底使用現場電桿圖號定位
        }
        return item;
      }
    }

    // 2. 同路名與同門牌號比對（同縣市與同行政區內）
    const roadMatch = rawAddr.match(/([^市縣區鄉鎮]+?[路街道巷弄])/);
    const numMatch = rawAddr.match(/(\d+(?:[-－之]\d+)?)/);
    if (roadMatch && numMatch) {
      const targetRoad = cleanAddrStr(roadMatch[1]);
      const targetNum = numMatch[1].replace(/[－之]/, "-");

      for (const item of results) {
        if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
        const itemAddr = cleanAddrStr(item.address);
        if (county && !itemAddr.includes(county)) continue;
        if (district && !itemAddr.includes(district)) continue;
        if (itemAddr.includes(targetRoad)) {
          const itemNumMatch = itemAddr.match(/(\d+(?:[-－之號]\d+)?)/);
          if (itemNumMatch && itemNumMatch[1].replace(/[－之號]/, "-") === targetNum) {
            if (expectedPt && getDistanceKm(item.y, item.x, expectedPt.lat, expectedPt.lng) > 0.3) {
              return null;
            }
            return item;
          }
        }
      }
    }

    // 嚴格原則：若輸入明確包含門牌號（如 9號），官方查無該號時，嚴禁降級取同路的別家號碼（如 43號）！
    // 尤其當已有電桿圖號時，直接退回現場電桿更為精準（現場掛表桿位）！
    return null;
  }

  async function geocodeDoorplate(addr, expectedPt) {
    const cleanAddr = String(addr || "").normalize("NFKC").trim();
    if (!cleanAddr) return null;

    if (doorplateCache.has(cleanAddr)) {
      const cached = doorplateCache.get(cleanAddr);
      if (cached && expectedPt && getDistanceKm(cached.lat, cached.lng, expectedPt.lat, expectedPt.lng) > 0.3) {
        return null;
      }
      return cached;
    }

    // 優先管道：GAS JSONP 經由代理向內政部國土測繪圖資查詢（無 CORS 限制）
    try {
      const data = await gasJsonpDoorplate(cleanAddr);
      if (data && (data.ok || Array.isArray(data.results)) && Array.isArray(data.results) && data.results.length > 0) {
        const item = findBestDoorplateMatch(cleanAddr, data.results, expectedPt);
        if (item && Number.isFinite(item.x) && Number.isFinite(item.y)) {
          const res = { lat: item.y, lng: item.x, fullAddr: item.address || cleanAddr };
          doorplateCache.set(cleanAddr, res);
          return res;
        }
      }
    } catch (e) {
      console.warn("門牌查詢失敗：", e.message);
    }
    doorplateCache.set(cleanAddr, null);
    return null;
  }

  // 自動解析 Excel 複製出來的文字 (TSV/CSV/Tab 分隔)
  function parseBatchInputText(text) {
    if (!text || typeof text !== "string") return [];

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (!lines.length) return [];

    const firstLine = lines[0];
    const isTab = firstLine.includes("\t");
    const delimiter = isTab ? "\t" : (firstLine.includes(",") ? "," : /\s+/);

    const rows = lines.map(l => {
      if (delimiter instanceof RegExp) {
        return l.split(delimiter);
      }
      return l.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ""));
    });

    let headerIdx = -1;
    let custNoCol = -1;
    let addrCol = -1;
    let poleCol = -1;
    let codeCol = -1;
    let meterNoCol = -1;
    let termCol = -1;

    for (let i = 0; i < Math.min(3, rows.length); i++) {
      const row = rows[i];
      const joined = row.join(" ");
      if (/(?:電號|地址|圖號|座標|表號|土木|桿|設備)/.test(joined)) {
        headerIdx = i;
        row.forEach((col, cIdx) => {
          const c = col.replace(/\s+/g, "");
          if (c.includes("電號")) custNoCol = cIdx;
          else if (c.includes("地址")) addrCol = cIdx;
          else if (c.includes("桿") || c.includes("土木") || c.includes("設備") || c.includes("變壓器") || c.includes("亭置") || c.includes("開關") || c.includes("箱體") || c.includes("支號")) poleCol = cIdx;
          else if (c.includes("圖號") || c.includes("座標")) codeCol = cIdx;
          else if (c.includes("表號")) meterNoCol = cIdx;
          else if (c.includes("檢定") || c.includes("期限")) termCol = cIdx;
        });
        break;
      }
    }

    const dataRows = headerIdx !== -1 ? rows.slice(headerIdx + 1) : rows;
    const records = [];

    for (const r of dataRows) {
      if (!r || !r.length) continue;

      let custNo = "";
      let addr = "";
      let pole = "";
      let code = "";
      let meterNo = "";
      let inspectTerm = "";

      if (custNoCol !== -1 && r[custNoCol]) custNo = r[custNoCol];
      if (addrCol !== -1 && r[addrCol]) addr = r[addrCol];
      if (poleCol !== -1 && r[poleCol]) pole = r[poleCol];
      if (codeCol !== -1 && r[codeCol]) code = r[codeCol];
      if (meterNoCol !== -1 && r[meterNoCol]) meterNo = r[meterNoCol];
      if (termCol !== -1 && r[termCol]) inspectTerm = r[termCol];

      // 智慧備援推斷
      if (addrCol === -1 || !addr) {
        for (const col of r) {
          if (/(?:市|縣|區|鄉|鎮|路|街|巷|段)/.test(col) && col.length >= 4) {
            addr = col;
            break;
          }
        }
      }

      if (codeCol === -1 || !code) {
        for (const col of r) {
          const m = col.match(/[A-HJ-Z]\d{4}[A-HJ-Z]{2}\d{2,4}/i);
          if (m) {
            code = m[0].toUpperCase();
            break;
          }
        }
      }

      if (custNoCol === -1 || !custNo) {
        for (const col of r) {
          if (/^\d{11}$/.test(col)) {
            custNo = col;
            break;
          }
        }
      }

      // 智慧備援推斷桿名 (土木設備)
      if (poleCol === -1 || !pole) {
        for (let colIdx = 0; colIdx < r.length; colIdx++) {
          if (colIdx === custNoCol || colIdx === addrCol || colIdx === codeCol || colIdx === meterNoCol || colIdx === termCol) continue;
          const col = r[colIdx];
          if (!col || typeof col !== "string") continue;
          const s = col.trim();
          if (s.length < 2 || s.length > 25) continue;
          if (/^\d+$/.test(s) || /^[A-Za-z0-9]+$/.test(s)) continue;
          if (/^\d{2,3}[/-]\d{2}$/.test(s)) continue;
          if (/亭置|變場|變壓器|配電|開關箱|開關|高幹|高分|配電室/.test(s)) {
            pole = s;
            break;
          }
          if (/[\u4e00-\u9fa5]/.test(s) && (/\d/.test(s) || /[左右分幹支號]/.test(s))) {
            if (!/(?:市|縣|區|鄉|鎮).*?[路街巷弄號]/.test(s)) {
              pole = s;
              break;
            }
          }
        }
      }

      // 標準化圖號座標
      code = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

      if (custNo || addr || code) {
        records.push({
          custNo,
          addr,
          pole,
          code,
          meterNo,
          inspectTerm,
          lat: null,
          lng: null,
          locType: null, // "doorplate" | "grid" | "fallback"
          locLabel: ""
        });
      }
    }

    return records;
  }

  // 範例資料（使用者上傳之新化區電表抽查清單）
  const SAMPLE_TEXT = `電號\t契約\t型式\t相別\t電表表號\t檢定期限\t用電地址\t土木設備\t圖號座標
10400167136\t15\t28\tD\t97011444\t106/04\t台南市新化區中正路８４７號\t新化54\tQ0999GB1201
10400168707\t15\t28\tD\t99102066\t108/10\t台南市新市區永就段９１１號\t新化6左8左5右10\tN0801BC02
10400218182\t15\t20\tD\t99071826\t108/08\t台南市新化區新化段太子廟小段２３３４，２３３５號\t新化57左1右2\tQ0998GE55
10400248348\t15\t27\tD\t88050595\t108/12\t台南市新化區正新北路１６號１樓\t新北4\tQ0998GC7900
10400249009\t15\t20\tD\t07821171\t109/05\t台南市新化區正新北路２號\t協興4\tQ0998GD57
10400550017\t15\t25\tD\t78059800\t109/05\t台南市新化區太平街１７號\t朝天5左2\tQ1098CA40
10400873073\t15\t25\tD\t01194031\t107/12\t台南市新化區太平街９９之７號二樓\t太平13\tQ0997FE64
10401316003\t16\t28\tD\t99154227\t109/01\t台南市新化區中山路３３０號\t亭置式變場\tQ1097BB13
10402023103\t15\t20\tD\t91177503\t110/10\t台南市新化區忠孝路１３７號\t正新7左4\tQ0997GD55
10402251667\t15\t20\tD\t91177419\t110/09\t台南市新化區正新路１４２號\t窄港3\tQ0996FD37
10402252452\t15\t25\tD\t85085030\t105/05\t台南市新化區信義路４４３巷４５號\t信義8左2\tQ0996EE51
10402505004\t16\t20\tD\t91178785\t110/09\t台南市新化區中山路５１８號\t亭置式變場\tQ0997EB5501
10403126018\t15\t25\tD\t01092093\t111/05\t台南市新化區唪口段１５３２號\t北勢94左9\tQ0998BB27`;

  // 模組狀態
  const state = {
    records: [],
    layerGroup: null,
    isProcessing: false,
    showLabels: true,       // 是否顯示批次電表永久標籤
    bgLabelsHidden: true,   // 是否已隱藏背景電桿標籤
  };

  const controls = {
    panel: null,
    toggle: null,
    close: null,
    tabs: null,
    input: null,
    startBtn: null,
    sampleBtn: null,
    fileBtn: null,
    fileInput: null,
    progress: null,
    progressText: null,
    progressFill: null,
    totalCount: null,
    doorplateCount: null,
    gridCount: null,
    tabCountBadge: null,
    list: null,
    fitBoundsBtn: null,
    exportBtn: null,
    clearAllBtn: null,
    toggleBgLabelsBtn: null,
    toggleLabelsBtn: null,
    driveUploadBtn: null,
    driveRestoreBtn: null,
    driveDeleteBtn: null,
    toBookmarksBtn: null,
    clearInputBtn: null,
    clearInputBtnTop: null,
    downloadJsonBtn: null,
    restoreJsonBtn: null,
    jsonFileInput: null,
  };

  function initControls() {
    controls.panel = document.getElementById("v2BatchMeterPanel");
    controls.toggle = document.getElementById("v2BatchMeterToggle");
    controls.close = document.getElementById("v2BatchMeterClose");
    controls.tabs = document.querySelectorAll('.v2-tab-btn[data-panel="batch"]');
    controls.input = document.getElementById("batchMeterInput");
    controls.startBtn = document.getElementById("batchMeterStartBtn");
    controls.sampleBtn = document.getElementById("batchMeterSampleBtn");
    controls.fileBtn = document.getElementById("batchMeterFileBtn");
    controls.fileInput = document.getElementById("batchMeterFileInput");
    controls.clearInputBtn = document.getElementById("batchMeterClearInputBtn");
    controls.clearInputBtnTop = document.getElementById("batchMeterClearInputBtnTop");
    controls.progress = document.getElementById("batchMeterProgress");
    controls.progressText = document.getElementById("batchMeterProgressText");
    controls.progressFill = document.getElementById("batchMeterProgressFill");
    controls.totalCount = document.getElementById("batchTotalCount");
    controls.doorplateCount = document.getElementById("batchDoorplateCount");
    controls.gridCount = document.getElementById("batchGridCount");
    controls.tabCountBadge = document.getElementById("v2BatchCount");
    controls.list = document.getElementById("batchMeterList");
    controls.fitBoundsBtn = document.getElementById("batchFitBoundsBtn");
    controls.exportBtn = document.getElementById("batchExportBtn");
    controls.clearAllBtn = document.getElementById("batchClearAllBtn");

    controls.toggleBgLabelsBtn = document.getElementById("batchToggleBgLabelsBtn");
    controls.toggleLabelsBtn = document.getElementById("batchToggleLabelsBtn");
    controls.driveUploadBtn = document.getElementById("batchDriveUploadBtn");
    controls.driveRestoreBtn = document.getElementById("batchDriveRestoreBtn");
    controls.driveDeleteBtn = document.getElementById("batchDriveDeleteBtn");
    controls.toBookmarksBtn = document.getElementById("batchToBookmarksBtn");
    controls.downloadJsonBtn = document.getElementById("batchDownloadJsonBtn");
    controls.restoreJsonBtn = document.getElementById("batchRestoreJsonBtn");
    controls.jsonFileInput = document.getElementById("batchJsonFileInput");
  }

  // 關閉其他面板 (使用全域互斥管理器)
  function closeOtherPanels() {
    if (window.__closeAllPanelsExcept) {
      window.__closeAllPanelsExcept("batch");
    } else {
      const s = document.getElementById("mapSearchPanel"), st = document.getElementById("mapSearchToggle");
      const lp = document.getElementById("layerMenuPanel"), lt = document.getElementById("layerMenuToggle");
      const cp = document.getElementById("v2CadastrePanel"), ct = document.getElementById("v2CadastreToggle");
      const ap = document.getElementById("v2AddressPanel"), at = document.getElementById("v2AddressToggle");
      const sp = document.getElementById("v2SyncPanel"), spt = document.getElementById("v2SyncToggle");
      s?.classList.remove("is-open"); st?.classList.remove("is-active"); st?.setAttribute("aria-expanded", "false");
      if (lp) lp.hidden = true; lt?.classList.remove("is-active"); lt?.setAttribute("aria-expanded", "false");
      cp?.classList.remove("is-open"); cp?.setAttribute("aria-hidden", "true"); ct?.classList.remove("is-active"); ct?.setAttribute("aria-expanded", "false");
      ap?.classList.remove("is-open"); ap?.setAttribute("aria-hidden", "true"); at?.classList.remove("is-active"); at?.setAttribute("aria-expanded", "false");
      sp?.classList.remove("is-open"); sp?.setAttribute("aria-hidden", "true"); spt?.classList.remove("is-active"); spt?.setAttribute("aria-expanded", "false");
    }
  }

  function setPanelOpen(open) {
    if (!controls.panel || !controls.toggle) return;
    if (open && !controls.panel.classList.contains("is-open")) {
      const e = new CustomEvent("v2-batch-open", { cancelable: true });
      if (!document.dispatchEvent(e)) return;
    }
    controls.panel.classList.toggle("is-open", open);
    controls.panel.setAttribute("aria-hidden", String(!open));
    controls.toggle.classList.toggle("is-active", open);
    controls.toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      closeOtherPanels();
      syncBgLabelsBtnWithMap();
    }
  }

  function switchTab(tabName) {
    controls.tabs.forEach(btn => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll('.v2-tab-pane[data-panel="batch"]').forEach(pane => {
      const active = pane.dataset.pane === tabName;
      pane.classList.toggle("is-active", active);
      pane.hidden = !active;
    });
  }

  // --- 背景電桿標籤隱藏與顯示控制 ---
  function hideBackgroundPoleLabels() {
    const btn = document.getElementById("toggleLabelsBtn");
    if (btn && !btn.classList.contains("is-hidden")) {
      btn.click();
    }
    updateBgLabelsBtnUI(true);
  }

  function showBackgroundPoleLabels() {
    const btn = document.getElementById("toggleLabelsBtn");
    if (btn && btn.classList.contains("is-hidden")) {
      btn.click();
    }
    updateBgLabelsBtnUI(false);
  }

  function toggleBackgroundPoleLabels() {
    const btn = document.getElementById("toggleLabelsBtn");
    if (btn) {
      btn.click();
      const isHidden = btn.classList.contains("is-hidden");
      updateBgLabelsBtnUI(isHidden);
      showToast(isHidden ? "🚫 已為您隱藏背景電桿與點位" : "👁️ 已還原背景電桿與點位");
    }
  }

  function syncBgLabelsBtnWithMap() {
    const btn = document.getElementById("toggleLabelsBtn");
    const isHidden = btn ? btn.classList.contains("is-hidden") : false;
    updateBgLabelsBtnUI(isHidden);
  }

  function updateBgLabelsBtnUI(hidden) {
    state.bgLabelsHidden = hidden;
    if (!controls.toggleBgLabelsBtn) return;
    if (hidden) {
      controls.toggleBgLabelsBtn.textContent = "🚫 背景電桿：已隱藏";
      controls.toggleBgLabelsBtn.classList.add("is-hidden-state");
      controls.toggleBgLabelsBtn.classList.remove("is-active");
    } else {
      controls.toggleBgLabelsBtn.textContent = "👁️ 背景電桿：顯示中";
      controls.toggleBgLabelsBtn.classList.remove("is-hidden-state");
      controls.toggleBgLabelsBtn.classList.add("is-active");
    }
  }

  // --- 批次電表標籤切換（Tooltip）---
  function toggleBatchLabels(force) {
    state.showLabels = typeof force === "boolean" ? force : !state.showLabels;
    if (controls.toggleLabelsBtn) {
      controls.toggleLabelsBtn.textContent = state.showLabels ? "🏷️ 電表標籤：顯示中" : "🏷️ 電表標籤：已隱藏";
      controls.toggleLabelsBtn.classList.toggle("is-active", state.showLabels);
      controls.toggleLabelsBtn.classList.toggle("is-hidden-state", !state.showLabels);
    }
    if (state.layerGroup) {
      state.layerGroup.eachLayer(layer => {
        if (layer.getTooltip()) {
          if (state.showLabels) {
            layer.openTooltip();
          } else {
            layer.closeTooltip();
          }
        }
      });
    }
  }

  // 核心執行流程：解析並批次定位
  async function runBatchGeocoding() {
    const rawText = controls.input.value.trim();
    if (!rawText) {
      showToast("請先在文字框貼上 Excel 清單資料！", "dup");
      controls.input.focus();
      return;
    }

    const records = parseBatchInputText(rawText);
    if (!records.length) {
      showToast("無法辨識資料，請確認是否包含用電地址或圖號座標！", "error");
      return;
    }

    state.isProcessing = true;
    controls.startBtn.disabled = true;
    controls.progress.style.display = "flex";
    controls.progressFill.style.width = "0%";
    controls.progressText.textContent = `準備定位 ${records.length} 筆電表...`;

    const total = records.length;
    let completed = 0;
    let doorplateSuccess = 0;
    let gridCount = 0;
    let fallbackCount = 0;

    const tpcFunc = window.tpcCodeToLatLng;
    const strategy = document.querySelector('input[name="batchLocStrategy"]:checked')?.value || "pole";

    // 多線程並行隊列（兼顧速度與官方防爬蟲限制，提速 3~4 倍）
    const CONCURRENCY = 3;
    let nextIndex = 0;

    async function processNextRecord() {
      while (nextIndex < total) {
        const i = nextIndex++;
        const r = records[i];
        const isParcel = isLandParcelAddress(r.addr);

        if (strategy === "pole") {
          // 【策略 A：電桿圖號優先（外勤換表/巡檢推薦，電桿掛表最準確）】
          if (r.code && typeof tpcFunc === "function") {
            const pt = tpcFunc(r.code);
            if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lng)) {
              r.lat = pt.lat;
              r.lng = pt.lng;
              r.locType = "grid";
              r.locLabel = "⚡ 圖號座標定位（現場掛表電桿）";
              gridCount++;
            }
          } else if (r.addr) {
            // 無圖號座標保底依門牌定位
            const geo = await geocodeDoorplate(r.addr, null);
            if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
              r.lat = geo.lat;
              r.lng = geo.lng;
              r.locType = "doorplate";
              r.locLabel = "🏠 電子門牌精準定位（用戶住家）";
              doorplateSuccess++;
            }
          }
        } else {
          // 【策略 B：智慧雙軌（門牌精確才用，相距逾300m或地號自動轉電桿現場）】
          if (isParcel) {
            // 是地號 ➔ 直接使用圖號座標精準反推現場電桿
            if (r.code && typeof tpcFunc === "function") {
              const pt = tpcFunc(r.code);
              if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lng)) {
                r.lat = pt.lat;
                r.lng = pt.lng;
                r.locType = "grid";
                r.locLabel = "⚡ 圖號座標定位（地號農電桿）";
                gridCount++;
              }
            }
          } else if (r.addr) {
            // 是一般門牌地址 ➔ 調用電子門牌定位（以電桿座標輔助檢核，偏差 > 300m 自動以電桿為準）
            let expectedPt = null;
            if (r.code && typeof tpcFunc === "function") {
              const pt = tpcFunc(r.code);
              if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lng)) {
                expectedPt = pt;
              }
            }

            const geo = await geocodeDoorplate(r.addr, expectedPt);
            if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
              r.lat = geo.lat;
              r.lng = geo.lng;
              r.locType = "doorplate";
              r.locLabel = "🏠 電子門牌精準定位（用戶住家）";
              doorplateSuccess++;
            } else if (expectedPt) {
              // 門牌查無、號碼不符或偏離現場逾300m ➔ 100% 保底轉用現場電桿圖號定位
              r.lat = expectedPt.lat;
              r.lng = expectedPt.lng;
              r.locType = "fallback";
              r.locLabel = "⚡ 門牌查無或偏離，轉用現場電桿圖號定位";
              fallbackCount++;
            }
          } else if (r.code && typeof tpcFunc === "function") {
            const pt = tpcFunc(r.code);
            if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lng)) {
              r.lat = pt.lat;
              r.lng = pt.lng;
              r.locType = "grid";
              r.locLabel = "⚡ 圖號座標定位";
              gridCount++;
            }
          }
        }

        // 智慧備援：若無桿名但有圖號座標，嘗試從電桿圖資 API 自動反查桿名 (含快取)
        if (!r.pole && r.code) {
          if (poleSearchCache.has(r.code)) {
            r.pole = poleSearchCache.get(r.code);
          } else {
            try {
              const resp = await fetch(`/api/search?q=${encodeURIComponent(r.code)}&limit=1`);
              if (resp.ok) {
                const data = await resp.json();
                if (Array.isArray(data) && data.length > 0 && data[0].name) {
                  r.pole = data[0].name;
                  poleSearchCache.set(r.code, r.pole);
                }
              }
            } catch {}
          }
        }

        completed++;
        const pct = Math.round((completed / total) * 100);
        controls.progressFill.style.width = `${pct}%`;
        controls.progressText.textContent = `正在定位 (${completed}/${total})：${r.addr || r.code || r.custNo}...`;
      }
    }

    const poolSize = Math.min(CONCURRENCY, total);
    const workers = [];
    for (let w = 0; w < poolSize; w++) {
      workers.push(processNextRecord());
    }
    await Promise.all(workers);

    state.records = records.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    state.isProcessing = false;
    controls.startBtn.disabled = false;
    controls.progress.style.display = "none";

    // 儲存至本地快取
    try {
      localStorage.setItem("tp_batch_meter_bookmarks_v1", JSON.stringify(state.records));
    } catch {}

    // 自動隱藏雜亂之背景電桿標籤
    hideBackgroundPoleLabels();

    // 繪製地圖標記、文字標籤與清單卡片
    renderBatchMarkers();
    renderBatchList();
    updateSummaryBadges(doorplateSuccess, gridCount, fallbackCount);

    // 切換至結果頁
    switchTab("list");

    const map = getMap();
    if (map && state.layerGroup && state.records.length > 0) {
      const bounds = state.layerGroup.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
      }
    }

    showToast(`🎉 批次標記完成！成功定位 ${state.records.length} / ${total} 筆電表（已自動隱藏背景電桿標籤）`);
  }

  function updateSummaryBadges(dp, grid, fallback) {
    if (dp === undefined) {
      dp = state.records.filter(r => r.locType === "doorplate").length;
      grid = state.records.filter(r => r.locType === "grid").length;
      fallback = state.records.filter(r => r.locType === "fallback").length;
    }
    if (controls.totalCount) controls.totalCount.textContent = state.records.length;
    if (controls.doorplateCount) controls.doorplateCount.textContent = dp;
    if (controls.gridCount) controls.gridCount.textContent = grid + fallback;
    if (controls.tabCountBadge) controls.tabCountBadge.textContent = state.records.length;
  }

  // 繪製地圖標記點與醒目文字標籤
  function renderBatchMarkers() {
    const map = getMap();
    if (!map || !window.L) return;

    if (!state.layerGroup) {
      state.layerGroup = L.featureGroup().addTo(map);
    } else {
      state.layerGroup.clearLayers();
    }

    state.records.forEach((r, idx) => {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return;

      const badgeClass = r.locType === "doorplate" ? "is-doorplate" : r.locType === "fallback" ? "is-fallback" : "is-grid";
      const icon = L.divIcon({
        className: "batch-marker-divicon",
        html: `<div class="batch-marker-pin ${badgeClass}" title="#${idx + 1} ${escapeHtml(r.addr || r.code)}">${idx + 1}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -14]
      });

      const marker = L.marker([r.lat, r.lng], { icon });

      // 地圖上的永久醒目標籤 (Batch Map Label Tooltip)
      const labelHtml = `
        <div class="batch-map-label ${badgeClass}">
          <span class="batch-label-index">#${idx + 1}</span>
          <span class="batch-label-text">${escapeHtml(r.addr || r.code || r.custNo)}</span>
          ${r.pole ? `<span class="batch-label-pole">(${escapeHtml(r.pole)})</span>` : ""}
        </div>
      `;
      marker.bindTooltip(labelHtml, {
        permanent: state.showLabels !== false,
        direction: "top",
        offset: [0, -14],
        className: "batch-meter-map-tooltip"
      });

      // 點擊彈出詳細資訊卡
      const typeBadge = r.locType === "doorplate"
        ? `<span style="background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:700;">🏠 門牌定位</span>`
        : `<span style="background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:700;">⚡ 圖號定位</span>`;

      const navUrl = googleNavUrl(r.lat, r.lng);

      const popupHtml = `
        <div class="batch-popup-card" style="min-width:230px;line-height:1.5;font-size:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin-bottom:6px;">
            <strong style="color:#0f766e;font-size:13px;">#${idx + 1} 電號 ${escapeHtml(r.custNo || "--")}</strong>
            ${typeBadge}
          </div>
          <div style="color:#334155;">📍 <strong>地址：</strong>${escapeHtml(r.addr || "--")}</div>
          <div style="color:#334155;">⚡ <strong>設備：</strong>${escapeHtml(r.pole || "--")}</div>
          <div style="color:#334155;">🗺️ <strong>圖號：</strong><span style="font-family:monospace;font-weight:700;color:#0f766e;">${escapeHtml(r.code || "--")}</span></div>
          ${r.meterNo ? `<div style="color:#64748b;">🔢 表號：${escapeHtml(r.meterNo)}</div>` : ""}
          ${r.inspectTerm ? `<div style="color:#64748b;">📅 檢定：${escapeHtml(r.inspectTerm)}</div>` : ""}
          <div style="font-size:11px;color:#047857;margin-top:4px;padding:3px 6px;background:#f0fdf4;border-radius:4px;">
            ↳ ${escapeHtml(r.locLabel)}
          </div>
          <div class="v2-cadastre-popup-actions" style="margin-top:8px;display:flex;gap:6px;">
            <a class="popup-navigation-link" href="${navUrl}" target="_blank" rel="noopener" style="flex:1;text-align:center;justify-content:center;">
              🗺️ 導航
            </a>
            <button type="button" class="batch-remove-single-btn" data-remove-idx="${idx}" style="flex:1;background:#fef2f2;color:#dc2626;border:1px solid #fecdd3;border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;min-height:28px;padding:4px 8px;">
              ✕ 移除本點
            </button>
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml, { maxWidth: 300, className: "batch-meter-popup" });
      state.layerGroup.addLayer(marker);
      r.marker = marker;
    });
  }

  // 渲染分頁 2 的結果卡片
  function renderBatchList() {
    if (!controls.list) return;
    if (!state.records.length) {
      controls.list.innerHTML = `<div style="text-align:center;padding:24px 8px;color:#94a3b8;font-size:12px;">尚未標記任何電表，請在第一頁貼上並點擊開始標記。</div>`;
      return;
    }

    const html = state.records.map((r, idx) => {
      const typeBadge = r.locType === "doorplate"
        ? `<span style="background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">🏠 門牌</span>`
        : `<span style="background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;">⚡ 圖號</span>`;

      return `
        <div class="v2-batch-item" data-meter-idx="${idx}">
          <div class="v2-batch-item-title">
            <span>#${idx + 1} ${escapeHtml(r.addr || r.code || r.custNo)}</span>
            ${typeBadge}
          </div>
          <div class="v2-batch-item-meta">
            <span>電號: ${escapeHtml(r.custNo || "--")}</span> · <span>桿名: ${escapeHtml(r.pole || "--")}</span> · <span>圖號: ${escapeHtml(r.code || "--")}</span>
          </div>
        </div>
      `;
    }).join("");

    controls.list.innerHTML = html;

    // 綁定卡片點擊聚焦
    controls.list.querySelectorAll(".v2-batch-item").forEach(el => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.meterIdx, 10);
        const r = state.records[idx];
        const map = getMap();
        if (map && r && Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
          map.flyTo([r.lat, r.lng], Math.max(map.getZoom(), 17), { duration: 0.8 });
          if (r.marker) {
            setTimeout(() => r.marker.openPopup(), 400);
          }
        }
      });
    });
  }

  // 匯出帶座標與導航連結的 Excel
  async function exportToExcel() {
    if (!state.records.length) {
      showToast("沒有標記結果可匯出！", "dup");
      return;
    }

    try {
      await ensureXLSX();
      const exportRows = [
        ["編號", "電號", "用電地址", "土木設備(桿名)", "圖號座標", "電表表號", "檢定期限", "定位型態", "緯度(Lat)", "經度(Lng)", "Google導航網址"]
      ];

      state.records.forEach((r, idx) => {
        exportRows.push([
          idx + 1,
          r.custNo || "",
          r.addr || "",
          r.pole || "",
          r.code || "",
          r.meterNo || "",
          r.inspectTerm || "",
          r.locLabel || "",
          Number(r.lat.toFixed(6)),
          Number(r.lng.toFixed(6)),
          googleNavUrl(r.lat, r.lng)
        ]);
      });

      const ws = XLSX.utils.aoa_to_sheet(exportRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "批次電表標記");
      const dateStr = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `台電電表標記清單_${dateStr}.xlsx`);
      showToast("📥 Excel 檔案已順利下載！");
    } catch (e) {
      showToast("匯出失敗：" + e.message, "error");
    }
  }

  function getCleanRecords() {
    return state.records.map(r => ({
      custNo: r.custNo || "",
      addr: r.addr || "",
      pole: r.pole || "",
      code: r.code || "",
      meterNo: r.meterNo || "",
      inspectTerm: r.inspectTerm || "",
      locType: r.locType || "grid",
      locLabel: r.locLabel || "",
      lat: r.lat,
      lng: r.lng,
      raw: r.raw || null
    }));
  }

  // --- 本機檔案備份與讀取 (免登入、公司內網最佳、外勤手機零門檻互傳) ---
  function downloadBatchJson() {
    if (!state.records.length) {
      showToast("目前沒有批次電表標記可下載！", "dup");
      return;
    }
    const cleanRecords = getCleanRecords();
    const jsonStr = JSON.stringify(cleanRecords, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    const filename = `批次電表標記_${timeStr}.json`;

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    showToast(`💾 已下載 ${cleanRecords.length} 筆電表備份檔 (${filename})！`);
  }

  function restoreBatchJson(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
          showToast("備份檔格式不符（須為 JSON 陣列）！", "error");
          return;
        }
        if (!parsed.length) {
          showToast("備份檔為空資料！", "dup");
          return;
        }
        state.records = parsed;
        localStorage.setItem("tp_batch_meter_bookmarks_v1", JSON.stringify(state.records));
        hideBackgroundPoleLabels();
        renderBatchMarkers();
        renderBatchList();
        updateSummaryBadges();
        switchTab("list");
        const map = getMap();
        if (map && state.layerGroup) {
          const bounds = state.layerGroup.getBounds();
          if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
        }
        showToast(`📂 成功還原 ${state.records.length} 筆電表標記！`);
      } catch (err) {
        showToast("解析備份檔失敗：" + err.message, "error");
      }
    };
    reader.readAsText(file, "utf-8");
  }

  // --- Google Drive 備份、還原與刪除 (獨立批次電表清單) ---
  window.__getBatchRecords = () => getCleanRecords();

  function uploadBatchToDrive() {
    if (!state.records.length) {
      showToast("目前沒有批次電表標記可上傳！", "dup");
      return;
    }
    const clean = getCleanRecords();
    localStorage.setItem("tp_batch_meter_bookmarks_v1", JSON.stringify(clean));
    if (window.__bookmarkDrive) {
      window.__bookmarkDrive.upload("batch");
    } else {
      showToast("Google Drive 模組尚未就緒，請稍候重試", "error");
    }
  }

  function restoreBatchFromDrive() {
    if (window.__bookmarkDrive) {
      window.__bookmarkDrive.restore("batch");
    } else {
      showToast("Google Drive 模組尚未就緒，請稍候重試", "error");
    }
  }

  function deleteBatchFromDrive() {
    if (window.__bookmarkDrive) {
      window.__bookmarkDrive.deleteCloud("batch");
    } else {
      showToast("Google Drive 模組尚未就緒，請稍候重試", "error");
    }
  }

  // --- 轉存至門牌收藏 ---
  function saveToAddressBookmarks() {
    if (!state.records.length) {
      showToast("目前沒有標記資料可轉存！", "dup");
      return;
    }
    try {
      const key = "tp_address_bookmarks_v1";
      let existing = [];
      try { existing = JSON.parse(localStorage.getItem(key) || "[]"); } catch { existing = []; }
      const now = new Date().toISOString();
      let added = 0;
      state.records.forEach((r, i) => {
        const id = `bm_batch_${Date.now()}_${i}`;
        const addrText = r.addr || r.custNo || "批次電表標記";
        const poleText = r.pole || "";
        const codeText = r.code || "";
        const custNoText = r.custNo || "";
        const detailParts = [];
        if (custNoText) detailParts.push(`電號: ${custNoText}`);
        if (poleText) detailParts.push(`桿名: ${poleText}`);
        if (codeText) detailParts.push(`圖號: ${codeText}`);
        const detailText = detailParts.join(" · ");

        existing.unshift({
          id,
          addr: addrText,
          address: addrText,
          custNo: custNoText,
          pole: poleText,
          code: codeText,
          detail: detailText,
          la: r.lat,
          ln: r.lng,
          lat: r.lat,
          lng: r.lng,
          visible: true,
          createdAt: now
        });
        added++;
      });
      localStorage.setItem(key, JSON.stringify(existing));
      if (window.__bookmarkDB) {
        window.__bookmarkDB.saveBookmarks("address", existing).catch(() => {});
      }
      window.dispatchEvent(new CustomEvent("bookmarksRestored"));
      showToast(`⭐ 已成功將 ${added} 筆電表轉存至「門牌收藏」！可在「🏠 門牌 ➔ ⭐ 收藏」中檢視`);
    } catch (e) {
      showToast("轉存失敗：" + e.message, "error");
    }
  }

  // 清空所有標記
  function clearAllMarkers() {
    if (!state.records.length) return;
    if (state.layerGroup) state.layerGroup.clearLayers();
    state.records = [];
    localStorage.removeItem("tp_batch_meter_bookmarks_v1");
    renderBatchList();
    updateSummaryBadges(0, 0, 0);
    showToast("已清空批次電表標記");
  }

  // 綁定所有使用者介面事件
  function bindEvents() {
    document.addEventListener("v2-cadastre-open", () => setPanelOpen(false));
    document.addEventListener("v2-address-open", () => setPanelOpen(false));
    document.addEventListener("v2-inspection-open", () => setPanelOpen(false));
    document.addEventListener("v2-search-open", () => setPanelOpen(false));
    document.addEventListener("v2-layer-open", () => setPanelOpen(false));

    controls.toggle?.addEventListener("click", () => setPanelOpen(!controls.panel?.classList.contains("is-open")));
    controls.close?.addEventListener("click", () => setPanelOpen(false));

    controls.tabs?.forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    controls.sampleBtn?.addEventListener("click", () => {
      if (controls.input) {
        controls.input.value = SAMPLE_TEXT;
        showToast("已載入新化區測試範例資料！請點擊開始標記");
      }
    });

    function handleClearInput() {
      if (controls.input) {
        controls.input.value = "";
        controls.input.focus();
        showToast("已清空輸入框內容");
      }
    }
    controls.clearInputBtn?.addEventListener("click", handleClearInput);
    controls.clearInputBtnTop?.addEventListener("click", handleClearInput);

    controls.startBtn?.addEventListener("click", runBatchGeocoding);

    controls.fileBtn?.addEventListener("click", () => controls.fileInput?.click());
    controls.fileInput?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await ensureXLSX();
        const reader = new FileReader();
        reader.onload = evt => {
          try {
            const data = new Uint8Array(evt.target.result);
            const workbook = XLSX.read(data, { type: "array" });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const tsv = XLSX.utils.sheet_to_csv(firstSheet, { FS: "\t" });
            if (controls.input) {
              controls.input.value = tsv;
              showToast(`成功讀取「${file.name}」，已填入輸入框！請點擊開始標記`);
            }
          } catch (err) {
            showToast("檔案讀取失敗：" + err.message, "error");
          }
        };
        reader.readAsArrayBuffer(file);
      } catch (err) {
        showToast("解析失敗：" + err.message, "error");
      }
    });

    controls.fitBoundsBtn?.addEventListener("click", () => {
      const map = getMap();
      if (map && state.layerGroup && state.records.length > 0) {
        const bounds = state.layerGroup.getBounds();
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
        }
      }
    });

    controls.exportBtn?.addEventListener("click", exportToExcel);
    controls.clearAllBtn?.addEventListener("click", clearAllMarkers);

    // 標籤控制
    controls.toggleBgLabelsBtn?.addEventListener("click", toggleBackgroundPoleLabels);
    controls.toggleLabelsBtn?.addEventListener("click", () => toggleBatchLabels());

    // 本機檔案備份與還原 (公司內網 / 手機互傳)
    controls.downloadJsonBtn?.addEventListener("click", downloadBatchJson);
    controls.restoreJsonBtn?.addEventListener("click", () => controls.jsonFileInput?.click());
    controls.jsonFileInput?.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) restoreBatchJson(file);
      e.target.value = "";
    });

    // 雲端備份與門牌收藏
    controls.driveUploadBtn?.addEventListener("click", uploadBatchToDrive);
    controls.driveRestoreBtn?.addEventListener("click", restoreBatchFromDrive);
    controls.driveDeleteBtn?.addEventListener("click", deleteBatchFromDrive);
    controls.toBookmarksBtn?.addEventListener("click", saveToAddressBookmarks);

    syncBgLabelsBtnWithMap();

    // 監聽標籤/點位圖層切換事件，實現與圖層控制選單雙向即時連動
    window.addEventListener("poleLabelsToggled", (e) => {
      const isHidden = e && e.detail && typeof e.detail.hidden === "boolean"
        ? e.detail.hidden
        : (document.getElementById("toggleLabelsBtn")?.classList.contains("is-hidden") || false);
      updateBgLabelsBtnUI(isHidden);
    });

    // 監聽 Drive 還原事件
    window.addEventListener("batchMetersRestored", () => {
      try {
        const saved = JSON.parse(localStorage.getItem("tp_batch_meter_bookmarks_v1") || "[]");
        if (Array.isArray(saved) && saved.length > 0) {
          state.records = saved;
          hideBackgroundPoleLabels();
          renderBatchMarkers();
          renderBatchList();
          updateSummaryBadges();
          switchTab("list");
          const map = getMap();
          if (map && state.layerGroup) {
            const bounds = state.layerGroup.getBounds();
            if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
          }
          showToast(`☁️ 已從 Google Drive 還原 ${saved.length} 筆批次電表！`);
        }
      } catch {}
    });

    // 監聽彈窗單筆移除
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".batch-remove-single-btn");
      if (btn) {
        const idx = parseInt(btn.dataset.removeIdx, 10);
        if (!isNaN(idx) && state.records[idx]) {
          const removed = state.records.splice(idx, 1)[0];
          if (removed.marker && state.layerGroup) {
            state.layerGroup.removeLayer(removed.marker);
          }
          renderBatchMarkers();
          renderBatchList();
          updateSummaryBadges();
          getMap()?.closePopup();
          showToast("已移除該筆標記");
        }
      }
    });
  }

  // 嘗試還原本地暫存
  function restoreLocalCachedBatch() {
    try {
      const cached = JSON.parse(localStorage.getItem("tp_batch_meter_bookmarks_v1") || "[]");
      if (Array.isArray(cached) && cached.length > 0) {
        state.records = cached;
        renderBatchMarkers();
        renderBatchList();
        updateSummaryBadges();
      }
    } catch {}
  }

  function boot(attempt = 0) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => boot(0), { once: true });
      return;
    }
    initControls();
    bindEvents();
    restoreLocalCachedBatch();

    const map = getMap();
    if (!map && attempt < 40) {
      setTimeout(() => boot(attempt + 1), 100);
      return;
    }
  }

  boot();
})();
