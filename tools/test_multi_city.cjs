const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ARTIFACT_DIR = 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\577d122b-75b7-4405-8fe4-679b5061d134';

async function main() {
  console.log('啟動 Edge 瀏覽器...');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  console.log('導航至 http://localhost:5173/ ...');
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => !!window.map, { timeout: 10000 });

  // 1. 將地圖中心設定在台南 (23.0, 120.3)
  console.log('設定地圖中心至台南 (23.0, 120.3)...');
  await page.evaluate(() => {
    window.map.setView([23.0, 120.3], 13);
  });
  await new Promise(r => setTimeout(r, 500));

  // 打開設備搜尋
  await page.evaluate(() => {
    document.getElementById('mapSearchToggle').click();
  });
  await new Promise(r => setTimeout(r, 400));

  // 測試 1: 搜尋「尖山1」，視窗在台南
  console.log('輸入「尖山1」進行全台多縣市搜尋 (視窗在台南)...');
  await page.evaluate(() => {
    const input = document.getElementById('searchInput');
    input.value = '';
  });
  await page.type('#searchInput', '尖山1', { delay: 30 });
  await new Promise(r => setTimeout(r, 1000));

  const pills = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.search-city-pill')).map(el => el.textContent.trim());
  });
  console.log('縣市快選標籤 pills:', pills);

  const resultsTainan = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#results .result-item')).map(el => ({
      title: el.querySelector('strong')?.textContent.trim() || '',
      subtitle: el.querySelector('span')?.textContent.trim() || ''
    }));
  });
  console.log(`搜尋「尖山1」筆數: ${resultsTainan.length}`);
  console.log('前 6 筆排序 (應為台南及鄰近地區置頂):');
  resultsTainan.slice(0, 6).forEach((r, idx) => console.log(`  ${idx + 1}. ${r.title} (${r.subtitle})`));

  const screenshot1 = path.join(ARTIFACT_DIR, 'verify_multi_city_distance_tainan.png');
  await page.screenshot({ path: screenshot1 });
  console.log('截圖 1 已儲存至:', screenshot1);

  // 測試 2: 點擊「新北市」膠囊過濾
  console.log('\n點擊「新北市」膠囊過濾...');
  await page.evaluate(() => {
    const pills = Array.from(document.querySelectorAll('.search-city-pill'));
    const ntpPill = pills.find(p => p.textContent.includes('新北市'));
    if (ntpPill) ntpPill.click();
  });
  await new Promise(r => setTimeout(r, 400));

  const resultsNTP = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#results .result-item')).map(el => ({
      title: el.querySelector('strong')?.textContent.trim() || '',
      subtitle: el.querySelector('span')?.textContent.trim() || ''
    }));
  });
  console.log(`點擊新北市膠囊後筆數: ${resultsNTP.length}`);
  resultsNTP.slice(0, 5).forEach((r, idx) => console.log(`  ${idx + 1}. ${r.title} (${r.subtitle})`));

  const screenshot2 = path.join(ARTIFACT_DIR, 'verify_multi_city_pill_filter.png');
  await page.screenshot({ path: screenshot2 });
  console.log('截圖 2 已儲存至:', screenshot2);

  // 測試 3: 複合關鍵字「台南 尖山1」
  console.log('\n輸入「台南 尖山1」測試關鍵字複合辨識...');
  await page.evaluate(() => {
    const input = document.getElementById('searchInput');
    input.value = '';
  });
  await page.type('#searchInput', '台南 尖山1', { delay: 30 });
  await new Promise(r => setTimeout(r, 1000));

  const resultsInline = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#results .result-item')).map(el => ({
      title: el.querySelector('strong')?.textContent.trim() || '',
      subtitle: el.querySelector('span')?.textContent.trim() || ''
    }));
  });
  console.log(`輸入「台南 尖山1」筆數: ${resultsInline.length}`);
  resultsInline.slice(0, 5).forEach((r, idx) => console.log(`  ${idx + 1}. ${r.title} (${r.subtitle})`));

  const screenshot3 = path.join(ARTIFACT_DIR, 'verify_multi_city_inline_keyword.png');
  await page.screenshot({ path: screenshot3 });
  console.log('截圖 3 已儲存至:', screenshot3);

  await browser.close();
  console.log('\n全部測試完成！');
}

main().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
