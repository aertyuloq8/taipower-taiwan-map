/*
 * 全台地籍圖資查詢設定 (Taiwan Cadastre Configuration)
 * 支援全台 22 縣市、368 鄉鎮市區、16,951 地段
 */
window.CADASTRE_GAS_URL = "https://script.google.com/macros/s/AKfycbw5rYwcEBKZcvqQJS4OZtHtu3gDBsoH7pCD8H2N4_ZWl7F6E1oovg881EQhvUNuqXXbPA/exec";
window.CADASTRE_GAS_MODE = "image";
window.CADASTRE_DROPDOWN_DATA_URL = "./cadastral-dropdowns-tw.json";

// 本地開發環境 (localhost / 127.0.0.1) 自動使用 Vite 極速 API
if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
  window.CADASTRE_ADAPTER_URL = "/api/cadastre";
}
