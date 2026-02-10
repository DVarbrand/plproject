const https = require('https');

module.exports = (req, res) => {
  const { leagueId } = req.query;

  if (!/^\d+$/.test(leagueId)) {
    res.status(400).json({ error: 'Invalid league ID' });
    return;
  }

  const url = `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`;

  https.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  }, (apiRes) => {
    let body = '';
    apiRes.on('data', (chunk) => { body += chunk; });
    apiRes.on('end', () => {
      res.status(apiRes.statusCode)
        .setHeader('Content-Type', 'application/json')
        .send(body);
    });
  }).on('error', (err) => {
    res.status(502).json({ error: err.message });
  });
};
