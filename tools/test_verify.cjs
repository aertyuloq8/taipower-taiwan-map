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

  // 打開設備搜尋
  await page.evaluate(() => {
    document.getElementById('mapSearchToggle').click();
  });
  await new Promise(r => setTimeout(r, 400));

  // 測試 1: 搜尋「尖峰1」
  console.log('輸入「尖峰1」測試自然排序...');
  await page.evaluate(() => {
    const input = document.getElementById('searchInput');
    input.value = '';
  });
  await page.type('#searchInput', '尖峰1', { delay: 30 });
  await new Promise(r => setTimeout(r, 800));

  const resultsJianfeng1 = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#results .result-item')).map(el => ({
      title: el.querySelector('strong')?.textContent.trim() || '',
      subtitle: el.querySelector('span')?.textContent.trim() || ''
    }));
  });

  console.log(`搜尋「尖峰1」結果筆數: ${resultsJianfeng1.length}`);
  console.log('前 10 筆結果:');
  resultsJianfeng1.slice(0, 10).forEach((r, idx) => console.log(`  ${idx + 1}. ${r.title} (${r.subtitle})`));

  // 截圖 1: 尖峰1 搜尋自然排序截圖
  const screenshot1 = path.join(ARTIFACT_DIR, 'verify_natural_sort_jianfeng1.png');
  await page.screenshot({ path: screenshot1 });
  console.log('截圖已儲存至:', screenshot1);

  // 測試 2: 搜尋「尖峰高幹1」
  console.log('\n輸入「尖峰高幹1」測試容錯與自然排序...');
  await page.evaluate(() => {
    const input = document.getElementById('searchInput');
    input.value = '';
  });
  await page.type('#searchInput', '尖峰高幹1', { delay: 30 });
  await new Promise(r => setTimeout(r, 800));

  const resultsJianfengGaogan1 = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#results .result-item')).map(el => ({
      title: el.querySelector('strong')?.textContent.trim() || '',
      subtitle: el.querySelector('span')?.textContent.trim() || ''
    }));
  });

  console.log(`搜尋「尖峰高幹1」結果筆數: ${resultsJianfengGaogan1.length}`);
  console.log('前 10 筆結果:');
  resultsJianfengGaogan1.slice(0, 10).forEach((r, idx) => console.log(`  ${idx + 1}. ${r.title} (${r.subtitle})`));

  // 截圖 2: 尖峰高幹1 截圖
  const screenshot2 = path.join(ARTIFACT_DIR, 'verify_natural_sort_gaogan1.png');
  await page.screenshot({ path: screenshot2 });
  console.log('截圖已儲存至:', screenshot2);

  await browser.close();
  console.log('=== 自然排序實機驗證結束 ===');
}

main().catch(err => {
  console.error('驗證失敗:', err);
  process.exit(1);
});
