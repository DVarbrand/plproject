// App.js

const proxies = [
  {
    url: (target) => 'https://api.allorigins.win/get?url=' + encodeURIComponent(target),
    parse: (json) => JSON.parse(json.contents),
  },
  {
    url: (target) => 'https://corsproxy.io/?' + encodeURIComponent(target),
    parse: (json) => json,
  },
];

async function fetchWithProxy(url, proxyIndex = 0) {
  if (proxyIndex >= proxies.length) {
    throw new Error('All proxies failed');
  }
  const proxy = proxies[proxyIndex];
  try {
    const response = await fetch(proxy.url(url));
    if (!response.ok) throw new Error('Proxy returned ' + response.status);
    const json = await response.json();
    return proxy.parse(json);
  } catch (err) {
    console.warn('Proxy ' + proxyIndex + ' failed:', err.message);
    return fetchWithProxy(url, proxyIndex + 1);
  }
}

function App() {
  const [leagueId, setLeagueId] = React.useState('');
  const [standings, setStandings] = React.useState([]);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    if (!leagueId.trim()) return;

    setLoading(true);
    setError(null);
    setStandings([]);

    const apiUrl = 'https://fantasy.premierleague.com/api/leagues-classic/' + leagueId.trim() + '/standings/';
    fetchWithProxy(apiUrl)
      .then(data => {
        setStandings(data.standings.results);
        setLoading(false);
      })
      .catch(error => {
        console.error('Error fetching data:', error);
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
            onChange={(e) => setLeagueId(e.target.value)}
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
              {standings.map((player, index) => (
                <tr key={player.entry}>
                  <td>{index + 1}</td>
                  <td>{player.player_name}</td>
                  <td>{player.entry_name}</td>
                  <td>{player.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
