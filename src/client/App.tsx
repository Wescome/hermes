import AdminPage from './pages/AdminPage';
import './App.css';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <svg className="header-logo" viewBox="0 0 32 32" fill="none" aria-hidden>
          <circle cx="16" cy="16" r="16" fill="#7c3aed" opacity=".2" />
          <path d="M8 22V10l8 6 8-6v12" stroke="#7c3aed" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h1>Hermes Admin</h1>
      </header>
      <main className="app-main">
        <AdminPage />
      </main>
    </div>
  );
}
