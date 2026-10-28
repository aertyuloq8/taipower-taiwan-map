export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const fileId = req.query?.id || '';
  if (!fileId || typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{15,70}$/.test(fileId)) {
    return res.status(400).json({ error: 'invalid_id', message: '無效的檔案識別碼' });
  }

  try {
    const driveUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    const fetchRes = await fetch(driveUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (fetchRes.status === 404 || !fetchRes.ok) {
      return res.status(404).json({ error: 'not_found', message: '檔案不存在或已被發布者刪除作廢' });
    }

    const text = await fetchRes.text();
    if (text.includes('Google Drive - Access Denied') || text.includes('Google Drive - Page Not Found') || text.startsWith('<!DOCTYPE html>')) {
      return res.status(404).json({ error: 'not_found', message: '檔案已被發布者刪除作廢或無公開存取權限' });
    }

    try {
      const json = JSON.parse(text);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).json(json);
    } catch {
      return res.status(500).json({ error: 'invalid_json', message: '雲端檔案內容格式錯誤' });
    }
  } catch (err) {
    return res.status(502).json({ error: 'upstream_error', message: err.message });
  }
}
