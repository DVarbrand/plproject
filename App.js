// App.js

function App() {
  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Hello Premier League World!</h1>
      </header>
      <main className="app-content">
        <p>Welcome to the Premier League-themed "Hello World" web app!</p>
      </main>
      <footer className="app-footer">
        <p>© 2024 Premier League</p>
      </footer>
    </div>
  );
}

// Render App component
ReactDOM.render(<App />, document.getElementById("root"));
