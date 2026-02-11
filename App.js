// App.js

// --- Utilities ---

function fplFetch(path) {
  return fetch('/api/fpl/' + path).then(function (r) {
    if (!r.ok) throw new Error('FPL API error: ' + r.status);
    return r.json();
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
        await new Promise(function (r) { setTimeout(r, 200); });
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
  '#00FF85', '#04F5FF', '#E90052', '#f58231', '#3D195B',
  '#ff3a7f', '#bfef45', '#42d4f4', '#fabed4', '#469990',
  '#dcbeff', '#9A6324', '#e6194b', '#aaffc3', '#808000',
  '#4363d8', '#a9a9a9', '#e6beff', '#fffac8', '#ffd8b1',
];

// --- Components ---

function PointsChart(props) {
  var canvasRef = React.useRef(null);
  var chartRef = React.useRef(null);

  React.useEffect(function () {
    if (!props.managers || !canvasRef.current) return;
    var managersWithHistory = props.managers.filter(function (m) { return m.history.length > 0; });
    if (managersWithHistory.length === 0) return;
    if (chartRef.current) chartRef.current.destroy();

    var labels = managersWithHistory[0].history.map(function (h) { return 'GW' + h.event; });
    var datasets = managersWithHistory.map(function (m, i) {
      return {
        label: m.player_name,
        data: m.history.map(function (h) { return h.total_points; }),
        borderColor: CHART_COLORS[i % CHART_COLORS.length],
        backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
        fill: false,
        tension: 0.2,
        pointRadius: 2,
      };
    });

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        plugins: {
          title: { display: true, text: 'Points Trajectory', font: { size: 16, weight: 600 }, color: '#f0f0f0' },
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 }, color: '#999' } },
        },
        scales: {
          y: { title: { display: true, text: 'Total Points', color: '#999' }, ticks: { color: '#999' }, grid: { color: 'rgba(255,255,255,0.06)' } },
          x: { title: { display: true, text: 'Gameweek', color: '#999' }, ticks: { color: '#999' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        },
      },
    });

    return function () { if (chartRef.current) chartRef.current.destroy(); };
  }, [props.managers]);

  return <canvas ref={canvasRef}></canvas>;
}

function RankBadge(props) {
  var rank = props.rank;
  var cls = 'rank-badge';
  if (rank <= 3) cls += ' rank-' + rank;
  return <span className={cls}>{rank}</span>;
}

