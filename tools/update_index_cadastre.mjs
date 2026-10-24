import fs from 'node:fs';

const htmlPath = 'web/index.html';
let content = fs.readFileSync(htmlPath, 'utf8');

const targetStr = `<div class="v2-cadastre-field">
            <span class="v2-cadastre-fixed-label">縣市</span>
            <div class="v2-cadastre-fixed-value" aria-label="固定縣市：臺南市">臺南市 <span>固定</span></div>
          </div>`;

const replaceStr = `<div class="v2-cadastre-field">
            <label for="v2CadastreCity">縣市</label>
            <select id="v2CadastreCity" disabled>
              <option value="">載入縣市清單中…</option>
            </select>
          </div>`;

const descTarget = `<p class="v2-cadastre-description">固定查詢臺南市。地段可輸入關鍵字或從清單選取，再輸入地號即可套繪地籍範圍。</p>`;
const descReplace = `<p class="v2-cadastre-description">支援全台縣市地籍查詢。選擇縣市、行政區與地段後，輸入地號即可精確定位並套繪地籍圖資。</p>`;

// Normalize CRLF to LF for matching
const isCRLF = content.includes('\r\n');
const normalized = content.replace(/\r\n/g, '\n');

if (normalized.includes(targetStr)) {
  let updated = normalized.replace(targetStr, replaceStr);
  if (updated.includes(descTarget)) {
    updated = updated.replace(descTarget, descReplace);
  }
  if (isCRLF) {
    updated = updated.replace(/\n/g, '\r\n');
  }
  fs.writeFileSync(htmlPath, updated, 'utf8');
  console.log('Successfully updated web/index.html with v2CadastreCity!');
} else {
  console.error('Target string not found in web/index.html');
}
