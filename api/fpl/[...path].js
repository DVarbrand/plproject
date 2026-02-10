const https = require('https');

module.exports = (req, res) => {
  const pathSegments = req.query.path;
  const fplPath = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments;

  if (!fplPath) {
    res.status(400).json({ error: 'Missing path' });
    return;
  }

  const url = `https://fantasy.premierleague.com/api/${fplPath}/`;

  https.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  }, (apiRes) => {
    let body = '';
    apiRes.on('data', (chunk) => { body += chunk; });
    apiRes.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      res.status(apiRes.statusCode).send(body);
    });
  }).on('error', (err) => {
    res.status(502).json({ error: err.message });
  });
};