function StatsTable(props) {
  return (
    <div className="stats-section">
      <h2>{props.title}</h2>
      <table className="standings-table stats-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Manager</th>
            {props.columns.map(function (col) {
              var isText = col.key === 'mostCaptained' || col.key === 'entry_name';
              return <th key={col.key} className={isText ? '' : 'col-num'}>{col.label}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {props.data.map(function (row, i) {
            return (
              <tr key={row.entry}>
                <td><RankBadge rank={i + 1} /></td>
                <td>{row.player_name}</td>
                {props.columns.map(function (col) {
                  var isText = col.key === 'mostCaptained' || col.key === 'entry_name';
                  return <td key={col.key} className={isText ? '' : 'col-num'}>{row[col.key]}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
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

  var [allData, setAllData] = React.useState(null);
  var [loading, setLoading] = React.useState(false);
  var [progress, setProgress] = React.useState(0);
  var [progressLabel, setProgressLabel] = React.useState('');
  var [statsError, setStatsError] = React.useState(null);

  async function loadAllStats() {
    setLoading(true);
    setStatsError(null);
    setProgress(0);
    setAllData(null);

    try {
      var managerIds = standings.map(function (s) { return s.entry; });

      // Phase 1: Fetch player names + histories in parallel (0-40%)
      setProgressLabel('Fetching manager histories...');
      var historyPaths = managerIds.map(function (id) { return 'entry/' + id + '/history'; });

      var bootstrapPromise = fplFetch('bootstrap-static').catch(function (err) {
        console.warn('Bootstrap fetch failed:', err.message);
        return null;
      });

      var histories = await batchFetch(historyPaths, 3, function (done, total) {
        setProgress(Math.round((done / total) * 40));
      }, 3);

      var bootstrapData = await bootstrapPromise;

      // Build player names map
      var resolvedNames = {};
      if (Object.keys(playerNames).length > 0) {
        resolvedNames = playerNames;
      } else if (bootstrapData && bootstrapData.elements) {
        bootstrapData.elements.forEach(function (p) { resolvedNames[p.id] = p.web_name; });
      }

      // If bootstrap failed, retry once more
      if (Object.keys(resolvedNames).length === 0) {
        try {
          var retryBootstrap = await fplFetch('bootstrap-static');
          if (retryBootstrap && retryBootstrap.elements) {
            retryBootstrap.elements.forEach(function (p) { resolvedNames[p.id] = p.web_name; });
          }
        } catch (err) {
          console.warn('Bootstrap retry also failed:', err.message);
        }
      }

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

      // Phase 2: Fetch live GW data (40-60%)
      var firstWithHistory = managerData.find(function (m) { return m.history.length > 0; });
      var completedEvents = firstWithHistory ? firstWithHistory.history.map(function (h) { return h.event; }) : [];

      var captainResults = {};
      managerIds.forEach(function (id) {
        captainResults[id] = { totalCaptainPoints: 0, captainChoices: {}, gwCount: 0 };
      });

      if (completedEvents.length > 0) {
        setProgressLabel('Fetching gameweek live data...');
        var livePaths = completedEvents.map(function (gw) { return 'event/' + gw + '/live'; });
        var liveResults = await batchFetch(livePaths, 5, function (done, total) {
          setProgress(40 + Math.round((done / total) * 20));
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

        // Phase 3: Fetch all picks (60-100%)
        setProgressLabel('Fetching captain picks...');
        var allPickPaths = [];
        var allPickMeta = [];
        managerIds.forEach(function (id) {
          completedEvents.forEach(function (gw) {
            allPickPaths.push('entry/' + id + '/event/' + gw + '/picks');
            allPickMeta.push({ managerId: id, gw: gw });
          });
        });

        var pickResults = await batchFetch(allPickPaths, 5, function (done, total) {
          setProgress(60 + Math.round((done / total) * 40));
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
        });
      }

      setProgress(100);
      setProgressLabel('');

      // Set ALL data at once - nothing renders until this point
      setAllData({
        managers: managerData,
        captainStats: captainResults,
        playerNames: resolvedNames,
      });
      setLoading(false);
    } catch (err) {
      console.error('Stats error:', err);
      setStatsError('Failed to load league stats: ' + err.message);
      setLoading(false);
    }
  }

  if (!allData && !loading) {
    return (
      <div className="stats-section" style={{ textAlign: 'center' }}>
        <button className="league-button stats-button" onClick={loadAllStats}>
          Load Detailed Stats
        </button>
      </div>
    );
  }

  if (loading) {
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

  // All data is ready - compute derived tables
  var managers = allData.managers;
  var captainStats = allData.captainStats;
  var names = allData.playerNames;

  var benchSorted = managers.slice().sort(function (a, b) { return b.totalBenchPoints - a.totalBenchPoints; });
  var hitsSorted = managers.slice().sort(function (a, b) { return b.totalHitsCost - a.totalHitsCost; });

  var captainSorted = managers.map(function (m) {
    var cs = captainStats[m.entry];
    var mostCaptained = null;
    var maxCount = 0;
    Object.keys(cs.captainChoices).forEach(function (pid) {
      if (cs.captainChoices[pid].count > maxCount) {
        maxCount = cs.captainChoices[pid].count;
        mostCaptained = pid;
      }
    });
    return {
      entry: m.entry,
      player_name: m.player_name,
      totalCaptainPoints: cs.totalCaptainPoints,
      avgCaptainPoints: cs.gwCount > 0 ? (cs.totalCaptainPoints / cs.gwCount).toFixed(1) : '0',
      mostCaptained: mostCaptained ? (names[mostCaptained] || 'Unknown') + ' (' + maxCount + 'x)' : '-',
    };
  }).sort(function (a, b) { return b.totalCaptainPoints - a.totalCaptainPoints; });

  return (
    <div className="stats-dashboard">
      <div className="chart-container">
        <PointsChart managers={managers} />
      </div>

      <div className="stats-grid">
        <StatsTable
          title="Bench Points Wasted"
          data={benchSorted}
          columns={[
            { key: 'totalBenchPoints', label: 'Bench Points' },
            { key: 'total', label: 'Total Points' },
          ]}
        />

        <StatsTable
          title="Transfer Hits & Activity"
          data={hitsSorted}
          columns={[
            { key: 'totalTransfers', label: 'Transfers' },
            { key: 'totalHitsCost', label: 'Hits Cost' },
          ]}
        />
      </div>

      <StatsTable
        title="Captain Performance"
        data={captainSorted}
        columns={[
          { key: 'totalCaptainPoints', label: 'Captain Points' },
          { key: 'avgCaptainPoints', label: 'Avg/GW' },
          { key: 'mostCaptained', label: 'Most Captained' },
        ]}
      />
    </div>
  );
}

function App() {
  var [leagueId, setLeagueId] = React.useState('');
  var [standings, setStandings] = React.useState([]);
  var [playerNames, setPlayerNames] = React.useState({});
  var [error, setError] = React.useState(null);
  var [loading, setLoading] = React.useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    if (!leagueId.trim()) return;

    setLoading(true);
    setError(null);
    setStandings([]);

    fetch('/api/standings/' + leagueId.trim())
      .then(function (r) {
        if (!r.ok) throw new Error('API request failed with status ' + r.status);
        return r.json();
      })
      .then(function (data) {
        setStandings(data.standings.results);
        setLoading(false);

        // Load player names in background (needed for stats, not for standings)
        fplFetch('bootstrap-static')
          .then(function (bootstrap) {
            var players = {};
            bootstrap.elements.forEach(function (p) { players[p.id] = p.web_name; });
            setPlayerNames(players);
          })
          .catch(function (err) { console.warn('Bootstrap fetch failed:', err.message); });
      })
      .catch(function (err) {
        console.error('Error fetching data:', err);
        setError('Failed to load standings. Check the league ID and try again.');
        setLoading(false);
      });
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>FPL League Hub</h1>
        <div className="subtitle">Fantasy Premier League Stats & Insights</div>
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
        </form>
        {error ? (
          <p className="error-message">{error}</p>
        ) : loading ? (
          <p className="loading-text">Loading standings...</p>
        ) : standings.length > 0 ? (
          <div>
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
