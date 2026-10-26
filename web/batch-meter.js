/**
 * 批次電表清單標記 (Batch Meter Marker Module)
 * 專為台電抄表、換表、抽查、檢修清單打造的極速批次定位工具
 *
 * 核心規則：
 * 1. 有路名門牌地址 ➔ 自動以電子門牌 (NLSC) 精準定位至用戶住家
 * 2. 是地號（段/小段/農電/無路名） ➔ 自動以圖號座標秒級反推至現場掛表桿位
 * 3. 門牌查無保底 ➔ 自動轉用圖號座標補全定位，確保 100% 都有定位點
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
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 2200);
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
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat.toFixed(6) + "," + lng.toFixed(6))}`;
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

  // 電子門牌經緯度查詢（支援 Adapter 與 GAS JSONP 雙通道，跨域零障礙）
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

  async function geocodeDoorplate(addr) {
    const cleanAddr = String(addr || "").normalize("NFKC").trim();
    if (!cleanAddr) return null;

    // 優先管道 1：後端 Adapter（本機 Vite 或 Vercel Serverless API）
    if (window.CADASTRE_ADAPTER_URL) {
      try {
        const url = `${window.CADASTRE_ADAPTER_URL}?action=addrGeo&word=${encodeURIComponent(cleanAddr)}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data && (data.ok || Array.isArray(data.results)) && Array.isArray(data.results) && data.results.length > 0) {
            const item = data.results[0];
            if (Number.isFinite(item.x) && Number.isFinite(item.y)) {
              return { lat: item.y, lng: item.x, fullAddr: item.address || cleanAddr };
            }
          }
        }
      } catch (e) {
        // 後端若無回應則平滑降級至 JSONP
      }
    }

    // 備援管道 2：GAS JSONP（無 CORS 限制，於 GitHub Pages 與任何靜態環境通殺）
    try {
      const data = await gasJsonpDoorplate(cleanAddr);
      if (data && (data.ok || Array.isArray(data.results)) && Array.isArray(data.results) && data.results.length > 0) {
        const item = data.results[0];
        if (Number.isFinite(item.x) && Number.isFinite(item.y)) {
          return { lat: item.y, lng: item.x, fullAddr: item.address || cleanAddr };
        }
      }
    } catch (e) {
      console.warn("門牌查詢失敗：", e.message);
    }
    return null;
  }

  // 解析使用者貼上的一整批文字（支援 Tab 分隔與 CSV 分隔）
  function parseBatchInputText(text) {
    if (!text || !text.trim()) return [];
    const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];

    const firstLine = lines[0];
    const sep = firstLine.includes("\t") ? "\t" : ",";
    const matrix = lines.map(line => {
      return sep === "\t" ? line.split("\t").map(c => c.trim()) : line.split(",").map(c => c.trim().replace(/^["']|["']$/g, ""));
    });

    let startIndex = 0;
    let headerMap = null;
    const firstRow = matrix[0].map(s => s.toLowerCase());
    const hasHeader = firstRow.some(col =>
      col.includes("電號") || col.includes("地址") || col.includes("圖號") || col.includes("設備") || col.includes("表號")
    );

    if (hasHeader) {
      startIndex = 1;
      headerMap = {};
      firstRow.forEach((col, idx) => {
        if (col.includes("電號")) headerMap.custNo = idx;
        else if (col.includes("地址")) headerMap.addr = idx;
        else if (col.includes("圖號") || col.includes("座標")) headerMap.code = idx;
        else if (col.includes("設備") || col.includes("桿名") || col.includes("桿號")) headerMap.pole = idx;
        else if (col.includes("表號")) headerMap.meterNo = idx;
        else if (col.includes("檢定")) headerMap.expiry = idx;
      });
    }

    const records = [];
    for (let i = startIndex; i < matrix.length; i++) {
      const row = matrix[i];
      if (!row || row.length === 0 || (row.length === 1 && !row[0])) continue;

      let custNo = "", addr = "", pole = "", code = "", meterNo = "", expiry = "";

      if (headerMap) {
        if (headerMap.custNo !== undefined) custNo = row[headerMap.custNo] || "";
        if (headerMap.addr !== undefined) addr = row[headerMap.addr] || "";
        if (headerMap.pole !== undefined) pole = row[headerMap.pole] || "";
        if (headerMap.code !== undefined) code = row[headerMap.code] || "";
        if (headerMap.meterNo !== undefined) meterNo = row[headerMap.meterNo] || "";
        if (headerMap.expiry !== undefined) expiry = row[headerMap.expiry] || "";
      } else {
        // 智慧欄位推測
        for (const cell of row) {
          const val = String(cell || "").trim();
          if (!val) continue;

          // 1. 台電圖號座標 (例如 Q0999GB1201, N0801BC02, Q0998GE55)
          if (!code && /^[A-Z]\d{4}[A-H][A-E]\d{2}(?:\d{2})?$/i.test(val)) {
            code = val.toUpperCase();
            continue;
          }
          // 2. 電號 (11碼純數字)
          if (!custNo && /^\d{11}$/.test(val)) {
            custNo = val;
            continue;
          }
          // 3. 檢定期限 (例如 106/04, 108/10)
          if (!expiry && /^\d{2,3}\/\d{2}$/.test(val)) {
            expiry = val;
            continue;
          }
          // 4. 電表表號 (8碼數字)
          if (!meterNo && /^\d{8}$/.test(val)) {
            meterNo = val;
            continue;
          }
          // 5. 用電地址 (含路、街、段、號等關鍵字)
          if (!addr && (/(?:市|縣|區|鄉|鎮|路|街|段)/.test(val) && (val.includes("號") || val.includes("路") || val.includes("段")))) {
            addr = val;
            continue;
          }
          // 6. 土木設備桿名 (如 新化54, 新北4, 朝天5左2, 亭置式變場)
          if (!pole && (/(?:桿|變場|左|右|正新|朝天|忠孝|新化|新北|協興|太平|仁愛|窄港|信義|健康)/.test(val) || (val.length >= 2 && val.length <= 15 && !/^\d+$/.test(val)))) {
            pole = val;
          }
        }
      }

      addr = String(addr || "").normalize("NFKC").trim();
      code = String(code || "").toUpperCase().trim();

      if (addr || code || custNo) {
        records.push({
          id: `meter_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          index: records.length + 1,
          custNo,
          addr,
          pole,
          code,
          meterNo,
          expiry,
          lat: null,
          lng: null,
          locType: null, // "doorplate" | "grid" | "fallback"
          locLabel: ""
        });
      }
    }

    return records;
  }

  // 範例資料（取自使用者上傳之新化區清單）
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
  }

  function closeOtherFloatingPanels() {
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

  function setPanelOpen(open) {
    if (!controls.panel || !controls.toggle) return;
    if (open && !controls.panel.classList.contains("is-open")) {
      const e = new CustomEvent("v2-batch-meter-open", { cancelable: true });
      if (!document.dispatchEvent(e)) return;
    }
    controls.panel.classList.toggle("is-open", open);
    controls.panel.setAttribute("aria-hidden", String(!open));
    controls.toggle.classList.toggle("is-active", open);
    controls.toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      closeOtherFloatingPanels();
      if (controls.input && !controls.input.value) controls.input.focus();
    }
  }

  document.addEventListener("v2-cadastre-open", () => setPanelOpen(false));
  document.addEventListener("v2-address-open", () => setPanelOpen(false));
  document.addEventListener("v2-inspection-open", () => setPanelOpen(false));

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

  // 核心執行程序：智慧分流批次定位
  async function runBatchGeocoding() {
    const rawText = controls.input.value.trim();
    if (!rawText) {
      showToast("請先在文字框貼上 Excel 清單資料！", "dup");
      controls.input.focus();
      return;
    }

    const records = parseBatchInputText(rawText);
    if (!records.length) {
      showToast("無法辨識資料，請確認是否包含用電地址或圖號座標欄位！", "error");
      return;
    }

    state.isProcessing = true;
    controls.startBtn.disabled = true;
    controls.progress.style.display = "flex";
    controls.progressFill.style.width = "0%";
    controls.progressText.textContent = `準備解析 ${records.length} 筆電表...`;

    const total = records.length;
    let completed = 0;
    let doorplateSuccess = 0;
    let gridCount = 0;
    let fallbackCount = 0;

    const tpcFunc = window.tpcCodeToLatLng;

    // 依序處理（門牌帶小延遲防止被阻擋，地號直接秒算）
    for (let i = 0; i < total; i++) {
      const r = records[i];
      const isParcel = isLandParcelAddress(r.addr);

      if (isParcel) {
        // 規則 1：是地號 ➔ 直接用圖號座標秒級反推
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
        // 規則 2：是一般門牌地址 ➔ 呼叫電子門牌定位
        const geo = await geocodeDoorplate(r.addr);
        if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
          r.lat = geo.lat;
          r.lng = geo.lng;
          r.locType = "doorplate";
          r.locLabel = "🏠 電子門牌精準定位（用戶住家）";
          doorplateSuccess++;
        } else if (r.code && typeof tpcFunc === "function") {
          // 門牌查無 ➔ 保底轉用圖號座標
          const pt = tpcFunc(r.code);
          if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lng)) {
            r.lat = pt.lat;
            r.lng = pt.lng;
            r.locType = "fallback";
            r.locLabel = "🛡️ 門牌查無，轉用圖號座標定位";
            fallbackCount++;
          }
        }
        // 微量間隔保持網路順暢
        await new Promise(res => setTimeout(res, 60));
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

      completed++;
      const pct = Math.round((completed / total) * 100);
      controls.progressFill.style.width = `${pct}%`;
      controls.progressText.textContent = `正在定位 (${completed}/${total})：${r.addr || r.code || r.custNo}...`;
    }

    state.records = records.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    state.isProcessing = false;
    controls.startBtn.disabled = false;
    controls.progress.style.display = "none";

    // 渲染地圖與列表
    renderBatchMarkers();
    renderBatchList();
    updateSummaryBadges(doorplateSuccess, gridCount, fallbackCount);

    // 切換至清單分頁
    switchTab("list");

    const map = getMap();
    if (map && state.layerGroup && state.records.length > 0) {
      const bounds = state.layerGroup.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
      }
    }

    showToast(`✅ 批次標記完成！成功定位 ${state.records.length} / ${total} 筆電表`);
  }

  function updateSummaryBadges(dp, grid, fallback) {
    if (controls.totalCount) controls.totalCount.textContent = state.records.length;
    if (controls.doorplateCount) controls.doorplateCount.textContent = dp;
    if (controls.gridCount) controls.gridCount.textContent = grid + fallback;
    if (controls.tabCountBadge) controls.tabCountBadge.textContent = state.records.length;
  }

  // 繪製地圖標記點
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

      const marker = L.marker([r.lat, r.lng], { icon, zIndexOffset: 800 });

      const popupHtml = `
        <div class="v2-cadastre-popup" style="min-width:240px;line-height:1.5;">
          <div style="border-bottom:1px solid #e2e8f0;padding-bottom:5px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">
            <strong style="color:#0f766e;font-size:14px;">#${idx + 1} 電號 ${escapeHtml(r.custNo || "未填寫")}</strong>
            <span style="font-size:10px;padding:1px 5px;border-radius:4px;font-weight:700;${r.locType === 'doorplate' ? 'background:#ecfdf5;color:#065f46;' : 'background:#eff6ff;color:#1e40af;'}">
              ${r.locType === 'doorplate' ? '🏠 門牌定位' : '⚡ 圖號定位'}
            </span>
          </div>
          <div style="font-size:12px;display:grid;gap:2px;">
            <div>📍 地址：<strong>${escapeHtml(r.addr || "--")}</strong></div>
            <div>⚡ 設備：<strong>${escapeHtml(r.pole || "--")}</strong></div>
            <div>🗺️ 圖號：<strong>${escapeHtml(r.code || "--")}</strong></div>
            ${r.meterNo ? `<div>🔢 表號：<strong>${escapeHtml(r.meterNo)}</strong></div>` : ""}
            ${r.expiry ? `<div>📅 檢定：<strong>${escapeHtml(r.expiry)}</strong></div>` : ""}
            <div style="font-size:11px;color:#64748b;margin-top:2px;">↳ ${escapeHtml(r.locLabel)}</div>
          </div>
          <div class="v2-cadastre-popup-actions" style="margin-top:8px;padding-top:6px;border-top:1px solid #f1f5f9;display:flex;gap:6px;">
            <a class="popup-navigation-link" href="${googleNavUrl(r.lat, r.lng)}" target="_blank" rel="noopener" style="flex:1;text-align:center;">🗺️ 導航</a>
            <button type="button" class="popup-clear-location-button" data-remove-meter-idx="${idx}" style="flex:1;">✕ 移除本點</button>
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml);
      marker.addTo(state.layerGroup);
      r._marker = marker;
    });

    // 委派彈窗內的移除按鈕
    map.on("popupopen", (e) => {
      const popupNode = e.popup?.getElement();
      if (!popupNode) return;
      const removeBtn = popupNode.querySelector("[data-remove-meter-idx]");
      if (removeBtn) {
        removeBtn.onclick = () => {
          const removeIdx = parseInt(removeBtn.getAttribute("data-remove-meter-idx"), 10);
          if (!isNaN(removeIdx) && state.records[removeIdx]) {
            const removed = state.records.splice(removeIdx, 1)[0];
            if (removed?._marker) state.layerGroup.removeLayer(removed._marker);
            map.closePopup();
            renderBatchMarkers();
            renderBatchList();
            showToast("已移除該電表標記");
          }
        };
      }
    });
  }

  // 渲染分頁 2 的結果清單
  function renderBatchList() {
    if (!controls.list) return;
    if (!state.records.length) {
      controls.list.innerHTML = `<div style="text-align:center;padding:24px 8px;color:#94a3b8;font-size:12px;">尚未標記任何電表，請在第一頁貼上資料並點擊開始標記。</div>`;
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

    // 點擊清單項目飛至該點
    controls.list.querySelectorAll(".v2-batch-item").forEach(item => {
      item.onclick = () => {
        const idx = parseInt(item.dataset.meterIdx, 10);
        const r = state.records[idx];
        const map = getMap();
        if (map && r && Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
          if (window.matchMedia("(max-width: 768px)").matches) {
            setPanelOpen(false); // 手機端點選後自動收合面板查看地圖
          }
          map.flyTo([r.lat, r.lng], 19, { duration: 0.5 });
          window.setTimeout(() => {
            if (r._marker) r._marker.openPopup();
          }, 550);
        }
      };
    });
  }

  // 匯出帶有座標與導航連結的 Excel 表格
  async function exportToExcel() {
    if (!state.records.length) {
      showToast("目前沒有可匯出的標記紀錄", "dup");
      return;
    }

    try {
      await ensureXLSX();
      const exportRows = [
        ["項次", "電號", "用電地址", "土木設備(桿名)", "圖號座標", "電表表號", "檢定期限", "定位方式", "緯度(Lat)", "經度(Lng)", "Google導航網址"]
      ];

      state.records.forEach((r, idx) => {
        exportRows.push([
          idx + 1,
          r.custNo || "",
          r.addr || "",
          r.pole || "",
          r.code || "",
          r.meterNo || "",
          r.expiry || "",
          r.locLabel || (r.locType === "doorplate" ? "電子門牌" : "圖號座標"),
          r.lat ? Number(r.lat.toFixed(6)) : "",
          r.lng ? Number(r.lng.toFixed(6)) : "",
          r.lat && r.lng ? googleNavUrl(r.lat, r.lng) : ""
        ]);
      });

      const ws = XLSX.utils.aoa_to_sheet(exportRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "電表定位清單");

      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
      const fileName = `台電電表標記清單_${dateStr}.xlsx`;

      XLSX.writeFile(wb, fileName);
      showToast(`已成功匯出 ${fileName}`);
    } catch (e) {
      showToast("匯出 Excel 失敗：" + e.message, "error");
    }
  }

  // 清除全部標記
  function clearAllMarkers() {
    if (!state.records.length) return;
    if (confirm("確定要清除地圖上所有的批次電表標記嗎？")) {
      if (state.layerGroup) state.layerGroup.clearLayers();
      state.records = [];
      updateSummaryBadges(0, 0, 0);
      renderBatchList();
      showToast("已清除所有標記");
    }
  }

  // 綁定事件
  function bindEvents() {
    controls.toggle?.addEventListener("click", () => setPanelOpen(!controls.panel?.classList.contains("is-open")));
    controls.close?.addEventListener("click", () => setPanelOpen(false));

    controls.tabs?.forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    controls.sampleBtn?.addEventListener("click", () => {
      if (controls.input) {
        controls.input.value = SAMPLE_TEXT;
        showToast("已載入新化區測試範例資料！請點擊「開始標記」");
      }
    });

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
              showToast(`成功讀取「${file.name}」，已載入輸入框！請點擊「開始標記」`);
            }
          } catch (err) {
            showToast("讀取 Excel 失敗：" + err.message, "error");
          }
        };
        reader.readAsArrayBuffer(file);
      } catch (err) {
        showToast("無法載入 Excel 模組：" + err.message, "error");
      }
      e.target.value = "";
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
  }

  window.addEventListener("DOMContentLoaded", () => {
    initControls();
    bindEvents();
  });
})();
