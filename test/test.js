const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// --- Mock helpers ---

function createMockReq(overrides) {
  return {
    query: {},
    url: '/',
    ...overrides,
  };
}

function createMockRes() {
  const res = {
    _status: null,
    _headers: {},
    _body: null,
    _jsonBody: null,
    status(code) { res._status = code; return res; },
    json(obj) { res._jsonBody = obj; res._body = JSON.stringify(obj); },
    send(body) { res._body = body; },
    setHeader(key, value) { res._headers[key] = value; },
  };
  return res;
}

// --- Tests for api/standings/[leagueId].js ---

describe('standings endpoint', function () {
  // We need to mock https.get to avoid real API calls
  const standingsHandler = require('../api/standings/[leagueId].js');

  it('rejects non-numeric league IDs', function () {
    const req = createMockReq({ query: { leagueId: 'abc' } });
    const res = createMockRes();
    standingsHandler(req, res);
    assert.equal(res._status, 400);
    assert.deepEqual(res._jsonBody, { error: 'Invalid league ID' });
  });

  it('rejects empty league ID', function () {
    const req = createMockReq({ query: { leagueId: '' } });
    const res = createMockRes();
    standingsHandler(req, res);
    assert.equal(res._status, 400);
  });

  it('rejects league ID with special characters', function () {
    const req = createMockReq({ query: { leagueId: '123; DROP TABLE' } });
    const res = createMockRes();
    standingsHandler(req, res);
    assert.equal(res._status, 400);
  });

  it('rejects undefined league ID', function () {
    const req = createMockReq({ query: {} });
    const res = createMockRes();
    standingsHandler(req, res);
    assert.equal(res._status, 400);
  });

  it('accepts valid numeric league ID', function () {
    // This will attempt an actual https.get — we just verify it doesn't
    // return 400 (i.e., the validation passed). The https call will fail
    // in this test environment, but that's OK for a validation test.
    const req = createMockReq({ query: { leagueId: '12176' } });
    const res = createMockRes();
    standingsHandler(req, res);
    // Should NOT have returned 400 synchronously
    assert.notEqual(res._status, 400);
  });
});

// --- Tests for api/fpl-proxy.js ---

describe('fpl-proxy endpoint', function () {
  const proxyHandler = require('../api/fpl-proxy.js');

  it('extracts path from query parameter', function () {
    const req = createMockReq({ query: { fplPath: 'entry/123/history' }, url: '/api/fpl-proxy?fplPath=entry/123/history' });
    const res = createMockRes();
    proxyHandler(req, res);
    // Should NOT return 400 — path was extracted
    assert.notEqual(res._status, 400);
  });

  it('returns 400 when path is missing', function () {
    const req = createMockReq({ query: {}, url: '/api/fpl-proxy' });
    const res = createMockRes();
    proxyHandler(req, res);
    assert.equal(res._status, 400);
    assert.deepEqual(res._jsonBody, { error: 'Missing path' });
  });

  it('returns 400 for empty fplPath query', function () {
    const req = createMockReq({ query: { fplPath: '' }, url: '/api/fpl-proxy?fplPath=' });
    const res = createMockRes();
    proxyHandler(req, res);
    assert.equal(res._status, 400);
  });

  it('extracts path from URL as fallback', function () {
    const req = createMockReq({ query: {}, url: '/api/fpl-proxy/entry/456/transfers?foo=bar' });
    const res = createMockRes();
    proxyHandler(req, res);
    // Should NOT return 400 — path was extracted from URL
    assert.notEqual(res._status, 400);
  });
});

// --- Tests for server.js routing ---

