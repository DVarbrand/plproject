// App.js

// --- Utilities ---

function fplFetch(path) {
  return fetch('/api/fpl/' + path).then(function (r) {
    if (!r.ok) throw new Error('FPL API error: ' + r.status);
    return r.json();
  });
}

async function batchFetch(paths, concurrency, onProgress) {
  var results = [];
  for (var i = 0; i < paths.length; i += concurrency) {
    var batch = paths.slice(i, i + concurrency);
    var batchResults = await Promise.all(batch.map(function (p) {
      return fplFetch(p).catch(function (err) {
        console.warn('Fetch failed for ' + p + ':', err.message);
        return null;
      });
    }));
    results = results.concat(batchResults);
    if (onProgress) onProgress(Math.min(results.length, paths.length), paths.length);
    if (i + concurrency < paths.length) {
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  }
  return results;
}

var CHART_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9A6324', '#800000', '#aaffc3', '#808000',
  '#000075', '#a9a9a9', '#e6beff', '#fffac8', '#ffd8b1',
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
          title: { display: true, text: 'Points Trajectory', font: { size: 18 } },
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        },
        scales: {
          y: { title: { display: true, text: 'Total Points' } },
          x: { title: { display: true, text: 'Gameweek' } },
        },
      },
    });

    return function () { if (chartRef.current) chartRef.current.destroy(); };
  }, [props.managers]);

  return <canvas ref={canvasRef}></canvas>;
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
            {props.columns.map(function (col) { return <th key={col.key}>{col.label}</th>; })}
          </tr>
        </thead>
        <tbody>
          {props.data.map(function (row, i) {
            return (
              <tr key={row.entry}>
                <td>{i + 1}</td>
                <td>{row.player_name}</td>
                {props.columns.map(function (col) { return <td key={col.key}>{row[col.key]}</td>; })}
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

  var [managers, setManagers] = React.useState(null);
  var [captainStats, setCaptainStats] = React.useState(null);
  var [statsLoading, setStatsLoading] = React.useState(false);
  var [captainLoading, setCaptainLoading] = React.useState(false);
  var [statsProgress, setStatsProgress] = React.useState(0);
  var [captainProgress, setCaptainProgress] = React.useState(0);
  var [statsError, setStatsError] = React.useState(null);

  async function loadStats() {
    setStatsLoading(true);
    setStatsError(null);
    setStatsProgress(0);
    setCaptainStats(null);

    try {
      var managerIds = standings.map(function (s) { return s.entry; });
      var paths = managerIds.map(function (id) { return 'entry/' + id + '/history'; });

      var histories = await batchFetch(paths, 5, function (done, total) {
        setStatsProgress(Math.round((done / total) * 100));
      });

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

      setManagers(managerData);
      setStatsLoading(false);

      // Auto-load captain stats
      loadCaptainStats(managerData);
    } catch (err) {
      console.error('Stats error:', err);
      setStatsError('Failed to load league stats: ' + err.message);
      setStatsLoading(false);
    }
  }

  async function loadCaptainStats(managerData) {
    setCaptainLoading(true);
    setCaptainProgress(0);

    try {
      // Determine completed GWs from manager history data
      var completedEvents = managerData[0].history.map(function (h) { return h.event; });
      if (completedEvents.length === 0) {
        setCaptainLoading(false);
        return;
      }

      // Fetch live data for each completed GW
      var liveData = {};
      var livePaths = completedEvents.map(function (gw) { return 'event/' + gw + '/live'; });
      var liveResults = await batchFetch(livePaths, 5, function (done, total) {
        setCaptainProgress(Math.round((done / total) * 30));
      });
      completedEvents.forEach(function (gw, i) {
        if (!liveResults[i] || !liveResults[i].elements) return;
        var gwData = {};
        liveResults[i].elements.forEach(function (el) {
          gwData[el.id] = el.stats.total_points;
        });
        liveData[gw] = gwData;
      });

      // Fetch picks for each manager for each completed GW
      var managerIds = managerData.map(function (m) { return m.entry; });
      var allPickPaths = [];
      managerIds.forEach(function (id) {
        completedEvents.forEach(function (gw) {
          allPickPaths.push({ path: 'entry/' + id + '/event/' + gw + '/picks', managerId: id, gw: gw });
        });
      });

      var captainResults = {};
      managerIds.forEach(function (id) {
        captainResults[id] = { totalCaptainPoints: 0, captainChoices: {}, gwCount: 0 };
      });

      // Batch fetch picks
      for (var i = 0; i < allPickPaths.length; i += 5) {
        var batch = allPickPaths.slice(i, i + 5);
        var results = await Promise.all(batch.map(function (item) {
          return fplFetch(item.path).then(function (data) {
            return { data: data, managerId: item.managerId, gw: item.gw };
          }).catch(function () { return null; });
        }));

        results.forEach(function (result) {
          if (!result || !result.data || !result.data.picks) return;
          var captain = result.data.picks.find(function (p) { return p.is_captain; });
          if (captain && liveData[result.gw]) {
            var points = (liveData[result.gw][captain.element] || 0) * captain.multiplier;
            captainResults[result.managerId].totalCaptainPoints += points;
            captainResults[result.managerId].gwCount++;
            var playerId = captain.element;
            if (!captainResults[result.managerId].captainChoices[playerId]) {
              captainResults[result.managerId].captainChoices[playerId] = { count: 0, points: 0 };
            }
            captainResults[result.managerId].captainChoices[playerId].count++;
            captainResults[result.managerId].captainChoices[playerId].points += points;
          }
        });

        setCaptainProgress(30 + Math.round(((i + batch.length) / allPickPaths.length) * 70));
        if (i + 5 < allPickPaths.length) {
          await new Promise(function (r) { setTimeout(r, 200); });
        }
      }

      setCaptainStats(captainResults);
      setCaptainLoading(false);
    } catch (err) {
      console.error('Captain stats error:', err);
      setCaptainLoading(false);
    }
  }

  // Prepare sorted data for tables
  var benchSorted = managers ? managers.slice().sort(function (a, b) { return b.totalBenchPoints - a.totalBenchPoints; }) : [];
  var hitsSorted = managers ? managers.slice().sort(function (a, b) { return b.totalHitsCost - a.totalHitsCost; }) : [];

  var captainSorted = [];
  if (captainStats && managers) {
    captainSorted = managers.map(function (m) {
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
        mostCaptained: mostCaptained ? (playerNames[mostCaptained] || 'Unknown') + ' (' + maxCount + 'x)' : '-',
      };
    }).sort(function (a, b) { return b.totalCaptainPoints - a.totalCaptainPoints; });
  }

  if (!managers && !statsLoading) {
    return (
      <div className="stats-section">
        <button className="league-button stats-button" onClick={loadStats}>
          Load League Stats
        </button>
      </div>
    );
  }

  if (statsLoading) {
    return (
      <div className="stats-section">
        <h2>Loading League Stats...</h2>
        <ProgressBar percent={statsProgress} />
      </div>
    );
  }

  if (statsError) {
    return <p className="error-message">{statsError}</p>;
  }

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

      {captainLoading ? (
        <div className="stats-section">
          <h2>Loading Captain Stats...</h2>
          <ProgressBar percent={captainProgress} />
        </div>
      ) : captainStats ? (
        <StatsTable
          title="Captain Performance"
          data={captainSorted}
          columns={[
            { key: 'totalCaptainPoints', label: 'Captain Points' },
            { key: 'avgCaptainPoints', label: 'Avg/GW' },
            { key: 'mostCaptained', label: 'Most Captained' },
          ]}
        />
      ) : null}
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
        <h1>Premier League Fantasy Standings</h1>
      </header>
      <main className="app-content">
        <form className="league-form" onSubmit={handleSubmit}>
          <input
            type="text"
            className="league-input"
            placeholder="Enter league ID"
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
          <p>Loading standings...</p>
        ) : standings.length > 0 ? (
          <div>
            <table className="standings-table">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>Total Points</th>
                </tr>
              </thead>
              <tbody>
                {standings.map(function (player, index) {
                  return (
                    <tr key={player.entry}>
                      <td>{index + 1}</td>
                      <td>{player.player_name}</td>
                      <td>{player.entry_name}</td>
                      <td>{player.total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <LeagueStats standings={standings} playerNames={playerNames} />
          </div>
        ) : null}
      </main>
      <footer className="app-footer">
        <p>© 2024 Premier League</p>
      </footer>
    </div>
  );
}

// Render App component
ReactDOM.render(<App />, document.getElementById("root"));
