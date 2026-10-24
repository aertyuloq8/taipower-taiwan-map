import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const sourcePath = path.resolve('../webpro/data/cadastral-dropdowns-tw.json');
  const targetDataPath = path.resolve('data/cadastral-dropdowns-tw.json');
  const targetWebPath = path.resolve('web/cadastral-dropdowns-tw.json');

  console.log(`Loading source: ${sourcePath}`);
  const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

  const tasks = [];
  for (const city of data.cities) {
    for (const town of city.towns) {
      tasks.push({ cityCode: city.code, cityName: city.name, townCode: town.code, townName: town.name, townRef: town });
    }
  }

  console.log(`Total towns to enrich: ${tasks.length}`);

  let completed = 0;
  let totalSectionsMatched = 0;
  let totalSections = 0;

  // Concurrency pool
  const CONCURRENCY = 10;
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++;
      const task = tasks[idx];
      const url = `https://easymap.moi.gov.tw/Z10Web/City_json_getSectionList?cityCode=${task.cityCode}&townCode=${task.townCode}`;
      
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = await res.json();
        
        const officeMap = new Map();
        if (Array.isArray(list)) {
          list.forEach(item => {
            const id = String(item.id || item.sectNo || '').trim();
            const office = String(item.officeCode || item.office || '').trim();
            if (id && office) officeMap.set(id, office);
          });
        }

        task.townRef.sections.forEach(s => {
          totalSections++;
          if (officeMap.has(s.code)) {
            s.office = officeMap.get(s.code);
            totalSectionsMatched++;
          }
        });
      } catch (err) {
        console.warn(`Failed for ${task.cityName} ${task.townName} (${task.cityCode}-${task.townCode}): ${err.message}`);
      }

      completed++;
      if (completed % 50 === 0 || completed === tasks.length) {
        console.log(`Progress: ${completed}/${tasks.length} towns (${((completed/tasks.length)*100).toFixed(1)}%), sections matched: ${totalSectionsMatched}/${totalSections}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  data.generatedAt = new Date().toISOString();
  data.hasOfficeCodes = true;

  console.log(`\nEnrichment complete! Total sections: ${totalSections}, Matched office: ${totalSectionsMatched} (${((totalSectionsMatched/totalSections)*100).toFixed(2)}%)`);

  const jsonStr = JSON.stringify(data, null, 2);
  fs.mkdirSync(path.dirname(targetDataPath), { recursive: true });
  fs.writeFileSync(targetDataPath, jsonStr, 'utf8');
  console.log(`Wrote: ${targetDataPath} (${(jsonStr.length / 1024).toFixed(1)} KB)`);

  fs.mkdirSync(path.dirname(targetWebPath), { recursive: true });
  fs.writeFileSync(targetWebPath, jsonStr, 'utf8');
  console.log(`Wrote: ${targetWebPath}`);
}

main().catch(console.error);
