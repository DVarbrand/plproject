// App.js

// --- Utilities ---

var fetchCache = {};
var CACHE_TTL = 5 * 60 * 1000; // 5 minutes for live data
var currentEvent = null; // set from bootstrap-static

// Paths containing historical (completed) GW data can be cached permanently.
// Only the current GW and global endpoints need short TTL.
function isHistoricalPath(path) {
  if (!currentEvent) return false;
  // event/{gw}/live - historical if gw < current
  var liveMatch = path.match(/^event\/(\d+)\/live$/);
  if (liveMatch) return parseInt(liveMatch[1], 10) < currentEvent;
  // entry/{id}/event/{gw}/picks - historical if gw < current
  var picksMatch = path.match(/^entry\/\d+\/event\/(\d+)\/picks$/);
  if (picksMatch) return parseInt(picksMatch[1], 10) < currentEvent;
  return false;
}

function fplFetch(path) {
  var cached = fetchCache[path];
  if (cached) {
    // Historical data: cache forever. Live data: respect TTL.
    if (cached.permanent || Date.now() - cached.time < CACHE_TTL) {
      return Promise.resolve(cached.data);
    }
  }
  return fetch('/api/fpl/' + path).then(function (r) {
    if (!r.ok) throw new Error('FPL API error: ' + r.status);
    return r.json();
  }).then(function (data) {
    fetchCache[path] = { data: data, time: Date.now(), permanent: isHistoricalPath(path) };
    return data;
  });
}

async function batchFetch(paths, concurrency, onProgress, maxRetries) {
  var retries = maxRetries || 0;
  var results = new Array(paths.length);
  var remaining = paths.map(function (p, i) { return { path: p, index: i }; });

  for (var attempt = 0; attempt <= retries; attempt++) {
    var failed = [];
    for (var i = 0; i < remaining.length; i += concurrency) {
      var batch = remaining.slice(i, i + concurrency);
      var batchResults = await Promise.all(batch.map(function (item) {
        return fplFetch(item.path).then(function (data) {
          return { index: item.index, data: data };
        }).catch(function (err) {
          console.warn('Fetch failed for ' + item.path + ':', err.message);
          return { index: item.index, data: null, failed: true, path: item.path };
        });
      }));
      batchResults.forEach(function (r) {
        if (r.failed) {
          failed.push({ path: r.path, index: r.index });
        } else {
          results[r.index] = r.data;
        }
      });
      if (onProgress) {
        var doneCount = results.filter(function (r) { return r !== undefined; }).length;
        onProgress(doneCount, paths.length);
      }
      if (i + concurrency < remaining.length) {
        await new Promise(function (r) { setTimeout(r, 50); });
      }
    }
    if (failed.length === 0) break;
    remaining = failed;
    if (attempt < retries) {
      var delay = Math.min(1000 * Math.pow(2, attempt), 4000);
      console.log('Retrying ' + failed.length + ' failed requests (attempt ' + (attempt + 2) + ')...');
      await new Promise(function (r) { setTimeout(r, delay); });
    }
  }

  // Fill any still-missing slots with null
  for (var j = 0; j < results.length; j++) {
    if (results[j] === undefined) results[j] = null;
  }
  return results;
}

var CHART_COLORS = [
  '#3b82f6', '#10b981', '#ef4444', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#e11d48', '#a855f7', '#0ea5e9', '#d946ef',
  '#65a30d', '#dc2626', '#0891b2', '#7c3aed', '#c026d3',
];

// --- Components ---

