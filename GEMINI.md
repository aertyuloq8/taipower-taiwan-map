# 本專案規範：全台土木設備分布地圖（全台版）

- **專案識別**：此為【全台版】專屬專案（目錄：`taipower-map-taiwan`，遠端：`taipower-taiwan-map`，分支：`master`）。
- **網頁標題**：`<title>全台土木設備分布地圖</title>`
- **版本號規則**：必須以 `-tw` 結尾（例如 `v2.8.0-tw`）。
- **底層核心架構**：
  - 本專案採用 296 萬筆向量圖磚架構（PMTiles、Worker、pmtiles_layer.js）。
  - 若有新通用功能（如批次電表、相片、雲端同步）同步至台南版時，**嚴禁整檔覆蓋台南版的 `main.js`**，避免將 `pmtiles_layer.js` 的 import 帶過去導致台南版 404 崩潰。
- **發布驗證**：推送至 GitHub 前，必須透過無頭瀏覽器驗證 `window.__appBooted === true` 且地圖成功載入。
