/*
 * 全台地籍圖資查詢設定 (Taiwan Cadastre Configuration)
 * 支援全台 22 縣市、368 鄉鎮市區、16,951 地段
 */
window.CADASTRE_GAS_URL = "https://script.google.com/macros/s/AKfycbw5rYwcEBKZcvqQJS4OZtHtu3gDBsoH7pCD8H2N4_ZWl7F6E1oovg881EQhvUNuqXXbPA/exec";
window.CADASTRE_GAS_MODE = "image";
window.CADASTRE_DROPDOWN_DATA_URL = "./cadastral-dropdowns-tw.json";

// 自動環境偵測：本機 (localhost / 127.0.0.1) 與 Vercel 雲端環境自動啟用同源 /api/cadastre
if (typeof window !== "undefined") {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.includes("vercel.app") || (!host.endsWith("github.io") && host !== "")) {
    window.CADASTRE_ADAPTER_URL = "/api/cadastre";
  }
}
