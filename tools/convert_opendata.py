"""
台電開放資料 (Dataset 33305) 轉換工具
支援：
1. 將 TWD97 (X, Y) 或圖號座標精準轉換為 WGS84 經緯度 (lat, lng)
2. 匯出為 GeoJSON Sequence (供 tippecanoe 烘焙 PMTiles 向量圖磚)
3. 匯出為分縣市輕量 JSON 檔 (供前端按需隨選下載)
4. 桿號為空時自動以「圖號座標」補全設備識別名
"""
from __future__ import annotations

import csv
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
OUTPUT_DIR = DATA_DIR / "processed"
PI = math.pi


def twd97_tm2_to_lat_lng(x: float, y: float) -> tuple[float, float]:
    """TWD97 二度分帶 (TM2, 中央經線 121) 轉 WGS84 經緯度"""
    a = 6378137.0
    b = 6356752.314245
    lng0 = 121.0 * PI / 180.0
    k0 = 0.9999
    dx = x - 250000.0

    e2 = 1.0 - (b**2.0) / (a**2.0)
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))

    m_val = y / k0
    mu = m_val / (a * (1.0 - e2 / 4.0 - 3.0 * (e2**2.0) / 64.0 - 5.0 * (e2**3.0) / 256.0))

    j1 = 3.0 * e1 / 2.0 - 27.0 * (e1**3.0) / 32.0
    j2 = 21.0 * (e1**2.0) / 16.0 - 55.0 * (e1**4.0) / 32.0
    j3 = 151.0 * (e1**3.0) / 96.0
    j4 = 1097.0 * (e1**4.0) / 512.0

    fp = mu + j1 * math.sin(2.0 * mu) + j2 * math.sin(4.0 * mu) + j3 * math.sin(6.0 * mu) + j4 * math.sin(8.0 * mu)

    ep2 = ((a**2.0) - (b**2.0)) / (b**2.0)
    c1 = ep2 * (math.cos(fp) ** 2.0)
    t1 = math.tan(fp) ** 2.0
    r1 = a * (1.0 - e2) / ((1.0 - e2 * (math.sin(fp) ** 2.0)) ** 1.5)
    n1 = a / math.sqrt(1.0 - e2 * (math.sin(fp) ** 2.0))
    d_val = dx / (n1 * k0)

    q1 = n1 * math.tan(fp) / r1
    q2 = (d_val**2.0) / 2.0
    q3 = (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * (c1**2.0) - 9.0 * ep2) * (d_val**4.0) / 24.0
    q4 = (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * (t1**2.0) - 3.0 * (c1**2.0) - 252.0 * ep2) * (d_val**6.0) / 720.0

    lat = fp - q1 * (q2 - q3 + q4)
    q5 = d_val
    q6 = (1.0 + 2.0 * t1 + c1) * (d_val**3.0) / 6.0
    q7 = (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * (c1**2.0) + 8.0 * ep2 + 24.0 * (t1**2.0)) * (d_val**5.0) / 120.0
    lng = lng0 + (q5 - q6 + q7) / math.cos(fp)

    return lat * 180.0 / PI, lng * 180.0 / PI


def clean_str(val: object) -> str:
    return str(val or "").strip()


