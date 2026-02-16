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
    const pattern = /^\/api\/standings\/(\d+)(\?.*)?$/;
    assert.ok(pattern.test('/api/standings/12176'));
    assert.ok(pattern.test('/api/standings/1'));
    assert.ok(pattern.test('/api/standings/12176?page=2'));
    assert.ok(!pattern.test('/api/standings/abc'));
    assert.ok(!pattern.test('/api/standings/'));
    assert.ok(!pattern.test('/api/standings/12/extra'));
  });

  it('extracts correct league ID from standings URL', function () {
    const match = '/api/standings/12176'.match(/^\/api\/standings\/(\d+)(\?.*)?$/);
    assert.equal(match[1], '12176');
    const matchWithPage = '/api/standings/12176?page=3'.match(/^\/api\/standings\/(\d+)(\?.*)?$/);
    assert.equal(matchWithPage[1], '12176');
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

// --- Tests for history length consistency filter (chart crash prevention) ---

describe('chart history length filtering', function () {
  // Replicate the filtering logic from PointsChart in App.js
  function filterManagersForChart(managers) {
    var managersWithHistory = (managers || []).filter(function (m) { return m.history.length > 0; });
    var histLenCounts = {};
    managersWithHistory.forEach(function (m) {
      var len = m.history.length;
      histLenCounts[len] = (histLenCounts[len] || 0) + 1;
    });
    var expectedHistLen = 0;
    var maxCount = 0;
    Object.keys(histLenCounts).forEach(function (len) {
      if (histLenCounts[len] > maxCount) { maxCount = histLenCounts[len]; expectedHistLen = parseInt(len, 10); }
    });
    if (expectedHistLen > 0) {
      managersWithHistory = managersWithHistory.filter(function (m) { return m.history.length === expectedHistLen; });
    }
    return managersWithHistory;
  }

  it('keeps all managers when history lengths are consistent', function () {
    const managers = [
      { entry: 1, history: [{ event: 1 }, { event: 2 }, { event: 3 }] },
      { entry: 2, history: [{ event: 1 }, { event: 2 }, { event: 3 }] },
      { entry: 3, history: [{ event: 1 }, { event: 2 }, { event: 3 }] },
    ];
    const result = filterManagersForChart(managers);
    assert.equal(result.length, 3);
  });

  it('excludes managers with shorter history (mid-season joiners)', function () {
    const managers = [
      { entry: 1, history: [{ event: 1 }, { event: 2 }, { event: 3 }, { event: 4 }] },
      { entry: 2, history: [{ event: 1 }, { event: 2 }, { event: 3 }, { event: 4 }] },
      { entry: 3, history: [{ event: 3 }, { event: 4 }] }, // joined GW3
    ];
    const result = filterManagersForChart(managers);
    assert.equal(result.length, 2);
    assert.equal(result[0].entry, 1);
    assert.equal(result[1].entry, 2);
  });

  it('keeps the majority group when there are multiple different lengths', function () {
    const managers = [
      { entry: 1, history: [{ event: 1 }, { event: 2 }, { event: 3 }] },
      { entry: 2, history: [{ event: 1 }, { event: 2 }, { event: 3 }] },
      { entry: 3, history: [{ event: 1 }, { event: 2 }, { event: 3 }] },
      { entry: 4, history: [{ event: 2 }, { event: 3 }] },
      { entry: 5, history: [{ event: 3 }] },
    ];
    const result = filterManagersForChart(managers);
    assert.equal(result.length, 3);
    result.forEach(function (m) { assert.equal(m.history.length, 3); });
  });

  it('filters out managers with empty history', function () {
    const managers = [
      { entry: 1, history: [{ event: 1 }, { event: 2 }] },
      { entry: 2, history: [] },
      { entry: 3, history: [{ event: 1 }, { event: 2 }] },
    ];
    const result = filterManagersForChart(managers);
    assert.equal(result.length, 2);
    assert.ok(result.every(function (m) { return m.history.length === 2; }));
  });

  it('returns empty array for null/undefined managers', function () {
    assert.equal(filterManagersForChart(null).length, 0);
    assert.equal(filterManagersForChart(undefined).length, 0);
  });

  it('returns empty array when all managers have empty history', function () {
    const managers = [
      { entry: 1, history: [] },
      { entry: 2, history: [] },
    ];
    assert.equal(filterManagersForChart(managers).length, 0);
  });

  it('handles single manager correctly', function () {
    const managers = [
      { entry: 1, history: [{ event: 1 }, { event: 2 }] },
    ];
    const result = filterManagersForChart(managers);
    assert.equal(result.length, 1);
  });
});

// --- Tests for pagination / load-more standings concatenation ---

describe('load more managers pagination', function () {
  // Replicate the standings concatenation logic from loadMoreManagers in App.js
  function concatStandings(prev, apiResponse) {
    if (!apiResponse || !apiResponse.standings || !Array.isArray(apiResponse.standings.results)) {
      throw new Error('Unexpected API response format');
    }
    return {
      standings: prev.concat(apiResponse.standings.results),
      hasMore: !!apiResponse.standings.has_next,
    };
  }

  const page1 = [
    { entry: 1, player_name: 'Alice', total: 500, rank: 1 },
    { entry: 2, player_name: 'Bob', total: 480, rank: 2 },
  ];

  it('appends new managers to existing standings', function () {
    const apiResponse = {
      standings: {
        results: [
          { entry: 3, player_name: 'Charlie', total: 460, rank: 3 },
          { entry: 4, player_name: 'Diana', total: 450, rank: 4 },
        ],
        has_next: true,
      },
    };
    const result = concatStandings(page1, apiResponse);
    assert.equal(result.standings.length, 4);
    assert.equal(result.standings[2].player_name, 'Charlie');
    assert.equal(result.hasMore, true);
  });

  it('preserves original standings order', function () {
    const apiResponse = {
      standings: { results: [{ entry: 3, player_name: 'Charlie', total: 460, rank: 3 }], has_next: false },
    };
    const result = concatStandings(page1, apiResponse);
    assert.equal(result.standings[0].player_name, 'Alice');
    assert.equal(result.standings[1].player_name, 'Bob');
    assert.equal(result.standings[2].player_name, 'Charlie');
  });

  it('sets hasMore to false on last page', function () {
    const apiResponse = {
      standings: { results: [{ entry: 5, player_name: 'Eve', total: 400, rank: 5 }], has_next: false },
    };
    const result = concatStandings(page1, apiResponse);
    assert.equal(result.hasMore, false);
  });

  it('handles empty results page', function () {
    const apiResponse = {
      standings: { results: [], has_next: false },
    };
    const result = concatStandings(page1, apiResponse);
    assert.equal(result.standings.length, 2); // unchanged
    assert.equal(result.hasMore, false);
  });

  it('throws on invalid API response', function () {
    assert.throws(function () { concatStandings(page1, null); });
    assert.throws(function () { concatStandings(page1, {}); });
    assert.throws(function () { concatStandings(page1, { standings: {} }); });
    assert.throws(function () { concatStandings(page1, { standings: { results: 'not array' } }); });
  });

  it('does not mutate original array', function () {
    const original = [{ entry: 1, player_name: 'Alice', total: 500, rank: 1 }];
    const copy = original.slice();
    const apiResponse = {
      standings: { results: [{ entry: 2, player_name: 'Bob', total: 480, rank: 2 }], has_next: false },
    };
    concatStandings(original, apiResponse);
    assert.deepEqual(original, copy);
  });
});

// --- Tests for incremental manager data merging ---

describe('incremental manager data merging', function () {
  // Replicate the setHistoryData updater logic from loadIncrementalStats in App.js
  function mergeHistoryData(prev, newManagerData) {
    if (!prev || !prev.managers) return { managers: newManagerData };
    return { managers: prev.managers.concat(newManagerData) };
  }

  // Replicate the setPicksData updater logic from loadIncrementalStats in App.js
  function mergePicksData(prev, newData) {
    if (!prev) return {
      captainStats: newData.captainStats,
      benchDetails: newData.benchDetails,
      captainAnalysis: newData.captainAnalysis,
    };
    return {
      captainStats: Object.assign({}, prev.captainStats, newData.captainStats),
      benchDetails: Object.assign({}, prev.benchDetails, newData.benchDetails),
      captainAnalysis: Object.assign({}, prev.captainAnalysis, newData.captainAnalysis),
    };
  }

  it('merges new managers into existing historyData', function () {
    const prev = { managers: [{ entry: 1, player_name: 'Alice' }] };
    const newManagers = [{ entry: 2, player_name: 'Bob' }];
    const result = mergeHistoryData(prev, newManagers);
    assert.equal(result.managers.length, 2);
    assert.equal(result.managers[0].entry, 1);
    assert.equal(result.managers[1].entry, 2);
  });

  it('handles null prev historyData gracefully', function () {
    const newManagers = [{ entry: 1, player_name: 'Alice' }];
    const result = mergeHistoryData(null, newManagers);
    assert.equal(result.managers.length, 1);
    assert.equal(result.managers[0].entry, 1);
  });

  it('handles prev with missing managers property', function () {
    const result = mergeHistoryData({}, [{ entry: 1 }]);
    assert.equal(result.managers.length, 1);
  });

  it('does not mutate previous managers array', function () {
    const prevManagers = [{ entry: 1 }];
    const prev = { managers: prevManagers };
    mergeHistoryData(prev, [{ entry: 2 }]);
    assert.equal(prevManagers.length, 1); // original untouched
  });

  it('merges new picks data into existing picksData', function () {
    const prev = {
      captainStats: { 1: { totalCaptainPoints: 100 } },
      benchDetails: { 1: [{ element: 50, points: 5 }] },
      captainAnalysis: { 1: { correctOwn: 10, totalGws: 20 } },
    };
    const newData = {
      captainStats: { 2: { totalCaptainPoints: 80 } },
      benchDetails: { 2: [{ element: 60, points: 3 }] },
      captainAnalysis: { 2: { correctOwn: 8, totalGws: 20 } },
    };
    const result = mergePicksData(prev, newData);
    assert.equal(result.captainStats[1].totalCaptainPoints, 100);
    assert.equal(result.captainStats[2].totalCaptainPoints, 80);
    assert.equal(result.benchDetails[1].length, 1);
    assert.equal(result.benchDetails[2].length, 1);
    assert.equal(result.captainAnalysis[1].correctOwn, 10);
    assert.equal(result.captainAnalysis[2].correctOwn, 8);
  });

  it('handles null prev picksData gracefully', function () {
    const newData = {
      captainStats: { 1: { totalCaptainPoints: 100 } },
      benchDetails: { 1: [] },
      captainAnalysis: { 1: { correctOwn: 5, totalGws: 10 } },
    };
    const result = mergePicksData(null, newData);
    assert.equal(result.captainStats[1].totalCaptainPoints, 100);
    assert.equal(result.captainAnalysis[1].correctOwn, 5);
  });
});

// --- Tests for captain analysis data building with missing/partial data ---

describe('captain analysis data building', function () {
  // Replicate the CaptainAnalysisTable data building logic from App.js
  function buildCaptainAnalysisData(standings, analysis) {
    return standings.map(function (s) {
      var ca = analysis[s.entry];
      if (!ca || ca.totalGws === 0) {
        return {
          entry: s.entry,
          player_name: s.player_name,
          totalGws: 0,
          correctOwn: 0,
          correctOwnPct: 0,
          correctOverall: 0,
          correctOverallPct: 0,
          gwDetails: [],
        };
      }
      return {
        entry: s.entry,
        player_name: s.player_name,
        totalGws: ca.totalGws,
        correctOwn: ca.correctOwn,
        correctOwnPct: Math.round((ca.correctOwn / ca.totalGws) * 100),
        correctOverall: ca.correctOverall,
        correctOverallPct: Math.round((ca.correctOverall / ca.totalGws) * 100),
        gwDetails: ca.gwDetails,
      };
    });
  }

  it('builds correct percentages from analysis data', function () {
    const standings = [{ entry: 1, player_name: 'Alice' }];
    const analysis = { 1: { totalGws: 20, correctOwn: 15, correctOverall: 5, gwDetails: [] } };
    const data = buildCaptainAnalysisData(standings, analysis);
    assert.equal(data[0].correctOwnPct, 75); // 15/20 = 75%
    assert.equal(data[0].correctOverallPct, 25); // 5/20 = 25%
  });

  it('returns zeros for managers not in analysis', function () {
    const standings = [
      { entry: 1, player_name: 'Alice' },
      { entry: 2, player_name: 'Bob' },
    ];
    const analysis = { 1: { totalGws: 10, correctOwn: 8, correctOverall: 3, gwDetails: [] } };
    const data = buildCaptainAnalysisData(standings, analysis);
    assert.equal(data[0].correctOwnPct, 80);
    assert.equal(data[1].totalGws, 0);
    assert.equal(data[1].correctOwnPct, 0);
    assert.equal(data[1].correctOverallPct, 0);
    assert.deepEqual(data[1].gwDetails, []);
  });

  it('returns zeros when analysis entry has totalGws of 0', function () {
    const standings = [{ entry: 1, player_name: 'Alice' }];
    const analysis = { 1: { totalGws: 0, correctOwn: 0, correctOverall: 0, gwDetails: [] } };
    const data = buildCaptainAnalysisData(standings, analysis);
    assert.equal(data[0].totalGws, 0);
    assert.equal(data[0].correctOwnPct, 0);
  });

  it('handles empty standings array', function () {
    assert.equal(buildCaptainAnalysisData([], {}).length, 0);
  });

  it('handles empty analysis object', function () {
    const standings = [{ entry: 1, player_name: 'Alice' }];
    const data = buildCaptainAnalysisData(standings, {});
    assert.equal(data[0].totalGws, 0);
    assert.equal(data[0].player_name, 'Alice');
  });

  it('handles 100% correct captain picks', function () {
    const standings = [{ entry: 1, player_name: 'Alice' }];
    const analysis = { 1: { totalGws: 25, correctOwn: 25, correctOverall: 25, gwDetails: [] } };
    const data = buildCaptainAnalysisData(standings, analysis);
    assert.equal(data[0].correctOwnPct, 100);
    assert.equal(data[0].correctOverallPct, 100);
  });
});

// --- Tests for cache path classification (isHistoricalPath) ---

describe('cache path classification', function () {
  // Replicate isHistoricalPath logic from App.js
  function isHistoricalPath(path, currentEvent) {
    if (!currentEvent) return false;
    var liveMatch = path.match(/^event\/(\d+)\/live$/);
    if (liveMatch) return parseInt(liveMatch[1], 10) < currentEvent;
    var picksMatch = path.match(/^entry\/\d+\/event\/(\d+)\/picks$/);
    if (picksMatch) return parseInt(picksMatch[1], 10) < currentEvent;
    return false;
  }

  it('classifies past GW live data as historical', function () {
    assert.equal(isHistoricalPath('event/5/live', 10), true);
    assert.equal(isHistoricalPath('event/1/live', 2), true);
  });

  it('classifies current GW live data as non-historical', function () {
    assert.equal(isHistoricalPath('event/10/live', 10), false);
  });

  it('classifies future GW live data as non-historical', function () {
    assert.equal(isHistoricalPath('event/15/live', 10), false);
  });

  it('classifies past GW picks as historical', function () {
    assert.equal(isHistoricalPath('entry/123/event/5/picks', 10), true);
  });

  it('classifies current GW picks as non-historical', function () {
    assert.equal(isHistoricalPath('entry/123/event/10/picks', 10), false);
  });

  it('returns false when currentEvent is null', function () {
    assert.equal(isHistoricalPath('event/5/live', null), false);
    assert.equal(isHistoricalPath('entry/123/event/5/picks', null), false);
  });

  it('returns false for non-matching paths', function () {
    assert.equal(isHistoricalPath('bootstrap-static', 10), false);
    assert.equal(isHistoricalPath('entry/123/history', 10), false);
    assert.equal(isHistoricalPath('', 10), false);
  });
});

// --- Tests for table data merge (standings + captain stats) ---

describe('table data merge logic', function () {
  // Replicate the data merge logic from LeagueStatsTable in App.js
  function mergeTableData(managers, captainStats) {
    return managers.map(function (m) {
      var cs = captainStats ? captainStats[m.entry] : null;
      return {
        entry: m.entry,
        player_name: m.player_name,
        entry_name: m.entry_name,
        total: m.total,
        rank: m.rank,
        totalBenchPoints: m.totalBenchPoints,
        totalTransfers: m.totalTransfers,
        totalHitsCost: m.totalHitsCost,
        totalCaptainPoints: cs ? cs.totalCaptainPoints : null,
        captainChoices: cs ? cs.captainChoices : {},
      };
    });
  }

  const managers = [
    { entry: 1, player_name: 'Alice', entry_name: 'Team A', total: 500, rank: 1, totalBenchPoints: 50, totalTransfers: 10, totalHitsCost: 8 },
    { entry: 2, player_name: 'Bob', entry_name: 'Team B', total: 480, rank: 2, totalBenchPoints: 40, totalTransfers: 12, totalHitsCost: 4 },
  ];

  it('merges captain stats into manager data', function () {
    const captainStats = {
      1: { totalCaptainPoints: 200, captainChoices: { '100': { count: 5, points: 80 } } },
      2: { totalCaptainPoints: 180, captainChoices: {} },
    };
    const data = mergeTableData(managers, captainStats);
    assert.equal(data[0].totalCaptainPoints, 200);
    assert.equal(data[1].totalCaptainPoints, 180);
    assert.equal(data[0].captainChoices['100'].count, 5);
  });

  it('returns null captain points when stats not yet loaded', function () {
    const data = mergeTableData(managers, null);
    assert.equal(data[0].totalCaptainPoints, null);
    assert.deepEqual(data[0].captainChoices, {});
    assert.equal(data[1].totalCaptainPoints, null);
  });

  it('returns null captain points for managers missing from captainStats', function () {
    const captainStats = {
      1: { totalCaptainPoints: 200, captainChoices: {} },
      // entry 2 not present — newly loaded manager
    };
    const data = mergeTableData(managers, captainStats);
    assert.equal(data[0].totalCaptainPoints, 200);
    assert.equal(data[1].totalCaptainPoints, null);
    assert.deepEqual(data[1].captainChoices, {});
  });

  it('preserves all manager fields through merge', function () {
    const data = mergeTableData(managers, null);
    assert.equal(data[0].player_name, 'Alice');
    assert.equal(data[0].entry_name, 'Team A');
    assert.equal(data[0].total, 500);
    assert.equal(data[0].rank, 1);
    assert.equal(data[0].totalBenchPoints, 50);
    assert.equal(data[0].totalTransfers, 10);
    assert.equal(data[0].totalHitsCost, 8);
  });

  it('handles empty managers array', function () {
    const data = mergeTableData([], { 1: { totalCaptainPoints: 100, captainChoices: {} } });
    assert.equal(data.length, 0);
  });
});
