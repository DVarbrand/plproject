// App.js

function App() {
  const [standings, setStandings] = React.useState([]);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  // Fetch data from the API on component mount
  React.useEffect(() => {
    const apiUrl = 'https://fantasy.premierleague.com/api/leagues-classic/12176/standings/';
    const proxies = [
      (url) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
      (url) => 'https://corsproxy.io/?' + encodeURIComponent(url),
    ];

    async function fetchWithProxy(url, proxyIndex = 0) {
      if (proxyIndex >= proxies.length) {
        throw new Error('All proxies failed');
      }
      try {
        const response = await fetch(proxies[proxyIndex](url));
        if (!response.ok) throw new Error('Proxy returned ' + response.status);
        return await response.json();
      } catch (err) {
        console.warn('Proxy ' + proxyIndex + ' failed:', err.message);
        return fetchWithProxy(url, proxyIndex + 1);
      }
    }

    fetchWithProxy(apiUrl)
      .then(data => {
        setStandings(data.standings.results);
        setLoading(false);
      })
      .catch(error => {
        console.error('Error fetching data:', error);
        setError('Failed to load standings. Please try again later.');
        setLoading(false);
      });
  }, []);

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Premier League Fantasy Standings</h1>
      </header>
      <main className="app-content">
        {error ? (
          <p className="error-message">{error}</p>
        ) : loading ? (
          <p>Loading standings...</p>
        ) : (
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
        )}
      </main>
      <footer className="app-footer">
        <p>© 2024 Premier League</p>
      </footer>
    </div>
  );
}

// Render App component
ReactDOM.render(<App />, document.getElementById("root"));
