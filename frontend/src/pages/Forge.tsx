import React, { useState, useEffect, useCallback } from 'react';
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
  meal: '🍽️', workout: '💪', weight: '⚖️', note: '📝', photo: '📷', bodyfat: '📊',
};

function parseExerciseName(raw: string): { name: string; equipment: string } {
  // Input: "1. Lat Pulldowns with Wide Overhand Grip · Machine · 8 reps"
  const cleaned = raw.replace(/^\d+\.\s*/, '');
  const parts = cleaned.split(' · ');
  return { name: parts[0] || cleaned, equipment: parts[1] || '' };
}

function formatSets(sets: any[]): string {
  if (!sets?.length) return '';
  const unit = sets[0]?.unit || 'KG';
  // Group identical sets: "3×8 @ 220 LB"
  const groups: string[] = [];
  let i = 0;
  while (i < sets.length) {
    let count = 1;
    while (i + count < sets.length && sets[i + count].weight === sets[i].weight && sets[i + count].reps === sets[i].reps) count++;
    groups.push(`${count > 1 ? count + '\u00d7' : ''}${sets[i].reps} @ ${sets[i].weight} ${unit.toLowerCase()}`);
    i += count;
  }
  return groups.join(', ');
}

function WorkoutCard({ data }: { data: any }) {
  const [expanded, setExpanded] = useState(false);
  const name = (data.workout_name || data.type || 'Workout').replace(/ · Standalone workout$/, '').replace(/^Standalone workout · /, '');
  const dur = data.duration_min ? `${data.duration_min} min` : (data.duration || '');
  const exercises: any[] = data.exercises || [];
  const showCount = 3;
  const visible = expanded ? exercises : exercises.slice(0, showCount);
  const hasMore = exercises.length > showCount;

  return (
    <div className={styles.workoutCard}>
      <div className={styles.workoutHeader}>
        <span className={styles.workoutName}>{name}</span>
        {dur && <span className={styles.workoutDur}>{dur}</span>}
      </div>
      <div className={styles.workoutExercises}>
        {visible.map((ex: any, i: number) => {
          const { name: exName, equipment } = parseExerciseName(typeof ex === 'string' ? ex : ex.name || '');
          const setsStr = ex.sets ? formatSets(ex.sets) : '';
          return (
            <div key={i} className={styles.exerciseRow}>
              <span className={styles.exerciseNum}>{i + 1}</span>
              <div className={styles.exerciseInfo}>
                <span className={styles.exerciseName}>{exName}</span>
                <span className={styles.exerciseDetail}>
                  {equipment && <span className={styles.exerciseEquip}>{equipment}</span>}
                  {setsStr && <span className={styles.exerciseSets}>{setsStr}</span>}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {hasMore && (
        <button className={styles.workoutToggle} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : `+${exercises.length - showCount} more`}
        </button>
      )}
    </div>
  );
}

// Line chart colors for workout trends (5-color palette for dark bg)
const TREND_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#a78bfa'];

// Workout trends line chart component
function WorkoutTrendsChart({ range }: { range: string }) {
  const [trends, setTrends] = useState<any>(null);
  const [metric, setMetric] = useState<'maxWeight' | 'totalVolume' | 'totalReps'>('maxWeight');
  const [selectedExercises, setSelectedExercises] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${API_BASE}/routine/workout-trends?range=${range}`)
      .then(r => r.json())
      .then(data => {
        setTrends(data);
        if (data.exercises?.length && selectedExercises.length === 0) {
          setSelectedExercises(data.exercises.slice(0, 5));
        }
      })
      .catch(() => {});
  }, [range]);

  if (!trends || !trends.exercises?.length) return null;

  const exercises = selectedExercises.filter(e => trends.trends[e]?.length > 0);
  if (exercises.length === 0) return null;

  // Collect all data points for axis scaling
  const allPoints: { date: number; value: number }[] = [];
  for (const ex of exercises) {
    for (const pt of trends.trends[ex] || []) {
      allPoints.push({ date: new Date(pt.date).getTime(), value: pt[metric] });
    }
  }
  if (allPoints.length === 0) return null;

  const minDate = Math.min(...allPoints.map(p => p.date));
  const maxDate = Math.max(...allPoints.map(p => p.date));
  const minVal = Math.min(...allPoints.map(p => p.value));
  const maxVal = Math.max(...allPoints.map(p => p.value));
  const valRange = maxVal - minVal || 1;
  const dateRange = maxDate - minDate || 1;

  const W = 600, H = 180, PAD = 30;

  function toX(date: number) { return PAD + ((date - minDate) / dateRange) * (W - PAD * 2); }
  function toY(val: number) { return H - PAD - ((val - minVal + valRange * 0.1) / (valRange * 1.2)) * (H - PAD * 2); }

  const metricLabels: Record<string, string> = { maxWeight: 'Max Weight', totalVolume: 'Volume', totalReps: 'Total Reps' };

  return (
    <div className={styles.weightSection}>
      <div className={styles.historyHeader}>
        <h3>Workout Trends</h3>
        <div className={styles.filters}>
          {(['maxWeight', 'totalVolume', 'totalReps'] as const).map(m => (
            <button key={m} className={`${styles.filterBtn} ${metric === m ? styles.filterActive : ''}`}
              onClick={() => setMetric(m)}>{metricLabels[m]}</button>
          ))}
        </div>
      </div>
      <div className={styles.trendChart}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map(frac => {
            const y = toY(minVal + valRange * frac);
            const label = Math.round(minVal + valRange * frac);
            return (
              <g key={frac}>
                <line x1={PAD} y1={y} x2={W - PAD} y2={y} stroke="var(--border)" strokeWidth={0.5} />
                <text x={PAD - 4} y={y + 3} fill="var(--text-muted)" fontSize={9} textAnchor="end">{label}</text>
              </g>
            );
          })}
          {/* Lines + dots for each exercise */}
          {exercises.map((exName, ei) => {
            const pts = (trends.trends[exName] || []).map((pt: any) => ({
              x: toX(new Date(pt.date).getTime()),
              y: toY(pt[metric]),
              raw: pt,
            }));
            if (pts.length === 0) return null;
            const pathD = pts.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
            return (
              <g key={exName}>
                <path d={pathD} fill="none" stroke={TREND_COLORS[ei % TREND_COLORS.length]} strokeWidth={2} />
                {pts.map((p: any, i: number) => (
                  <circle key={i} cx={p.x} cy={p.y} r={3}
                    fill={TREND_COLORS[ei % TREND_COLORS.length]}
                    style={{ cursor: 'pointer' }}>
                    <title>{`${exName} · ${new Date(p.raw.date).toLocaleDateString()} · ${metric === 'maxWeight' ? p.raw.maxWeight + ' ' + p.raw.unit : metric === 'totalVolume' ? Math.round(p.raw.totalVolume) : p.raw.totalReps}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      {/* Legend */}
      <div className={styles.trendLegend}>
        {exercises.map((name, i) => (
          <span key={name} className={styles.trendLegendItem}>
            <span className={styles.trendDot} style={{ background: TREND_COLORS[i % TREND_COLORS.length] }} />
            {name}
          </span>
        ))}
      </div>
      {/* Exercise selector */}
      {trends.allExercises?.length > 5 && (
        <details className={styles.exerciseSelector}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12 }}>
            Select exercises ({selectedExercises.length}/{trends.allExercises.length})
          </summary>
          <div className={styles.exerciseChips}>
            {trends.allExercises.map((ex: any) => (
              <button key={ex.name}
                className={`${styles.filterBtn} ${selectedExercises.includes(ex.name) ? styles.filterActive : ''}`}
                onClick={() => {
                  setSelectedExercises(prev =>
                    prev.includes(ex.name)
                      ? prev.filter(e => e !== ex.name)
                      : prev.length >= 5 ? prev : [...prev, ex.name]
                  );
                }}
                style={{ fontSize: 11 }}>
                {ex.name} ({ex.count})
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function Forge() {
  const [logs, setLogs] = useState<RoutineLog[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [weights, setWeights] = useState<any[]>([]);
  const [weightGrouping, setWeightGrouping] = useState<string>('daily');
  const [activeForm, setActiveForm] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [weightRange, setWeightRange] = useState('year');
  const PAGE_SIZE = 30;

  const loadData = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (typeFilter) params.set('type', typeFilter);
    const [logsRes, statsRes, weightRes] = await Promise.all([
      fetch(`${API_BASE}/routine/logs?${params}`),
      fetch(`${API_BASE}/routine/stats`),
      fetch(`${API_BASE}/routine/weight?range=${weightRange}`),
    ]);
    const logsData = await logsRes.json();
    const newLogs = logsData.logs || [];
    setLogs(newLogs);
    setHasMore(newLogs.length >= PAGE_SIZE);
    setStats(await statsRes.json());
    const weightData = await weightRes.json();
    setWeights(weightData.weights || []);
    setWeightGrouping(weightData.grouping || 'daily');
  }, [typeFilter, weightRange]);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(logs.length) });
    if (typeFilter) params.set('type', typeFilter);
    const res = await fetch(`${API_BASE}/routine/logs?${params}`);
    const data = await res.json();
    const moreLogs = data.logs || [];
    setLogs(prev => [...prev, ...moreLogs]);
    setHasMore(moreLogs.length >= PAGE_SIZE);
    setLoadingMore(false);
  }

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

  function formatLogContent(log: RoutineLog): React.ReactNode {
    const d = parseData(log);
    switch (log.type) {
      case 'meal': return `${d.description || 'Meal'}${d.calories ? ` — ${d.calories} cal` : ''}${d.protein ? ` / ${d.protein}g protein` : ''}`;
      case 'workout': return <WorkoutCard data={d} />;
      case 'weight': return `${d.value} ${d.unit || 'kg'}`;
      case 'bodyfat': return `${d.value}% body fat`;
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
        <label className={styles.quickAddBtn} style={{ cursor: 'pointer' }}>
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setLoading(true);
              try {
                const fd = new FormData();
                fd.append('file', file);
                if (formData.photoTag) fd.append('tag', formData.photoTag);
                if (formData.photoNotes) fd.append('notes', formData.photoNotes);
                await fetch(`${API_BASE}/routine/photo/upload`, { method: 'POST', body: fd });
                loadData();
              } catch { /* ignore */ }
              setLoading(false);
              e.target.value = '';
            }}
            disabled={loading}
          />
          <span className={styles.quickAddIcon}>{TYPE_ICONS.photo}</span>
          <span>{loading ? 'Uploading...' : 'Photo'}</span>
        </label>
        <label className={styles.quickAddBtn} style={{ cursor: 'pointer' }}>
          <input
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setImporting(true);
              setImportResult(null);
              setImportPreview(null);
              setImportFile(file);
              try {
                const formData = new FormData();
                formData.append('file', file);
                const res = await fetch(`${API_BASE}/routine/import/alpha-progression?preview=true`, { method: 'POST', body: formData });
                const preview = await res.json();
                preview._importType = 'workouts';
                setImportPreview(preview);
              } catch { setImportPreview({ error: 'Failed to parse CSV' }); }
              setImporting(false);
              e.target.value = '';
            }}
            disabled={importing}
          />
          <span className={styles.quickAddIcon}>💪</span>
          <span>{importing ? 'Parsing...' : 'Import Workouts'}</span>
        </label>
        <label className={styles.quickAddBtn} style={{ cursor: 'pointer' }}>
          <input
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setImporting(true);
              setImportResult(null);
              setImportPreview(null);
              setImportFile(file);
              try {
                const formData = new FormData();
                formData.append('file', file);
                const res = await fetch(`${API_BASE}/routine/import/alpha-measurements?preview=true`, { method: 'POST', body: formData });
                const preview = await res.json();
                preview._importType = 'measurements';
                setImportPreview(preview);
              } catch { setImportPreview({ error: 'Failed to parse CSV' }); }
              setImporting(false);
              e.target.value = '';
            }}
            disabled={importing}
          />
          <span className={styles.quickAddIcon}>📊</span>
          <span>{importing ? 'Parsing...' : 'Import Measurements'}</span>
        </label>
      </div>

      {importPreview && !importResult && (
        <div className={styles.form} style={{ marginBottom: 16 }}>
          {importPreview.error ? (
            <p style={{ color: 'var(--danger, red)' }}>{importPreview.error}</p>
          ) : (
            <>
              {importPreview._importType === 'measurements' ? (
                <p>Found <strong>{importPreview.new_entries} new entries</strong> ({importPreview.bodyfat} body fat, {importPreview.weight} weight)
                {importPreview.duplicates > 0 && <>, {importPreview.duplicates} duplicates skipped</>}
                {importPreview.date_range && <> from {importPreview.date_range.from} to {importPreview.date_range.to}</>}</p>
              ) : (
                <p>Found <strong>{importPreview.new_sessions || importPreview.sessions} sessions</strong> ({importPreview.total_exercises} exercises, {importPreview.total_sets} sets)
                {importPreview.duplicates > 0 && <>, {importPreview.duplicates} duplicates skipped</>}
                {importPreview.date_range && <> from {importPreview.date_range.from} to {importPreview.date_range.to}</>}</p>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={styles.formButton} disabled={importing} onClick={async () => {
                  if (!importFile) return;
                  setImporting(true);
                  const endpoint = importPreview._importType === 'measurements' ? 'alpha-measurements' : 'alpha-progression';
                  try {
                    const formData = new FormData();
                    formData.append('file', importFile);
                    const res = await fetch(`${API_BASE}/routine/import/${endpoint}`, { method: 'POST', body: formData });
                    const data = await res.json();
                    setImportResult(data);
                    setImportPreview(null);
                    setImportFile(null);
                    if (data.imported) loadData();
                  } catch { setImportResult({ error: 'Import failed' }); }
                  setImporting(false);
                }}>{importing ? 'Importing...' : 'Import'}</button>
                <button className={styles.formButton} style={{ opacity: 0.6 }} onClick={() => { setImportPreview(null); setImportFile(null); }}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {importResult && (
        <div className={styles.form} style={{ marginBottom: 16 }}>
          {importResult.error ? (
            <p style={{ color: 'var(--danger, red)' }}>{importResult.error}</p>
          ) : (
            <p style={{ color: 'var(--success, green)' }}>
              Imported {importResult.imported} sessions ({importResult.total_exercises} exercises, {importResult.total_sets} sets)
              {importResult.date_range && ` from ${importResult.date_range.from} to ${importResult.date_range.to}`}
            </p>
          )}
          <button className={styles.formButton} onClick={() => setImportResult(null)}>Dismiss</button>
        </div>
      )}

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
          <div className={styles.historyHeader}>
            <h3>Weight Trend</h3>
            <div className={styles.filters}>
              {[
                { id: 'week', label: '1W' },
                { id: 'month', label: '1M' },
                { id: 'year', label: '1Y' },
                { id: '3y', label: '3Y' },
                { id: '10y', label: '10Y' },
                { id: 'all', label: 'All' },
              ].map(r => (
                <button
                  key={r.id}
                  className={`${styles.filterBtn} ${weightRange === r.id ? styles.filterActive : ''}`}
                  onClick={() => setWeightRange(r.id)}
                >{r.label}</button>
              ))}
            </div>
          </div>
          <div className={styles.weightChart}>
            {(() => {
              const allMin = Math.min(...weights.map((x: any) => x.min_value ?? x.value));
              const allMax = Math.max(...weights.map((x: any) => x.max_value ?? x.value));
              const range = allMax - allMin || 1;
              return weights.map((w: any, i: number) => {
                const val = w.value;
                const barHeight = ((val - allMin) / range) * 80 + 20;
                const isGrouped = weightGrouping !== 'daily' && w.min_value != null;
                const whiskerMin = isGrouped ? ((w.min_value - allMin) / range) * 80 + 20 : 0;
                const whiskerMax = isGrouped ? ((w.max_value - allMin) / range) * 80 + 20 : 0;
                const periodLabel = w.period || new Date(w.logged_at).toLocaleDateString();
                const tooltip = isGrouped
                  ? `${periodLabel}: avg ${val} kg (${w.min_value}–${w.max_value}, ${w.count} entries)`
                  : `${val} kg — ${new Date(w.logged_at).toLocaleDateString()}`;
                return (
                  <div key={w.id || w.period || i} className={styles.weightBar} title={tooltip}>
                    {isGrouped && (
                      <div className={styles.whisker} style={{
                        bottom: `${whiskerMin}%`,
                        height: `${whiskerMax - whiskerMin}%`,
                      }} />
                    )}
                    <div className={styles.weightBarFill} style={{ height: `${barHeight}%` }} />
                    <span className={styles.weightLabel}>{val}</span>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Workout Trends */}
      <WorkoutTrendsChart range={weightRange} />

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
          <div key={log.id} className={styles.logCard} data-type={log.type}>
            <span className={styles.logIcon}>{TYPE_ICONS[log.type] || '📄'}</span>
            <div className={styles.logContent}>
              <div className={styles.logText}>{formatLogContent(log)}</div>
              <div className={styles.logMeta}>{formatTime(log.logged_at)}{log.source !== 'manual' ? ` · ${log.source}` : ''}</div>
            </div>
            <button className={styles.deleteBtn} onClick={() => deleteLog(log.id)} title="Delete">×</button>
          </div>
        ))}
        {hasMore && (
          <button className={styles.formButton} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