describe('server routing', function () {
  it('matches /api/fpl/* routes', function () {
    const pattern = /^\/api\/fpl\/(.+)$/;
    assert.ok(pattern.test('/api/fpl/entry/123/history'));
    assert.ok(pattern.test('/api/fpl/bootstrap-static'));
    assert.ok(pattern.test('/api/fpl/event/1/live'));
    assert.ok(!pattern.test('/api/fpl/'));
    assert.ok(!pattern.test('/api/fpl'));
    assert.ok(!pattern.test('/api/standings/123'));
  });

  it('matches /api/standings/:id routes', function () {
    const pattern = /^\/api\/standings\/(\d+)$/;
    assert.ok(pattern.test('/api/standings/12176'));
    assert.ok(pattern.test('/api/standings/1'));
    assert.ok(!pattern.test('/api/standings/abc'));
    assert.ok(!pattern.test('/api/standings/'));
    assert.ok(!pattern.test('/api/standings/12/extra'));
  });

  it('extracts correct league ID from standings URL', function () {
    const match = '/api/standings/12176'.match(/^\/api\/standings\/(\d+)$/);
    assert.equal(match[1], '12176');
  });

  it('extracts correct path from fpl URL', function () {
    const match = '/api/fpl/entry/123/history'.match(/^\/api\/fpl\/(.+)$/);
    assert.equal(match[1], 'entry/123/history');
  });

  it('maps root URL to index.html', function () {
    const url = '/';
    const filePath = url === '/' ? '/index.html' : url;
    assert.equal(filePath, '/index.html');
  });

  it('passes through non-root static file paths', function () {
    const url = '/App.css';
    const filePath = url === '/' ? '/index.html' : url;
    assert.equal(filePath, '/App.css');
  });
});

// --- Tests for data processing logic (stats calculations) ---

describe('stats data processing', function () {
  const sampleHistory = {
    current: [
      { event: 1, points: 50, total_points: 50, points_on_bench: 8, event_transfers: 0, event_transfers_cost: 0 },
      { event: 2, points: 65, total_points: 115, points_on_bench: 12, event_transfers: 1, event_transfers_cost: 0 },
      { event: 3, points: 40, total_points: 155, points_on_bench: 3, event_transfers: 2, event_transfers_cost: 4 },
      { event: 4, points: 72, total_points: 227, points_on_bench: 15, event_transfers: 3, event_transfers_cost: 8 },
    ],
    chips: [{ name: 'wildcard', event: 3 }],
  };

  // Replicate the stats calculation logic from App.js
  function processHistory(h) {
    var history = (h && h.current) ? h.current : [];
    var chips = (h && h.chips) ? h.chips : [];
    var totalBenchPoints = history.reduce(function (sum, gw) { return sum + (gw.points_on_bench || 0); }, 0);
    var totalHitsCost = history.reduce(function (sum, gw) { return sum + (gw.event_transfers_cost || 0); }, 0);
    var totalTransfers = history.reduce(function (sum, gw) { return sum + (gw.event_transfers || 0); }, 0);
    return { history, chips, totalBenchPoints, totalHitsCost, totalTransfers };
  }

  it('calculates bench points correctly', function () {
    const result = processHistory(sampleHistory);
    assert.equal(result.totalBenchPoints, 38); // 8 + 12 + 3 + 15
  });

  it('calculates hits cost correctly', function () {
    const result = processHistory(sampleHistory);
    assert.equal(result.totalHitsCost, 12); // 0 + 0 + 4 + 8
  });

  it('calculates total transfers correctly', function () {
    const result = processHistory(sampleHistory);
    assert.equal(result.totalTransfers, 6); // 0 + 1 + 2 + 3
  });

  it('extracts chips correctly', function () {
    const result = processHistory(sampleHistory);
    assert.equal(result.chips.length, 1);
    assert.equal(result.chips[0].name, 'wildcard');
  });

  it('handles null history gracefully', function () {
    const result = processHistory(null);
    assert.equal(result.totalBenchPoints, 0);
    assert.equal(result.totalHitsCost, 0);
    assert.equal(result.totalTransfers, 0);
    assert.equal(result.history.length, 0);
    assert.equal(result.chips.length, 0);
  });

  it('handles missing current field', function () {
    const result = processHistory({ chips: [] });
    assert.equal(result.totalBenchPoints, 0);
    assert.equal(result.totalTransfers, 0);
  });

  it('handles missing fields in GW data', function () {
    const result = processHistory({
      current: [{ event: 1 }, { event: 2 }],
      chips: [],
    });
    assert.equal(result.totalBenchPoints, 0);
    assert.equal(result.totalHitsCost, 0);
    assert.equal(result.totalTransfers, 0);
  });
});

// --- Tests for captain stats processing ---