def parse_csv(csv_path: Path) -> Iterator[dict]:
    with csv_path.open("r", encoding="utf-8-sig", errors="ignore") as f:
        reader = csv.reader(f)
        headers = [clean_str(h) for h in next(reader, [])]
        h_map = {name: i for i, name in enumerate(headers)}

        f_city = h_map.get("縣市")
        f_dist = h_map.get("行政區")
        f_code = h_map.get("圖號座標")
        f_name = h_map.get("桿號")
        f_type = h_map.get("形式")
        f_x = h_map.get("TWD_97_X")
        f_y = h_map.get("TWD_97_Y")

        for row in reader:
            if not row:
                continue
            city = clean_str(row[f_city]) if f_city is not None and f_city < len(row) else ""
            dist = clean_str(row[f_dist]) if f_dist is not None and f_dist < len(row) else ""
            code = clean_str(row[f_code]) if f_code is not None and f_code < len(row) else ""
            raw_name = clean_str(row[f_name]) if f_name is not None and f_name < len(row) else ""
            name = raw_name if raw_name else code  # 無桿號時以圖號座標作為名稱
            p_type = clean_str(row[f_type]) if f_type is not None and f_type < len(row) else ""
            x_str = clean_str(row[f_x]) if f_x is not None and f_x < len(row) else ""
            y_str = clean_str(row[f_y]) if f_y is not None and f_y < len(row) else ""

            lat, lng = None, None
            try:
                x = float(x_str)
                y = float(y_str)
                if x > 10000 and y > 10000:
                    lat, lng = twd97_tm2_to_lat_lng(x, y)
            except (ValueError, TypeError):
                pass

            if not (lat and lng and 21.5 <= lat <= 26.5 and 119.0 <= lng <= 122.5):
                continue

            yield {
                "name": name,
                "code": code,
                "city": city,
                "area": dist,
                "type": p_type,
                "lat": round(lat, 7),
                "lng": round(lng, 7),
            }


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    all_file = RAW_DIR / "all_全台灣.csv"
    if all_file.exists():
        csv_files = [all_file]
        print(f"優先使用全台灣完整檔：{all_file.name}")
    else:
        csv_files = list(RAW_DIR.glob("*.csv"))

    if not csv_files:
        print(f"在 {RAW_DIR} 中找不到任何 CSV 檔案。請先執行 fetch_opendata.py 下載資料。")
        return

    print(f"找到 {len(csv_files)} 個原始資料檔，開始處理...")
    geojson_seq_path = OUTPUT_DIR / "taiwan_poles.geojsonseq"
    city_buckets: dict[str, list[dict]] = defaultdict(list)
    total_count = 0

    with geojson_seq_path.open("w", encoding="utf-8") as g_out:
        for file in csv_files:
            print(f"正在轉換：{file.name} ...")
            for item in parse_csv(file):
                total_count += 1
                item["id"] = total_count

                feature = {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [item["lng"], item["lat"]]},
                    "properties": {
                        "id": item["id"],
                        "name": item["name"],
                        "code": item["code"],
                        "city": item["city"],
                        "area": item["area"],
                        "type": item["type"],
                    },
                }
                g_out.write(json.dumps(feature, ensure_ascii=False) + "\n")

                c_name = item["city"] or "其他"
                city_buckets[c_name].append(item)

                if total_count % 200000 == 0:
                    print(f"已處理 {total_count:,} 筆電桿...")

    print(f"\n全部處理完成！共 {total_count:,} 筆有效電桿。")
    print(f"GeoJSONSeq 已產出：{geojson_seq_path}")

    city_dir = OUTPUT_DIR / "cities"
    city_dir.mkdir(exist_ok=True)
    city_meta = []
    
    # 台灣標準行政區順序偏好
    city_order = [
        "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市",
        "基隆市", "新竹市", "新竹縣", "苗栗縣", "彰化縣", "南投縣",
        "雲林縣", "嘉義市", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣",
        "臺東縣", "澎湖縣", "金門縣", "連江縣"
    ]
    sorted_cities = sorted(city_buckets.keys(), key=lambda c: (city_order.index(c) if c in city_order else 999, c))

    for city in sorted_cities:
        items = city_buckets[city]
        c_path = city_dir / f"{city}.json"
        c_path.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
        
        lats = [p["lat"] for p in items]
        lngs = [p["lng"] for p in items]
        city_meta.append({
            "city": city,
            "count": len(items),
            "file": f"processed/cities/{city}.json",
            "bounds": [[min(lats), min(lngs)], [max(lats), max(lngs)]]
        })
        print(f"  - {city:6}: {len(items):8,} 筆 -> {c_path.name}")

    meta_path = OUTPUT_DIR / "cities_meta.json"
    meta_path.write_text(json.dumps(city_meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n各縣市清單詮釋資料已產出至：{meta_path}")

    # 建立前端預設載入檔 data/meta.json 與 data/points.json (優先選嘉義市或臺南市)
    if city_buckets:
        default_city = "嘉義市" if "嘉義市" in city_buckets else ("臺南市" if "臺南市" in city_buckets else sorted_cities[0])
        test_poles = city_buckets[default_city]
        lats = [p["lat"] for p in test_poles]
        lngs = [p["lng"] for p in test_poles]
        area_counter = defaultdict(int)
        for p in test_poles:
            area_counter[p.get("area") or "未分類"] += 1
        areas_list = [{"name": k, "count": v} for k, v in sorted(area_counter.items(), key=lambda x: x[1], reverse=True)]

        root_meta = {
            "source": f"{default_city}開放資料 (Dataset 33305)",
            "totalRows": len(test_poles),
            "converted": len(test_poles),
            "bounds": [[min(lats), min(lngs)], [max(lats), max(lngs)]],
            "areas": areas_list,
            "pointsHash": f"{default_city}_{len(test_poles)}",
        }
        (DATA_DIR / "meta.json").write_text(json.dumps(root_meta, ensure_ascii=False, indent=2), encoding="utf-8")
        (DATA_DIR / "points.json").write_text(json.dumps(test_poles, ensure_ascii=False), encoding="utf-8")
        print(f"已同步建立前端預設載入檔：data/meta.json 與 data/points.json（預設載入【{default_city}】共 {len(test_poles):,} 筆）")


if __name__ == "__main__":
    main()
