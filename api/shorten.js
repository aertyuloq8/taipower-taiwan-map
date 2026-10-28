export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let targetUrl = '';
  if (req.method === 'POST') {
    targetUrl = req.body?.url || '';
  } else {
    targetUrl = req.query?.url || '';
  }

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // 1. Try is.gd first
  try {
    const isGdRes = await fetch(`https://is.gd/create.php?format=json&url=${encodeURIComponent(targetUrl)}`);
    if (isGdRes.ok) {
      const isGdData = await isGdRes.json();
      if (isGdData?.shorturl) {
        return res.status(200).json({ shortUrl: isGdData.shorturl, service: 'is.gd' });
      }
    }
  } catch (e) {
    // continue to TinyURL fallback
  }

  // 2. Fallback to TinyURL
  try {
    const tinyRes = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(targetUrl)}`);
    if (tinyRes.ok) {
      const tinyText = await tinyRes.text();
      if (tinyText && tinyText.startsWith('http')) {
        return res.status(200).json({ shortUrl: tinyText.trim(), service: 'tinyurl' });
      }
    }
  } catch (e) {
    // continue
  }

  return res.status(502).json({ error: 'Failed to generate short URL', fallbackUrl: targetUrl });
}