describe('captain stats processing', function () {
  // Replicate captain calculation logic from App.js
  function processCaptainPicks(picks, liveData, gw) {
    var captain = picks.find(function (p) { return p.is_captain; });
    if (!captain || !liveData[gw]) return 0;
    return (liveData[gw][captain.element] || 0) * captain.multiplier;
  }

  function findMostCaptained(captainChoices, playerNames) {
    var mostCaptained = null;
    var maxCount = 0;
    Object.keys(captainChoices).forEach(function (pid) {
      if (captainChoices[pid].count > maxCount) {
        maxCount = captainChoices[pid].count;
        mostCaptained = pid;
      }
    });
    return mostCaptained
      ? (playerNames[mostCaptained] || 'Unknown') + ' (' + maxCount + 'x)'
      : '-';
  }

  it('calculates captain points with multiplier 2', function () {
    const picks = [
      { element: 100, is_captain: true, multiplier: 2 },
      { element: 101, is_captain: false, multiplier: 1 },
    ];
    const liveData = { 1: { 100: 10, 101: 5 } };
    assert.equal(processCaptainPicks(picks, liveData, 1), 20); // 10 * 2
  });

  it('calculates triple captain points with multiplier 3', function () {
    const picks = [
      { element: 100, is_captain: true, multiplier: 3 },
    ];
    const liveData = { 1: { 100: 15 } };
    assert.equal(processCaptainPicks(picks, liveData, 1), 45); // 15 * 3
  });

  it('returns 0 when captain player has no live data', function () {
    const picks = [{ element: 999, is_captain: true, multiplier: 2 }];
    const liveData = { 1: { 100: 10 } };
    assert.equal(processCaptainPicks(picks, liveData, 1), 0);
  });

  it('returns 0 when no live data for gameweek', function () {
    const picks = [{ element: 100, is_captain: true, multiplier: 2 }];
    assert.equal(processCaptainPicks(picks, {}, 1), 0);
  });

  it('returns 0 when no captain in picks', function () {
    const picks = [{ element: 100, is_captain: false, multiplier: 1 }];
    const liveData = { 1: { 100: 10 } };
    assert.equal(processCaptainPicks(picks, liveData, 1), 0);
  });

  it('finds most captained player', function () {
    const choices = {
      '100': { count: 10, points: 150 },
      '200': { count: 15, points: 200 },
      '300': { count: 5, points: 80 },
    };
    const playerNames = { '100': 'Salah', '200': 'Haaland', '300': 'Saka' };
    assert.equal(findMostCaptained(choices, playerNames), 'Haaland (15x)');
  });

  it('shows Unknown for missing player name', function () {
    const choices = { '999': { count: 5, points: 50 } };
    assert.equal(findMostCaptained(choices, {}), 'Unknown (5x)');
  });

  it('returns dash for empty choices', function () {
    assert.equal(findMostCaptained({}, {}), '-');
  });
});

// --- Tests for vercel.json rewrite logic ---

describe('vercel.json rewrite pattern', function () {
  // Simulate the vercel.json rewrite: /api/fpl/:fplPath* → /api/fpl-proxy?fplPath=:fplPath*
  function simulateRewrite(url) {
    const match = url.match(/^\/api\/fpl\/(.+)$/);
    if (!match) return null;
    return '/api/fpl-proxy?fplPath=' + match[1];
  }

  it('rewrites entry/history paths', function () {
    assert.equal(simulateRewrite('/api/fpl/entry/123/history'), '/api/fpl-proxy?fplPath=entry/123/history');
  });

  it('rewrites bootstrap-static', function () {
    assert.equal(simulateRewrite('/api/fpl/bootstrap-static'), '/api/fpl-proxy?fplPath=bootstrap-static');
  });

  it('rewrites event/live paths', function () {
    assert.equal(simulateRewrite('/api/fpl/event/5/live'), '/api/fpl-proxy?fplPath=event/5/live');
  });

  it('rewrites deeply nested paths', function () {
    assert.equal(
      simulateRewrite('/api/fpl/entry/123/event/5/picks'),
      '/api/fpl-proxy?fplPath=entry/123/event/5/picks'
    );
  });

  it('does not match bare /api/fpl', function () {
    assert.equal(simulateRewrite('/api/fpl'), null);
  });

  it('does not match /api/standings', function () {
    assert.equal(simulateRewrite('/api/standings/123'), null);
  });
});
