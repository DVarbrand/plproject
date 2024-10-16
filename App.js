import React, { useEffect, useState } from 'react';
import './App.css';

function App() {
  const [standings, setStandings] = useState([]);

  // Fetch data from the API on component mount
  useEffect(() => {
    fetch('https://fantasy.premierleague.com/api/leagues-classic/217776/standings/')
      .then(response => response.json())
      .then(data => {
        setStandings(data.standings.results); // Store standings in state
      })
      .catch(error => console.error('Error fetching data:', error));
  }, []);

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Premier League Fantasy Standings</h1>
      </header>
      <main className="app-content">
        {standings.length > 0 ? (
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
        ) : (
          <p>Loading standings...</p>
        )}
      </main>
      <footer className="app-footer">
        <p>© 2024 Premier League</p>
      </footer>
    </div>
  );
}

export default App;