function PointsChart(props) {
  var canvasRef = React.useRef(null);
  var chartRef = React.useRef(null);
  var [mode, setMode] = React.useState('relative'); // 'relative' or 'rank'
  var [topN, setTopN] = React.useState(0); // 0 = all
  var [gwRange, setGwRange] = React.useState([1, 38]);
  var [focusedSet, setFocusedSet] = React.useState({});
  var [maxGw, setMaxGw] = React.useState(38);
  var sliderRef = React.useRef(null);
  var [dragging, setDragging] = React.useState(null); // 'min', 'max', or null

  var hasFocus = Object.keys(focusedSet).length > 0;

  function toggleFocus(idx) {
    setFocusedSet(function (prev) {
      var next = Object.assign({}, prev);
      if (next[idx]) { delete next[idx]; } else { next[idx] = true; }
      return next;
    });
  }

  function clearFocus() { setFocusedSet({}); }

  var managersWithHistory = (props.managers || []).filter(function (m) { return m.history.length > 0; });

  // Compute max GW on data change
  React.useEffect(function () {
    if (managersWithHistory.length === 0) return;
    var gwCount = managersWithHistory[0].history.length;
    setMaxGw(gwCount);
    setGwRange(function (prev) {
      return [1, gwCount];
    });
  }, [props.managers]);

  // Build + render chart
  React.useEffect(function () {
    if (managersWithHistory.length === 0 || !canvasRef.current) return;
    if (chartRef.current) chartRef.current.destroy();

    var allHistory = managersWithHistory[0].history;
    var gwStart = gwRange[0];
    var gwEnd = gwRange[1];

    // Filter GW range
    var gwIndices = [];
    allHistory.forEach(function (h, idx) {
      var gwNum = h.event;
      if (gwNum >= gwStart && gwNum <= gwEnd) gwIndices.push(idx);
    });
    if (gwIndices.length === 0) return;

    var labels = gwIndices.map(function (idx) { return 'GW' + allHistory[idx].event; });

    // Determine which managers to show (top N by current total points)
    var sortedManagers = managersWithHistory.slice().sort(function (a, b) { return b.total - a.total; });
    var visibleManagers = topN > 0 ? sortedManagers.slice(0, topN) : sortedManagers;
    // Keep original index for color assignment
    var visibleSet = {};
    visibleManagers.forEach(function (m) { visibleSet[m.entry] = true; });

    if (mode === 'relative') {
      // Compute league average per GW (cumulative total_points)
      var avgPerGw = gwIndices.map(function (gwIdx) {
        var sum = 0;
        managersWithHistory.forEach(function (m) { sum += m.history[gwIdx].total_points; });
        return sum / managersWithHistory.length;
      });

      var datasets = managersWithHistory.map(function (m, origIdx) {
        if (!visibleSet[m.entry]) return null;
        var data = gwIndices.map(function (gwIdx, j) {
          return Math.round(m.history[gwIdx].total_points - avgPerGw[j]);
        });
        var isFocused = !hasFocus || focusedSet[origIdx];
        return {
          label: m.player_name,
          data: data,
          borderColor: CHART_COLORS[origIdx % CHART_COLORS.length],
          backgroundColor: CHART_COLORS[origIdx % CHART_COLORS.length],
          fill: false,
          tension: 0.2,
          pointRadius: isFocused ? 2 : 0,
          borderWidth: isFocused ? 2.5 : 1,
          borderDash: isFocused ? [] : [],
          hidden: false,
          _origIdx: origIdx,
        };
      }).filter(Boolean);

      // Apply focus opacity via borderColor alpha
      if (hasFocus) {
        datasets.forEach(function (ds) {
          if (!focusedSet[ds._origIdx]) {
            ds.borderColor = ds.borderColor + '25';
            ds.backgroundColor = ds.backgroundColor + '25';
          }
        });
      }

      chartRef.current = new Chart(canvasRef.current, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: {
          responsive: true,
          animation: { duration: 300 },
          plugins: {
            title: { display: true, text: 'Points vs League Average', font: { size: 14, weight: 600 }, color: '#1e293b' },
            legend: {
              position: 'bottom',
              labels: { boxWidth: 12, font: { size: 11 }, color: '#64748b' },
              onClick: function (e, legendItem, legend) {
                var idx = managersWithHistory.findIndex(function (m) { return m.player_name === legendItem.text; });
                toggleFocus(idx);
              },
            },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  var val = ctx.parsed.y;
                  return ctx.dataset.label + ': ' + (val >= 0 ? '+' : '') + val + ' pts';
                },
              },
            },
          },
          scales: {
            y: {
              title: { display: true, text: 'Points vs Average', color: '#64748b' },
              ticks: { color: '#94a3b8', callback: function (v) { return (v >= 0 ? '+' : '') + v; } },
              grid: { color: function (ctx) { return ctx.tick.value === 0 ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.06)'; } },
            },
            x: { title: { display: true, text: 'Gameweek', color: '#64748b' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(0,0,0,0.06)' } },
          },
        },
      });
    } else {
      // Rank mode: compute rank per GW
      var rankData = {};
      managersWithHistory.forEach(function (m) { rankData[m.entry] = []; });

      gwIndices.forEach(function (gwIdx) {
        var gwScores = managersWithHistory.map(function (m) {
          return { entry: m.entry, pts: m.history[gwIdx].total_points };
        }).sort(function (a, b) { return b.pts - a.pts; });
        gwScores.forEach(function (s, rank) { rankData[s.entry].push(rank + 1); });
      });

      var datasets = managersWithHistory.map(function (m, origIdx) {
        if (!visibleSet[m.entry]) return null;
        var isFocused = !hasFocus || focusedSet[origIdx];
        return {
          label: m.player_name,
          data: rankData[m.entry],
          borderColor: CHART_COLORS[origIdx % CHART_COLORS.length],
          backgroundColor: CHART_COLORS[origIdx % CHART_COLORS.length],
          fill: false,
          tension: 0.2,
          pointRadius: isFocused ? 2 : 0,
          borderWidth: isFocused ? 2.5 : 1,
          _origIdx: origIdx,
        };
      }).filter(Boolean);

      if (hasFocus) {
        datasets.forEach(function (ds) {
          if (!focusedSet[ds._origIdx]) {
            ds.borderColor = ds.borderColor + '25';
            ds.backgroundColor = ds.backgroundColor + '25';
          }
        });
      }

      chartRef.current = new Chart(canvasRef.current, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: {
          responsive: true,
          animation: { duration: 300 },
          plugins: {
            title: { display: true, text: 'League Position Over Time', font: { size: 14, weight: 600 }, color: '#1e293b' },
            legend: {
              position: 'bottom',
              labels: { boxWidth: 12, font: { size: 11 }, color: '#64748b' },
              onClick: function (e, legendItem, legend) {
                var idx = managersWithHistory.findIndex(function (m) { return m.player_name === legendItem.text; });
                toggleFocus(idx);
              },
            },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  return ctx.dataset.label + ': #' + ctx.parsed.y;
                },
              },
            },
          },
          scales: {
            y: {
              reverse: true,
              min: 1,
              max: managersWithHistory.length,
              title: { display: true, text: 'Position', color: '#64748b' },
              ticks: {
                color: '#94a3b8',
                stepSize: 1,
                callback: function (v) { return '#' + v; },
              },
              grid: { color: 'rgba(0,0,0,0.06)' },
            },
            x: { title: { display: true, text: 'Gameweek', color: '#64748b' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(0,0,0,0.06)' } },
          },
        },
      });
    }

    return function () { if (chartRef.current) chartRef.current.destroy(); };
  }, [props.managers, mode, topN, gwRange, focusedSet]);

  if (managersWithHistory.length === 0) return null;

  var topNOptions = [
    { label: 'All', value: 0 },
    { label: 'Top 5', value: 5 },
    { label: 'Top 10', value: 10 },
  ];

  return (
    <div>
      <div className="chart-controls">
        <div className="chart-toggle">
          <button
            className={'chart-toggle-btn' + (mode === 'relative' ? ' active' : '')}
            onClick={function () { setMode('relative'); }}
          >Points</button>
          <button
            className={'chart-toggle-btn' + (mode === 'rank' ? ' active' : '')}
            onClick={function () { setMode('rank'); }}
          >Rank</button>
        </div>

        <div className="chart-filters">
          <div className="chart-filter-group">
            <span className="chart-filter-label">Show:</span>
            {topNOptions.map(function (opt) {
              return (
                <button
                  key={opt.value}
                  className={'chart-filter-btn' + (topN === opt.value ? ' active' : '')}
                  onClick={function () { setTopN(opt.value); clearFocus(); }}
                >{opt.label}</button>
              );
            })}
          </div>

        </div>

        {hasFocus ? (
          <button className="chart-clear-focus" onClick={clearFocus}>
            Clear focus ({Object.keys(focusedSet).length})
          </button>
        ) : (
          <span className="chart-hint">Click names in the legend to focus</span>
        )}
      </div>
      <canvas ref={canvasRef}></canvas>
      <div className="gw-slider-container">
        <div className="gw-slider-track" ref={sliderRef}
          onMouseDown={function (e) {
            if (!sliderRef.current) return;
            var rect = sliderRef.current.getBoundingClientRect();
            var pct = (e.clientX - rect.left) / rect.width;
            var gw = Math.round(pct * (maxGw - 1)) + 1;
            gw = Math.max(1, Math.min(maxGw, gw));
            // Determine which handle is closer
            var distMin = Math.abs(gw - gwRange[0]);
            var distMax = Math.abs(gw - gwRange[1]);
            if (distMin <= distMax) {
              setDragging('min');
              setGwRange(function (prev) { return [Math.min(gw, prev[1]), prev[1]]; });
            } else {
              setDragging('max');
              setGwRange(function (prev) { return [prev[0], Math.max(gw, prev[0])]; });
            }
            function onMove(ev) {
              if (!sliderRef.current) return;
              var r = sliderRef.current.getBoundingClientRect();
              var p = (ev.clientX - r.left) / r.width;
              var g = Math.round(p * (maxGw - 1)) + 1;
              g = Math.max(1, Math.min(maxGw, g));
              setGwRange(function (prev) {
                // Use the dragging handle determined at mousedown via closure
                if (distMin <= distMax) {
                  return [Math.min(g, prev[1]), prev[1]];
                } else {
                  return [prev[0], Math.max(g, prev[0])];
                }
              });
            }
            function onUp() {
              setDragging(null);
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            }
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
          onTouchStart={function (e) {
            if (!sliderRef.current) return;
            var touch = e.touches[0];
            var rect = sliderRef.current.getBoundingClientRect();
            var pct = (touch.clientX - rect.left) / rect.width;
            var gw = Math.round(pct * (maxGw - 1)) + 1;
            gw = Math.max(1, Math.min(maxGw, gw));
            var distMin = Math.abs(gw - gwRange[0]);
            var distMax = Math.abs(gw - gwRange[1]);
            if (distMin <= distMax) {
              setDragging('min');
              setGwRange(function (prev) { return [Math.min(gw, prev[1]), prev[1]]; });
            } else {
              setDragging('max');
              setGwRange(function (prev) { return [prev[0], Math.max(gw, prev[0])]; });
            }
            function onTouchMove(ev) {
              if (!sliderRef.current) return;
              var t = ev.touches[0];
              var r = sliderRef.current.getBoundingClientRect();
              var p = (t.clientX - r.left) / r.width;
              var g = Math.round(p * (maxGw - 1)) + 1;
              g = Math.max(1, Math.min(maxGw, g));
              setGwRange(function (prev) {
                if (distMin <= distMax) {
                  return [Math.min(g, prev[1]), prev[1]];
                } else {
                  return [prev[0], Math.max(g, prev[0])];
                }
              });
            }
            function onTouchEnd() {
              setDragging(null);
              window.removeEventListener('touchmove', onTouchMove);
              window.removeEventListener('touchend', onTouchEnd);
            }
            window.addEventListener('touchmove', onTouchMove);
            window.addEventListener('touchend', onTouchEnd);
          }}
        >
          <div className="gw-slider-fill" style={{
            left: ((gwRange[0] - 1) / (maxGw - 1) * 100) + '%',
            width: (((gwRange[1] - gwRange[0]) / (maxGw - 1)) * 100) + '%',
          }}></div>
          <div className="gw-slider-handle" style={{ left: ((gwRange[0] - 1) / (maxGw - 1) * 100) + '%' }}>
            <span className="gw-slider-label">GW{gwRange[0]}</span>
          </div>
          <div className="gw-slider-handle" style={{ left: ((gwRange[1] - 1) / (maxGw - 1) * 100) + '%' }}>
            <span className="gw-slider-label">GW{gwRange[1]}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RankBadge(props) {
  var rank = props.rank;
  var cls = 'rank-badge';
  if (rank <= 3) cls += ' rank-' + rank;
  return <span className={cls}>{rank}</span>;
}

function LeagueStatsTable(props) {
  var managers = props.managers;
  var captainStats = props.captainStats;
  var benchDetails = props.benchDetails;
  var names = props.playerNames;
  var loading = props.loading;

  var [sortKey, setSortKey] = React.useState('totalBenchPoints');
  var [sortDir, setSortDir] = React.useState('desc');
  var [expandedEntry, setExpandedEntry] = React.useState(null);

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  function toggleRow(entry) {
    setExpandedEntry(expandedEntry === entry ? null : entry);
  }

  // Build unified data: merge history stats with captain stats
  var data = managers.map(function (m) {
    var cs = captainStats ? captainStats[m.entry] : null;
    return {
      entry: m.entry,
      player_name: m.player_name,
      totalBenchPoints: m.totalBenchPoints,
      totalTransfers: m.totalTransfers,
      totalHitsCost: m.totalHitsCost,
      totalCaptainPoints: cs ? cs.totalCaptainPoints : null,
      captainChoices: cs ? cs.captainChoices : {},
    };
  });

  // Sort
  var sorted = data.slice().sort(function (a, b) {
    var aVal = a[sortKey];
    var bVal = b[sortKey];
    // Handle null (loading captain data)
    if (aVal === null) aVal = -1;
    if (bVal === null) bVal = -1;
    if (sortKey === 'player_name') {
      aVal = (aVal || '').toLowerCase();
      bVal = (bVal || '').toLowerCase();
      return sortDir === 'asc' ? (aVal < bVal ? -1 : 1) : (aVal > bVal ? -1 : 1);
    }
    return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
  });

  var columns = [
    { key: 'totalBenchPoints', label: 'Bench Pts' },
    { key: 'totalTransfers', label: 'Transfers' },
    { key: 'totalHitsCost', label: 'Hits Cost' },
    { key: 'totalCaptainPoints', label: 'Captain Pts' },
  ];

  function sortIndicator(key) {
    if (sortKey !== key) return <span className="sort-icon sort-inactive">&#8597;</span>;
    return <span className="sort-icon sort-active">{sortDir === 'desc' ? '\u25BC' : '\u25B2'}</span>;
  }

  var colSpan = 2 + columns.length; // # + Manager + stat columns

  return (
    <div className="stats-section">
      <h2>Detailed League Stats</h2>
      <div className="table-scroll-wrapper">
      <table className="standings-table stats-table">
        <thead>
          <tr>
            <th>#</th>
            <th className="sortable-th" onClick={function () { handleSort('player_name'); }}>
              Manager {sortIndicator('player_name')}
            </th>
            {columns.map(function (col) {
              return (
                <th key={col.key} className="col-num sortable-th" onClick={function () { handleSort(col.key); }}>
                  {col.label} {sortIndicator(col.key)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map(function (row, i) {
            var details = benchDetails ? (benchDetails[row.entry] || []) : [];
            var choices = row.captainChoices || {};
            var choiceList = Object.keys(choices).map(function (pid) {
              return { name: names[pid] || 'Unknown', count: choices[pid].count, points: choices[pid].points };
            }).sort(function (a, b) { return b.count - a.count; });
            var hasBenchDetails = details.length > 0;
            var hasCaptainDetails = choiceList.length > 0;
            var isExpanded = expandedEntry === row.entry;
            var isClickable = loading || hasBenchDetails || hasCaptainDetails;

            return React.createElement(React.Fragment, { key: row.entry },
              <tr
                className={isClickable ? 'expandable-row' : ''}
                onClick={isClickable ? function () { toggleRow(row.entry); } : undefined}
              >
                <td><RankBadge rank={i + 1} /></td>
                <td>
                  {row.player_name}
                  {isClickable ? <span className={'expand-icon' + (isExpanded ? ' expanded' : '')}>&#9662;</span> : null}
                </td>
                <td className="col-num">{row.totalBenchPoints}</td>
                <td className="col-num">{row.totalTransfers}</td>
                <td className="col-num">{row.totalHitsCost}</td>
                <td className="col-num">
                  {row.totalCaptainPoints !== null ? row.totalCaptainPoints : <span className="value-loading"></span>}
                </td>
              </tr>,
              isExpanded ? (
                <tr className="bench-detail-row">
                  <td colSpan={colSpan}>
                    {loading ? (
                      <div className="detail-loading">Loading details...</div>
                    ) : (
                      <div className="detail-sections">
                        {hasBenchDetails ? (
                          <div className="bench-detail-list">
                            <span className="bench-detail-label">Worst left on bench:</span>
                            {details.map(function (d, j) {
                              return (
                                <span key={j} className="bench-detail-item">
                                  <span className="bench-detail-name">{names[d.element] || 'Unknown'}</span>
                                  <span className="bench-detail-pts">{d.points} pts</span>
                                  <span className="bench-detail-gw">GW{d.gw}</span>
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                        {hasCaptainDetails ? (
                          <div className="bench-detail-list">
                            <span className="bench-detail-label">Captains picked:</span>
                            {choiceList.map(function (c, j) {
                              return (
                                <span key={j} className="bench-detail-item">
                                  <span className="bench-detail-name">{c.name}</span>
                                  <span className="bench-detail-pts">{c.count}x</span>
                                  <span className="bench-detail-gw">{c.points} pts</span>
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                        {!hasBenchDetails && !hasCaptainDetails ? (
                          <div className="detail-loading" style={{ animation: 'none', color: '#999' }}>No details available</div>
                        ) : null}
                      </div>
                    )}
                  </td>
                </tr>
              ) : null
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function ProgressBar(props) {
  return (
    <div className="progress-container">
      <div className="progress-bar" style={{ width: props.percent + '%' }}></div>
      <span className="progress-text">{props.label || (Math.round(props.percent) + '%')}</span>
    </div>
  );
}

function LeagueStats(props) {
  var standings = props.standings;
  var playerNames = props.playerNames;

  // Phase 1: history-based data (chart, bench totals, hits)
  var [historyData, setHistoryData] = React.useState(null);
  // Phase 2: picks-based data (captain stats, bench details)
  var [picksData, setPicksData] = React.useState(null);
  var [resolvedNames, setResolvedNames] = React.useState({});

  var [phase1Loading, setPhase1Loading] = React.useState(false);
  var [phase2Loading, setPhase2Loading] = React.useState(false);
  var [progress, setProgress] = React.useState(0);
  var [progressLabel, setProgressLabel] = React.useState('');
  var [statsError, setStatsError] = React.useState(null);

  async function loadAllStats() {
    setPhase1Loading(true);
    setStatsError(null);
    setProgress(0);
    setHistoryData(null);
    setPicksData(null);

    try {
      var managerIds = standings.map(function (s) { return s.entry; });

      // Phase 1: Fetch player names + histories in parallel
      setProgressLabel('Fetching manager histories...');
      var historyPaths = managerIds.map(function (id) { return 'entry/' + id + '/history'; });

      var bootstrapPromise = fplFetch('bootstrap-static').catch(function (err) {
        console.warn('Bootstrap fetch failed:', err.message);
        return null;
      });

      var histories = await batchFetch(historyPaths, 5, function (done, total) {
        setProgress(Math.round((done / total) * 30));
      }, 3);

      var bootstrapData = await bootstrapPromise;

      // Determine current gameweek for cache strategy
      if (bootstrapData && bootstrapData.events) {
        var currentGw = bootstrapData.events.find(function (e) { return e.is_current; });
        if (currentGw) currentEvent = currentGw.id;
      }

      // Build player names map
      var names = {};
      if (Object.keys(playerNames).length > 0) {
        names = playerNames;
      } else if (bootstrapData && bootstrapData.elements) {
        bootstrapData.elements.forEach(function (p) { names[p.id] = p.web_name; });
      }
      if (Object.keys(names).length === 0) {
        try {
          var retryBootstrap = await fplFetch('bootstrap-static');
          if (retryBootstrap && retryBootstrap.elements) {
            retryBootstrap.elements.forEach(function (p) { names[p.id] = p.web_name; });
          }
        } catch (err) {
          console.warn('Bootstrap retry also failed:', err.message);
        }
      }
      setResolvedNames(names);

      var successCount = histories.filter(function (h) { return h !== null; }).length;
      if (successCount === 0) {
        throw new Error('Could not fetch any manager data. The FPL API may be temporarily unavailable.');
      }

      // Build manager data from histories
      var managerData = standings.map(function (s, i) {
        var h = histories[i];
        var history = (h && h.current) ? h.current : [];
        var chips = (h && h.chips) ? h.chips : [];
        var totalBenchPoints = history.reduce(function (sum, gw) { return sum + (gw.points_on_bench || 0); }, 0);
        var totalHitsCost = history.reduce(function (sum, gw) { return sum + (gw.event_transfers_cost || 0); }, 0);
        var totalTransfers = history.reduce(function (sum, gw) { return sum + (gw.event_transfers || 0); }, 0);
        return {
          entry: s.entry,
          player_name: s.player_name,
          entry_name: s.entry_name,
          total: s.total,
          history: history,
          chips: chips,
          totalBenchPoints: totalBenchPoints,
          totalHitsCost: totalHitsCost,
          totalTransfers: totalTransfers,
        };
      });

      // Phase 1 done - render chart + bench totals + hits immediately
      setHistoryData({ managers: managerData });
      setPhase1Loading(false);

      // Phase 2: Fetch live GW data + picks in background
      setPhase2Loading(true);
      var firstWithHistory = managerData.find(function (m) { return m.history.length > 0; });
      var completedEvents = firstWithHistory ? firstWithHistory.history.map(function (h) { return h.event; }) : [];

      var captainResults = {};
      var benchDetails = {};
      managerIds.forEach(function (id) {
        captainResults[id] = { totalCaptainPoints: 0, captainChoices: {}, gwCount: 0 };
        benchDetails[id] = [];
      });

      if (completedEvents.length > 0) {
        setProgressLabel('Fetching gameweek data...');
        var livePaths = completedEvents.map(function (gw) { return 'event/' + gw + '/live'; });
        var liveResults = await batchFetch(livePaths, 10, function (done, total) {
          setProgress(30 + Math.round((done / total) * 20));
        }, 3);

        var liveData = {};
        completedEvents.forEach(function (gw, i) {
          if (!liveResults[i] || !liveResults[i].elements) return;
          var gwData = {};
          liveResults[i].elements.forEach(function (el) {
            gwData[el.id] = el.stats.total_points;
          });
          liveData[gw] = gwData;
        });

        setProgressLabel('Fetching picks data...');
        var allPickPaths = [];
        var allPickMeta = [];
        managerIds.forEach(function (id) {
          completedEvents.forEach(function (gw) {
            allPickPaths.push('entry/' + id + '/event/' + gw + '/picks');
            allPickMeta.push({ managerId: id, gw: gw });
          });
        });

        var pickResults = await batchFetch(allPickPaths, 10, function (done, total) {
          setProgress(50 + Math.round((done / total) * 50));
        }, 3);

        pickResults.forEach(function (pickData, idx) {
          if (!pickData || !pickData.picks) return;
          var meta = allPickMeta[idx];

          var captain = pickData.picks.find(function (p) { return p.is_captain; });
          if (captain && liveData[meta.gw]) {
            var points = (liveData[meta.gw][captain.element] || 0) * captain.multiplier;
            captainResults[meta.managerId].totalCaptainPoints += points;
            captainResults[meta.managerId].gwCount++;
            var playerId = captain.element;
            if (!captainResults[meta.managerId].captainChoices[playerId]) {
              captainResults[meta.managerId].captainChoices[playerId] = { count: 0, points: 0 };
            }
            captainResults[meta.managerId].captainChoices[playerId].count++;
            captainResults[meta.managerId].captainChoices[playerId].points += points;
          }

          if (liveData[meta.gw]) {
            pickData.picks.forEach(function (pick) {
              if (pick.position >= 12) {
                var benchPts = liveData[meta.gw][pick.element] || 0;
                if (benchPts > 0) {
                  benchDetails[meta.managerId].push({
                    element: pick.element,
                    points: benchPts,
                    gw: meta.gw,
                  });
                }
              }
            });
          }
        });

        managerIds.forEach(function (id) {
          benchDetails[id].sort(function (a, b) { return b.points - a.points; });
          benchDetails[id] = benchDetails[id].slice(0, 3);
        });
      }

      setProgress(100);
      setProgressLabel('');
      setPicksData({ captainStats: captainResults, benchDetails: benchDetails });
      setPhase2Loading(false);
    } catch (err) {
      console.error('Stats error:', err);
      setStatsError('Failed to load league stats: ' + err.message);
      setPhase1Loading(false);
      setPhase2Loading(false);
    }
  }

  if (!historyData && !phase1Loading) {
    return (
      <div className="stats-section" style={{ textAlign: 'center' }}>
        <button className="league-button stats-button" onClick={loadAllStats}>
          Load Detailed Stats
        </button>
      </div>
    );
  }

  if (phase1Loading) {
    return (
      <div className="stats-section">
        <h2>Loading League Stats</h2>
        <ProgressBar percent={progress} label={progressLabel ? progressLabel + ' ' + Math.round(progress) + '%' : null} />
      </div>
    );
  }

  if (statsError) {
    return <p className="error-message">{statsError}</p>;
  }

  // Phase 1 data ready - show chart + unified stats table
  var managers = historyData.managers;

  // Summary KPI values
  var totalManagers = managers.length;
  var avgPoints = managers.length > 0 ? Math.round(managers.reduce(function (s, m) { return s + m.total; }, 0) / managers.length) : 0;
  var totalBenchWasted = managers.reduce(function (s, m) { return s + m.totalBenchPoints; }, 0);
  var totalHitsCost = managers.reduce(function (s, m) { return s + m.totalHitsCost; }, 0);

  // Phase 2 data - captain stats + bench details (may still be loading)
  var captainStats = picksData ? picksData.captainStats : null;
  var benchDetails = picksData ? picksData.benchDetails : null;

  return (
    <div className="stats-dashboard">
      <div className="summary-row">
        <div className="summary-item">
          <div className="summary-label">Managers</div>
          <div className="summary-value">{totalManagers}</div>
        </div>
        <div className="summary-item">
          <div className="summary-label">Avg Points</div>
          <div className="summary-value blue">{avgPoints.toLocaleString()}</div>
        </div>
        <div className="summary-item">
          <div className="summary-label">Total Bench Wasted</div>
          <div className="summary-value orange">{totalBenchWasted.toLocaleString()}</div>
        </div>
        <div className="summary-item">
          <div className="summary-label">Total Hits Taken</div>
          <div className="summary-value red">{totalHitsCost > 0 ? '-' + totalHitsCost.toLocaleString() : '0'}</div>
        </div>
      </div>

      <div className="chart-container">
        <PointsChart managers={managers} />
      </div>

      {phase2Loading ? (
        <div style={{ marginBottom: '0.5rem' }}>
          <ProgressBar percent={progress} label={progressLabel ? progressLabel + ' ' + Math.round(progress) + '%' : null} />
        </div>
      ) : null}

      <LeagueStatsTable
        managers={managers}
        captainStats={captainStats}
        benchDetails={benchDetails}
        playerNames={resolvedNames}
        loading={phase2Loading}
      />
    </div>
  );
}

function getLeagueIdFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return params.get('leagueId') || '';
}

function App() {
  var [leagueId, setLeagueId] = React.useState(getLeagueIdFromUrl);
  var [standings, setStandings] = React.useState([]);
  var [leagueName, setLeagueName] = React.useState('');
  var [playerNames, setPlayerNames] = React.useState({});
  var [error, setError] = React.useState(null);
  var [loading, setLoading] = React.useState(false);

  function fetchLeague(id) {
    if (!id.trim()) return;

    setLoading(true);
    setError(null);
    setStandings([]);

    fetch('/api/standings/' + id.trim())
      .then(function (r) {
        if (!r.ok) throw new Error('API request failed with status ' + r.status);
        return r.json();
      })
      .then(function (data) {
        setStandings(data.standings.results);
        setLeagueName(data.league ? data.league.name : '');
        setLoading(false);

        // Update URL without reload
        var url = new URL(window.location);
        url.searchParams.set('leagueId', id.trim());
        window.history.pushState({}, '', url);

        // Load player names + current GW in background
        fplFetch('bootstrap-static')
          .then(function (bootstrap) {
            var players = {};
            bootstrap.elements.forEach(function (p) { players[p.id] = p.web_name; });
            setPlayerNames(players);
            if (bootstrap.events) {
              var cur = bootstrap.events.find(function (e) { return e.is_current; });
              if (cur) currentEvent = cur.id;
            }
          })
          .catch(function (err) { console.warn('Bootstrap fetch failed:', err.message); });
      })
      .catch(function (err) {
        console.error('Error fetching data:', err);
        setError('Failed to load standings. Check the league ID and try again.');
        setLoading(false);
      });
  }

  function handleSubmit(e) {
    e.preventDefault();
    fetchLeague(leagueId);
  }

  // Auto-fetch if league ID is in URL on mount
  React.useEffect(function () {
    var urlId = getLeagueIdFromUrl();
    if (urlId) fetchLeague(urlId);
  }, []);

  // Handle browser back/forward
  React.useEffect(function () {
    function onPopState() {
      var urlId = getLeagueIdFromUrl();
      setLeagueId(urlId);
      if (urlId) {
        fetchLeague(urlId);
      } else {
        setStandings([]);
        setError(null);
      }
    }
    window.addEventListener('popstate', onPopState);
    return function () { window.removeEventListener('popstate', onPopState); };
  }, []);

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-logo">FPL</div>
        <h1>FPL League Hub</h1>
        <span className="header-badge">2025/26</span>
      </header>
      <main className="app-content">
        <form className="league-form" onSubmit={handleSubmit}>
          <input
            type="text"
            className="league-input"
            placeholder="Enter league ID..."
            value={leagueId}
            onChange={function (e) { setLeagueId(e.target.value); }}
          />
          <button type="submit" className="league-button" disabled={loading}>
            {loading ? 'Loading...' : 'Fetch Standings'}
          </button>
          {standings.length > 0 ? (
            <button type="button" className="league-button share-button" onClick={function () {
              navigator.clipboard.writeText(window.location.href).then(function () {
                var btn = document.querySelector('.share-button');
                var orig = btn.innerHTML;
                btn.textContent = '\u2713 Copied!';
                setTimeout(function () { btn.innerHTML = orig; }, 2000);
              });
            }}>&#x1F517; Share</button>
          ) : null}
        </form>
        {error ? (
          <p className="error-message">{error}</p>
        ) : loading ? (
          <p className="loading-text">Loading standings...</p>
        ) : standings.length > 0 ? (
          <div>
            {leagueName ? <h2 className="league-name">{leagueName}</h2> : null}
            <div className="stat-card" style={{ marginBottom: 20 }}>
              <div className="card-header"><div className="card-indicator"></div> League Standings</div>
              <div className="table-scroll-wrapper">
              <table className="standings-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Manager</th>
                    <th>Team Name</th>
                    <th className="col-num">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map(function (player, index) {
                    return (
                      <tr key={player.entry}>
                        <td><RankBadge rank={index + 1} /></td>
                        <td>{player.player_name}</td>
                        <td>{player.entry_name}</td>
                        <td className="col-num"><span className="points-value">{player.total}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
            <LeagueStats standings={standings} playerNames={playerNames} />
          </div>
        ) : (
          <div className="empty-state">
            <h2>Enter a league ID to get started</h2>
            <p>Find your league ID from the FPL website under Leagues & Cups</p>
          </div>
        )}
      </main>
      <footer className="app-footer">
        <p>FPL League Hub - Not affiliated with the Premier League</p>
      </footer>
    </div>
  );
}

// Render App component
ReactDOM.render(<App />, document.getElementById("root"));
