"""
動態下載政府資料開放平臺 Dataset 33305 相關台電電桿資料
自動透過 data.gov.tw API 取得最新有效下載網址，支援 GCA 憑證驗證防護
"""
from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"

COUNTY_DATASETS = {
    "all": {"name": "全台灣", "id": 33305},
    "taipei": {"name": "臺北市", "id": 122523},
    "newtaipei": {"name": "新北市", "id": 122524},
    "taoyuan": {"name": "桃園市", "id": 122737},
    "taichung": {"name": "臺中市", "id": 122738},
    "tainan": {"name": "臺南市", "id": 122739},
    "kaohsiung": {"name": "高雄市", "id": 122740},
    "keelung": {"name": "基隆市", "id": 139305},
    "hsinchu_city": {"name": "新竹市", "id": 139306},
    "hsinchu_county": {"name": "新竹縣", "id": 139307},
    "miaoli": {"name": "苗栗縣", "id": 139310},
    "changhua": {"name": "彰化縣", "id": 139313},
    "nantou": {"name": "南投縣", "id": 139312},
    "yunlin": {"name": "雲林縣", "id": 139314},
    "chiayi_city": {"name": "嘉義市", "id": 139315},
    "chiayi_county": {"name": "嘉義縣", "id": 139317},
    "pingtung": {"name": "屏東縣", "id": 139318},
    "yilan": {"name": "宜蘭縣", "id": 139319},
    "hualien": {"name": "花蓮縣", "id": 139320},
    "taitung": {"name": "臺東縣", "id": 139324},
}


def get_ssl_context():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def get_download_url(dataset_id: int) -> str:
    api_url = f"https://data.gov.tw/api/v2/rest/dataset/{dataset_id}"
    req = urllib.request.Request(api_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, context=get_ssl_context(), timeout=15) as r:
        payload = json.loads(r.read())
        dist = payload.get("result", {}).get("distribution", [])
        if not dist:
            raise RuntimeError(f"找不到資料集 {dataset_id} 的下載發布項目")
        return dist[0]["resourceDownloadUrl"]


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"取得下載端點：{url}")
    print(f"儲存目標路徑：{dest}")

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, context=get_ssl_context(), timeout=60) as response, dest.open("wb") as out_file:
        total_size = int(response.headers.get("content-length", 0))
        downloaded = 0
        chunk_size = 64 * 1024

        while True:
            chunk = response.read(chunk_size)
            if not chunk:
                break
            out_file.write(chunk)
            downloaded += len(chunk)
            if total_size > 0:
                percent = int(downloaded * 100 / total_size)
                mb_downloaded = downloaded / (1024 * 1024)
                mb_total = total_size / (1024 * 1024)
                sys.stdout.write(f"\r進度：{percent}% ({mb_downloaded:.1f}/{mb_total:.1f} MB)")
                sys.stdout.flush()

    print("\n下載完成！")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="台電電桿開放資料下載工具")
    parser.add_argument(
        "--county",
        type=str,
        default="all",
        help="指定縣市代碼（例如 chiayi_city, tainan, all 代表全台灣），預設為 all",
    )
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    target = args.county.lower()

    if target not in COUNTY_DATASETS:
        print(f"未知的縣市代碼：{target}")
        print("可用代碼：\n  " + ", ".join(COUNTY_DATASETS.keys()))
        return

    info = COUNTY_DATASETS[target]
    print(f"正在查詢【{info['name']}】(代碼: {info['id']}) 之最新開放資料下載網址...")
    try:
        download_url = get_download_url(info["id"])
    except Exception as e:
        print(f"取得下載網址失敗：{e}")
        return

    dest = RAW_DIR / f"{target}_{info['name']}.csv"
    download_file(download_url, dest)


if __name__ == "__main__":
    main()
