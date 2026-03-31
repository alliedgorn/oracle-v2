import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import styles from './Login.module.css';

type LoginTab = 'owner' | 'guest';

export function Login() {
  const [tab, setTab] = useState<LoginTab>('owner');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim()) return;
    if (tab === 'guest' && !username.trim()) return;

    setLoading(true);
    setError('');

    try {
      const result = tab === 'guest'
        ? await login(password, username)
        : await login(password);
      if (result.success) {
        navigate(tab === 'guest' ? '/welcome' : '/');
      } else {
        setError(result.error || 'Login failed');
      }
    } catch (e) {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  function switchTab(newTab: LoginTab) {
    setTab(newTab);
    setError('');
    setPassword('');
    setUsername('');
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.logo}>The Den</div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'owner' ? styles.tabActive : ''}`}
            onClick={() => switchTab('owner')}
          >
            Owner
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'guest' ? styles.tabActive : ''}`}
            onClick={() => switchTab('guest')}
          >
            Guest
          </button>
        </div>

        <p className={styles.subtitle}>
          {tab === 'owner'
            ? 'Enter your password to access the dashboard'
            : 'Welcome to The Den'}
        </p>

        <form onSubmit={handleSubmit} className={styles.form}>
          {error && (
            <div className={styles.error}>{error}</div>
          )}

          {tab === 'guest' && (
            <div className={styles.field}>
              <label className={styles.label}>Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Enter username"
                className={styles.input}
                autoComplete="username"
              />
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              className={styles.input}
              autoComplete={tab === 'guest' ? 'current-password' : undefined}
            />
          </div>

          <button
            type="submit"
            disabled={loading || !password.trim() || (tab === 'guest' && !username.trim())}
            className={styles.button}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          {tab === 'guest' && (
            <p className={styles.guestNote}>
              Guest accounts are created by the Den owner.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
