import "./styles/tokens.css";

export default function App() {
  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 21V11.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M12 13.5C12 9 9 6.5 4.5 6.5c0 4.5 3 7 7.5 7z" fill="currentColor" />
            <path d="M12 11c0-4 2.6-7.5 7.5-7.5 0 4.5-3 7.5-7.5 7.5z" fill="currentColor" opacity=".7" />
            <circle cx="12" cy="20" r="2.3" fill="currentColor" />
          </svg>
          <b>gitsprout</b>
        </div>
      </header>
      <main />
    </div>
  );
}
