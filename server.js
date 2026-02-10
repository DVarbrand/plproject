const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function proxyFplApi(res, fplPath) {
  const url = `https://fantasy.premierleague.com/api/${fplPath}/`;

  https.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  }, (apiRes) => {
    let body = '';
    apiRes.on('data', (chunk) => { body += chunk; });
    apiRes.on('end', () => {
      res.writeHead(apiRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    });
  }).on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

const server = http.createServer((req, res) => {
  // Generic FPL proxy: /api/fpl/any/path/here
  const fplMatch = req.url.match(/^\/api\/fpl\/(.+)$/);
  if (fplMatch) {
    proxyFplApi(res, fplMatch[1]);
    return;
  }

  // Legacy standings endpoint
  const standingsMatch = req.url.match(/^\/api\/standings\/(\d+)$/);
  if (standingsMatch) {
    proxyFplApi(res, 'leagues-classic/' + standingsMatch[1] + '/standings');
    return;
  }

  // Static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  serveStatic(res, path.join(__dirname, filePath));
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
