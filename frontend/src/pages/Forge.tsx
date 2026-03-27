import { useState, useEffect, useCallback } from 'react';
import styles from './Forge.module.css';

const API_BASE = '/api';

interface RoutineLog {
  id: number;
  type: string;
  logged_at: string;
  data: string;
  source: string;
}

const TYPE_ICONS: Record<string, string> = {
  meal: '🍽️', workout: '💪', weight: '⚖️', note: '📝', photo: '📷',
};

export function Forge() {
  const [logs, setLogs] = useState<RoutineLog[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [weights, setWeights] = useState<any[]>([]);
  const [activeForm, setActiveForm] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');

  const loadData = useCallback(async () => {
    const params = new URLSearchParams({ limit: '50' });
    if (typeFilter) params.set('type', typeFilter);
    const [logsRes, statsRes, weightRes] = await Promise.all([
      fetch(`${API_BASE}/routine/logs?${params}`),
      fetch(`${API_BASE}/routine/stats`),
      fetch(`${API_BASE}/routine/weight`),
    ]);
    setLogs((await logsRes.json()).logs || []);
    setStats(await statsRes.json());
    setWeights((await weightRes.json()).weights || []);
  }, [typeFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  async function createLog(type: string) {
    setLoading(true);
    try {
      let data: any;
      switch (type) {
        case 'meal':
          data = { description: formData.description || '', calories: parseInt(formData.calories || '0') || undefined, protein: parseInt(formData.protein || '0') || undefined };
          break;
        case 'workout':
          data = { type: formData.workoutType || '', duration_min: parseInt(formData.duration || '0') || undefined, exercises: (formData.exercises || '').split('\n').filter(Boolean) };
          break;
        case 'weight':
          data = { value: parseFloat(formData.weightValue || '0'), unit: 'kg' };
          break;
        case 'note':
          data = { text: formData.noteText || '' };
          break;
        default: return;
      }
      await fetch(`${API_BASE}/routine/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, data }),
      });
      setFormData({});
      setActiveForm(null);
      loadData();
    } finally { setLoading(false); }
  }

  async function deleteLog(id: number) {
    await fetch(`${API_BASE}/routine/logs/${id}`, { method: 'DELETE' });
    loadData();
  }

  function parseData(log: RoutineLog) {
    try { return typeof log.data === 'string' ? JSON.parse(log.data) : log.data; } catch { return {}; }
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatLogContent(log: RoutineLog) {
    const d = parseData(log);
    switch (log.type) {
      case 'meal': return `${d.description || 'Meal'}${d.calories ? ` — ${d.calories} cal` : ''}${d.protein ? ` / ${d.protein}g protein` : ''}`;
      case 'workout': return `${d.type || 'Workout'}${d.duration_min ? ` (${d.duration_min} min)` : ''}${d.exercises?.length ? ` — ${d.exercises.join(', ')}` : ''}`;
      case 'weight': return `${d.value} ${d.unit || 'kg'}`;
      case 'note': return d.text || 'Note';
      case 'photo': return `${d.tag ? `[${d.tag}] ` : ''}${d.notes || 'Progress photo'}`;
      default: return JSON.stringify(d);
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Forge</h1>
        {stats && (
          <div className={styles.statsRow}>
            <span className={styles.stat}>{stats.total_logs} logs</span>
            <span className={styles.stat}>{stats.workouts_this_week} workouts this week</span>
            {stats.latest_weight && <span className={styles.stat}>Last: {stats.latest_weight.value} kg</span>}
          </div>
        )}
      </div>

      {/* Quick-add buttons */}
      <div className={styles.quickAdd}>
        {['meal', 'workout', 'weight', 'note'].map(type => (
          <button
            key={type}
            className={`${styles.quickAddBtn} ${activeForm === type ? styles.quickAddActive : ''}`}
            onClick={() => { setActiveForm(activeForm === type ? null : type); setFormData({}); }}
          >
            <span className={styles.quickAddIcon}>{TYPE_ICONS[type]}</span>
            <span>{type.charAt(0).toUpperCase() + type.slice(1)}</span>
          </button>
        ))}
      </div>

      {/* Inline form */}
      {activeForm && (
        <div className={styles.form}>
          {activeForm === 'meal' && (
            <>
              <input placeholder="What did you eat?" value={formData.description || ''} onChange={e => setFormData(p => ({ ...p, description: e.target.value }))} className={styles.formInput} autoFocus />
              <div className={styles.formRow}>
                <input placeholder="Calories" type="number" value={formData.calories || ''} onChange={e => setFormData(p => ({ ...p, calories: e.target.value }))} className={styles.formInput} />
                <input placeholder="Protein (g)" type="number" value={formData.protein || ''} onChange={e => setFormData(p => ({ ...p, protein: e.target.value }))} className={styles.formInput} />
              </div>
            </>
          )}
          {activeForm === 'workout' && (
            <>
              <input placeholder="Workout type (e.g. chest + triceps)" value={formData.workoutType || ''} onChange={e => setFormData(p => ({ ...p, workoutType: e.target.value }))} className={styles.formInput} autoFocus />
              <input placeholder="Duration (min)" type="number" value={formData.duration || ''} onChange={e => setFormData(p => ({ ...p, duration: e.target.value }))} className={styles.formInput} />
              <textarea placeholder="Exercises (one per line: bench 100kg x5)" value={formData.exercises || ''} onChange={e => setFormData(p => ({ ...p, exercises: e.target.value }))} className={styles.formTextarea} rows={3} />
            </>
          )}
          {activeForm === 'weight' && (
            <div className={styles.formRow}>
              <input placeholder="Weight (kg)" type="number" step="0.1" value={formData.weightValue || ''} onChange={e => setFormData(p => ({ ...p, weightValue: e.target.value }))} className={styles.formInput} autoFocus />
              <span className={styles.formUnit}>kg</span>
            </div>
          )}
          {activeForm === 'note' && (
            <textarea placeholder="What's on your mind?" value={formData.noteText || ''} onChange={e => setFormData(p => ({ ...p, noteText: e.target.value }))} className={styles.formTextarea} rows={3} autoFocus />
          )}
          <div className={styles.formActions}>
            <button className={styles.submitBtn} onClick={() => createLog(activeForm)} disabled={loading}>
              {loading ? 'Saving...' : 'Log it'}
            </button>
            <button className={styles.cancelBtn} onClick={() => { setActiveForm(null); setFormData({}); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Weight trend */}
      {weights.length > 0 && (
        <div className={styles.weightSection}>
          <h3>Weight Trend</h3>
          <div className={styles.weightChart}>
            {weights.slice(-14).map((w: any, i: number) => {
              const min = Math.min(...weights.slice(-14).map((x: any) => x.value));
              const max = Math.max(...weights.slice(-14).map((x: any) => x.value));
              const range = max - min || 1;
              const height = ((w.value - min) / range) * 80 + 20;
              return (
                <div key={w.id || i} className={styles.weightBar} title={`${w.value} kg — ${new Date(w.logged_at).toLocaleDateString()}`}>
                  <div className={styles.weightBarFill} style={{ height: `${height}%` }} />
                  <span className={styles.weightLabel}>{w.value}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter + History */}
      <div className={styles.historyHeader}>
        <h3>History</h3>
        <div className={styles.filters}>
          {['', 'meal', 'workout', 'weight', 'note', 'photo'].map(t => (
            <button key={t} className={`${styles.filterBtn} ${typeFilter === t ? styles.filterActive : ''}`} onClick={() => setTypeFilter(t)}>
              {t ? `${TYPE_ICONS[t]} ${t}` : 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.history}>
        {logs.length === 0 && <div className={styles.empty}>No logs yet. Start logging!</div>}
        {logs.map(log => (
          <div key={log.id} className={styles.logCard}>
            <span className={styles.logIcon}>{TYPE_ICONS[log.type] || '📄'}</span>
            <div className={styles.logContent}>
              <div className={styles.logText}>{formatLogContent(log)}</div>
              <div className={styles.logMeta}>{formatTime(log.logged_at)}{log.source !== 'manual' ? ` · ${log.source}` : ''}</div>
            </div>
            <button className={styles.deleteBtn} onClick={() => deleteLog(log.id)} title="Delete">×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
