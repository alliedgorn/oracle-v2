import { useState, useEffect } from 'react';
import { getSettings, updateSettings, type Settings as SettingsType } from '../api/oracle';
import { useAuth } from '../contexts/AuthContext';
import styles from './Settings.module.css';

export function Settings() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authEnabled, setAuthEnabled] = useState(false);
  const [localBypass, setLocalBypass] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const [indexStatus, setIndexStatus] = useState<{ total_indexed: number; drift: boolean; indexed: Record<string, number> } | null>(null);

  // Google OAuth state
  const [googleStatus, setGoogleStatus] = useState<any>(null);
  const [googleAccess, setGoogleAccess] = useState<any[]>([]);
  const [newBeast, setNewBeast] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);

  const { checkAuth, isLocal } = useAuth();

  useEffect(() => {
    loadSettings();
    loadIndexStatus();
    loadGoogleStatus();
    loadGoogleAccess();

    // Check for OAuth callback query params
    const params = new URLSearchParams(window.location.search);
    if (params.get('google') === 'connected') {
      setMessage({ type: 'success', text: 'Google account connected successfully' });
      window.history.replaceState({}, '', '/settings');
    } else if (params.get('oauth_error')) {
      setMessage({ type: 'error', text: `Google OAuth error: ${params.get('oauth_error')}` });
      window.history.replaceState({}, '', '/settings');
    }
  }, []);

  async function loadIndexStatus() {
    try {
      const res = await fetch('/api/search/status');
      if (res.ok) setIndexStatus(await res.json());
    } catch {}
  }

  async function handleReindex() {
    if (!confirm('Rebuild the entire search index? This may take a moment.')) return;
    setReindexing(true);
    setMessage(null);
    try {
      const res = await fetch('/api/search/reindex', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const breakdown = data.indexed ? Object.entries(data.indexed).map(([t, c]) => `${t}: ${c}`).join(', ') : '';
        setMessage({ type: 'success', text: `Search index rebuilt: ${data.total} documents indexed (${breakdown})` });
        loadIndexStatus();
      } else {
        setMessage({ type: 'error', text: data.error || 'Reindex failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Reindex failed' });
    }
    setReindexing(false);
  }

  async function loadGoogleStatus() {
    try {
      const res = await fetch('/api/oauth/google/status');
      if (res.ok) setGoogleStatus(await res.json());
      else setGoogleStatus({ connected: false });
    } catch { setGoogleStatus({ connected: false }); }
  }

  async function loadGoogleAccess() {
    try {
      const res = await fetch('/api/google/access');
      if (res.ok) {
        const data = await res.json();
        setGoogleAccess(data.access || []);
      }
    } catch {}
  }

  async function handleGoogleDisconnect() {
    if (!confirm('Disconnect Google account? This will revoke access at Google.')) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/oauth/google/disconnect', { method: 'DELETE' });
      if (res.ok) {
        setGoogleStatus({ connected: false });
        setMessage({ type: 'success', text: 'Google account disconnected' });
      } else {
        setMessage({ type: 'error', text: 'Failed to disconnect' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to disconnect' });
    }
    setDisconnecting(false);
  }

  async function handleGrantAccess(e: React.FormEvent) {
    e.preventDefault();
    if (!newBeast.trim()) return;
    try {
      const res = await fetch('/api/google/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: newBeast.trim(), scopes: 'gmail.readonly' }),
      });
      if (res.ok) {
        setNewBeast('');
        loadGoogleAccess();
        setMessage({ type: 'success', text: `Access granted to ${newBeast.trim()}` });
      } else {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error || 'Failed to grant access' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to grant access' });
    }
  }

  async function handleRevokeAccess(beast: string) {
    if (!confirm(`Revoke Gmail access for ${beast}?`)) return;
    try {
      const res = await fetch(`/api/google/access/${beast}`, { method: 'DELETE' });
      if (res.ok) {
        loadGoogleAccess();
        setMessage({ type: 'success', text: `Access revoked for ${beast}` });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to revoke access' });
    }
  }

  async function loadSettings() {
    try {
      const data = await getSettings();
      setSettings(data);
      setAuthEnabled(data.authEnabled);
      setLocalBypass(data.localBypass);
    } catch (e) {
      setMessage({ type: 'error', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: 'Passwords do not match' });
      return;
    }

    if (newPassword && newPassword.length < 4) {
      setMessage({ type: 'error', text: 'Password must be at least 4 characters' });
      return;
    }

    setSaving(true);
    try {
      const result = await updateSettings({
        currentPassword: settings?.hasPassword ? currentPassword : undefined,
        newPassword: newPassword || undefined
      });

      if (result.error) {
        setMessage({ type: 'error', text: result.error });
      } else {
        setMessage({ type: 'success', text: 'Password updated successfully' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        await loadSettings();
        await checkAuth();
      }
    } catch (e) {
      setMessage({ type: 'error', text: 'Failed to update password' });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemovePassword() {
    if (!confirm('Are you sure you want to remove the password? This will disable authentication.')) {
      return;
    }

    setMessage(null);
    setSaving(true);

    try {
      const result = await updateSettings({
        currentPassword,
        removePassword: true
      });

      if (result.error) {
        setMessage({ type: 'error', text: result.error });
      } else {
        setMessage({ type: 'success', text: 'Password removed' });
        setCurrentPassword('');
        await loadSettings();
        await checkAuth();
      }
    } catch (e) {
      setMessage({ type: 'error', text: 'Failed to remove password' });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleAuth(enabled: boolean) {
    setMessage(null);
    setSaving(true);

    try {
      const result = await updateSettings({ authEnabled: enabled });

      if (result.error) {
        setMessage({ type: 'error', text: result.error });
      } else {
        setAuthEnabled(enabled);
        await checkAuth();
      }
    } catch (e) {
      setMessage({ type: 'error', text: 'Failed to update setting' });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleLocalBypass(bypass: boolean) {
    setMessage(null);
    setSaving(true);

    try {
      const result = await updateSettings({ localBypass: bypass });

      if (result.error) {
        setMessage({ type: 'error', text: result.error });
      } else {
        setLocalBypass(bypass);
        await checkAuth();
      }
    } catch (e) {
      setMessage({ type: 'error', text: 'Failed to update setting' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading settings...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Settings</h1>
      <p className={styles.subtitle}>Configure authentication and security options</p>

      {message && (
        <div className={`${styles.message} ${styles[message.type]}`}>
          {message.text}
        </div>
      )}

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Password</h2>
        <p className={styles.sectionDesc}>
          {settings?.hasPassword
            ? 'A password is currently set. You can change or remove it below.'
            : 'No password is set. Set a password to enable authentication.'}
        </p>

        <form onSubmit={handlePasswordSubmit} className={styles.form}>
          {settings?.hasPassword && (
            <div className={styles.field}>
              <label className={styles.label}>Current Password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                className={styles.input}
                placeholder="Enter current password"
              />
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>
              {settings?.hasPassword ? 'New Password' : 'Password'}
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className={styles.input}
              placeholder="Enter new password"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className={styles.input}
              placeholder="Confirm new password"
            />
          </div>

          <div className={styles.actions}>
            <button
              type="submit"
              disabled={saving || !newPassword}
              className={styles.button}
            >
              {saving ? 'Saving...' : settings?.hasPassword ? 'Change Password' : 'Set Password'}
            </button>

            {settings?.hasPassword && (
              <button
                type="button"
                onClick={handleRemovePassword}
                disabled={saving || (settings?.hasPassword && !currentPassword)}
                className={styles.dangerButton}
              >
                Remove Password
              </button>
            )}
          </div>
        </form>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Authentication</h2>

        <div className={styles.toggle}>
          <div className={styles.toggleInfo}>
            <span className={styles.toggleLabel}>Require Password</span>
            <span className={styles.toggleDesc}>
              When enabled, users must enter the password to access the dashboard
            </span>
          </div>
          <button
            onClick={() => handleToggleAuth(!authEnabled)}
            disabled={saving || !settings?.hasPassword}
            className={`${styles.toggleButton} ${authEnabled ? styles.active : ''}`}
          >
            {authEnabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>

        {!settings?.hasPassword && (
          <p className={styles.hint}>Set a password first to enable authentication</p>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Local Network Bypass</h2>

        <div className={styles.toggle}>
          <div className={styles.toggleInfo}>
            <span className={styles.toggleLabel}>Skip auth for local network</span>
            <span className={styles.toggleDesc}>
              When enabled, requests from local IP addresses (192.168.x.x, 10.x.x.x, 127.0.0.1) bypass authentication
            </span>
          </div>
          <button
            onClick={() => handleToggleLocalBypass(!localBypass)}
            disabled={saving}
            className={`${styles.toggleButton} ${localBypass ? styles.active : ''}`}
          >
            {localBypass ? 'Enabled' : 'Disabled'}
          </button>
        </div>

        <div className={styles.info}>
          <span className={styles.infoLabel}>Your connection:</span>
          <span className={`${styles.infoBadge} ${isLocal ? styles.local : styles.remote}`}>
            {isLocal ? 'Local Network' : 'Remote'}
          </span>
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Google</h2>
        <p className={styles.sectionDesc}>
          Connect your Google account to enable Gmail access for authorized Beasts.
        </p>

        {googleStatus && !googleStatus.connected && (
          <div className={styles.actions}>
            <a href="/api/oauth/google/authorize" className={styles.button} style={{ textDecoration: 'none' }}>
              Connect Google
            </a>
          </div>
        )}

        {googleStatus?.connected && (
          <>
            <div className={styles.info}>
              <span className={styles.infoLabel}>Connected:</span>
              <span className={`${styles.infoBadge} ${styles.local}`}>{googleStatus.email}</span>
              {googleStatus.tokenExpired && (
                <span className={`${styles.infoBadge} ${styles.remote}`}>Token expired</span>
              )}
            </div>

            <div style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 12 }}>Beast Access</h3>
              {googleAccess.length === 0 && (
                <p className={styles.hint}>No Beasts have Gmail access yet.</p>
              )}
              {googleAccess.map((a: any) => (
                <div key={a.beast} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: 14 }}>{a.beast}</span>
                  <span className={styles.infoBadge} style={{ background: 'var(--bg-secondary)' }}>{a.scopes}</span>
                  <button onClick={() => handleRevokeAccess(a.beast)} className={styles.dangerButton} style={{ padding: '6px 12px', fontSize: 12 }}>
                    Revoke
                  </button>
                </div>
              ))}
              <form onSubmit={handleGrantAccess} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <input
                  type="text"
                  value={newBeast}
                  onChange={e => setNewBeast(e.target.value)}
                  placeholder="Beast name"
                  className={styles.input}
                  style={{ flex: 1, padding: '8px 12px', fontSize: 13 }}
                />
                <button type="submit" className={styles.button} style={{ padding: '8px 16px', fontSize: 13 }}>
                  Grant Access
                </button>
              </form>
            </div>

            <div className={styles.actions} style={{ marginTop: 16 }}>
              <button
                onClick={handleGoogleDisconnect}
                disabled={disconnecting}
                className={styles.dangerButton}
              >
                {disconnecting ? 'Disconnecting...' : 'Disconnect Google'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Search Index</h2>
        <p className={styles.sectionDesc}>
          Global full-text search powered by SQLite FTS5. The index is updated automatically on content changes.
        </p>

        {indexStatus && (
          <>
            <div className={styles.info}>
              <span className={styles.infoLabel}>Total indexed:</span>
              <span className={styles.infoBadge}>{indexStatus.total_indexed.toLocaleString()}</span>
              {indexStatus.drift && (
                <span className={`${styles.infoBadge} ${styles.remote}`}>Drift detected</span>
              )}
              {!indexStatus.drift && (
                <span className={`${styles.infoBadge} ${styles.local}`}>In sync</span>
              )}
            </div>
            {indexStatus.indexed && (
              <div className={styles.info} style={{ flexWrap: 'wrap', gap: '8px' }}>
                {Object.entries(indexStatus.indexed).map(([type, count]) => (
                  <span key={type} className={styles.infoBadge}>{type}: {count}</span>
                ))}
              </div>
            )}
          </>
        )}

        <div className={styles.actions}>
          <button
            onClick={handleReindex}
            disabled={reindexing}
            className={styles.button}
          >
            {reindexing ? 'Rebuilding...' : 'Rebuild Search Index'}
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Guest Accounts</h2>
        <p className={styles.sectionDesc}>Guest management has moved to the dedicated <a href="/guests" style={{ color: 'var(--accent)' }}>Guests page</a>.</p>
      </div>
      <TokenManagement />
    </div>
  );
}

// ============================================================================
// API Token Management
// ============================================================================

interface Token {
  id: number;
  beast: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_by: string;
  active: boolean;
}

const BEASTS = ['karo', 'gnarl', 'zaghnal', 'bertus', 'leonard', 'mara', 'rax', 'pip', 'nyx', 'dex', 'flint', 'quill', 'snap', 'vigil', 'talon', 'sable'];

function TokenManagement() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedBeast, setSelectedBeast] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadTokens() {
    try {
      const res = await fetch('/api/auth/tokens');
      if (res.ok) {
        const data = await res.json();
        setTokens(data.tokens || []);
      }
    } catch {}
    setLoading(false);
  }

  useEffect(() => { loadTokens(); }, []);

  async function handleGenerate() {
    if (!selectedBeast || generating) return;
    setGenerating(true);
    setNewToken(null);
    try {
      const res = await fetch('/api/auth/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: selectedBeast }),
      });
      const data = await res.json();
      if (data.token) {
        setNewToken(data.token);
        setSelectedBeast('');
        loadTokens();
      }
    } catch {}
    setGenerating(false);
  }

  async function handleRevoke(id: number) {
    if (!confirm('Revoke this token? The beast will lose API access.')) return;
    await fetch(`/api/auth/tokens/${id}`, { method: 'DELETE' });
    loadTokens();
  }

  function copyToken() {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const activeTokens = tokens.filter(t => t.active);
  const revokedTokens = tokens.filter(t => !t.active);

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>API Tokens</h2>
      <p className={styles.sectionDescription}>Generate Bearer tokens for Beasts to authenticate with the API.</p>

      {/* Generate new token */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <select
          value={selectedBeast}
          onChange={e => setSelectedBeast(e.target.value)}
          className={styles.button}
          style={{ padding: '8px 12px', fontSize: 13, minWidth: 140 }}
        >
          <option value="" disabled>Select Beast</option>
          {BEASTS.map(b => (
            <option key={b} value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
          ))}
        </select>
        <button
          onClick={handleGenerate}
          disabled={!selectedBeast || generating}
          className={styles.button}
          style={{ padding: '8px 16px', fontSize: 13 }}
        >
          {generating ? 'Generating...' : 'Generate Token'}
        </button>
      </div>

      {/* Show newly generated token */}
      {newToken && (
        <div style={{
          background: 'rgba(63, 185, 80, 0.08)',
          border: '1px solid rgba(63, 185, 80, 0.3)',
          borderRadius: 8,
          padding: '12px 16px',
          marginBottom: 16,
          fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: '#3fb950' }}>Token generated — copy it now, it won't be shown again:</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{
              flex: 1,
              background: 'var(--bg-primary)',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all',
              color: 'var(--text-primary)',
            }}>
              {newToken}
            </code>
            <button onClick={copyToken} className={styles.button} style={{ padding: '8px 12px', fontSize: 12, flexShrink: 0 }}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Active tokens */}
      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</p>
      ) : activeTokens.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>No active tokens.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {activeTokens.map(t => (
            <div key={t.id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 14px',
              background: 'var(--bg-card)',
              borderRadius: 8,
              border: '1px solid var(--border)',
              fontSize: 13,
            }}>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', minWidth: 80 }}>
                {t.beast.charAt(0).toUpperCase() + t.beast.slice(1)}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                Created {new Date(t.created_at).toLocaleDateString()}
              </span>
              {t.last_used_at && (
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  Last used {new Date(t.last_used_at).toLocaleDateString()}
                </span>
              )}
              <span style={{ marginLeft: 'auto' }}>
                <button
                  onClick={() => handleRevoke(t.id)}
                  className={styles.dangerButton}
                  style={{ padding: '4px 10px', fontSize: 11 }}
                >
                  Revoke
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Revoked tokens (collapsed) */}
      {revokedTokens.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
            {revokedTokens.length} revoked token{revokedTokens.length !== 1 ? 's' : ''}
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {revokedTokens.map(t => (
              <div key={t.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '6px 14px',
                opacity: 0.5,
                fontSize: 12,
                color: 'var(--text-muted)',
              }}>
                <span style={{ fontWeight: 600, minWidth: 80 }}>
                  {t.beast.charAt(0).toUpperCase() + t.beast.slice(1)}
                </span>
                <span>Revoked {t.revoked_at ? new Date(t.revoked_at).toLocaleDateString() : ''}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
