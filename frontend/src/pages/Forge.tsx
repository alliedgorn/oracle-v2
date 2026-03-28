import React, { useState, useEffect, useCallback } from 'react';
import { PhotosTab } from '../components/forge/PhotosTab';
import styles from './Forge.module.css';

const API_BASE = '/api';

interface RoutineLog {
  id: number;
  type: string;
  logged_at: string;
  data: string;
  source: string;
}

type ForgeTab = 'log' | 'history' | 'stats' | 'photos';

const TAB_CONFIG: { id: ForgeTab; label: string; icon: string }[] = [
  { id: 'log', label: 'Log', icon: '✏️' },
  { id: 'history', label: 'History', icon: '📋' },
  { id: 'stats', label: 'Stats', icon: '📊' },
  { id: 'photos', label: 'Photos', icon: '📷' },
];

const TYPE_ICONS: Record<string, string> = {
  meal: '🍽️', workout: '💪', weight: '⚖️', note: '📝', photo: '📷', bodyfat: '📊',
};

function parseExerciseName(raw: string): { name: string; equipment: string } {
  const cleaned = raw.replace(/^\d+\.\s*/, '');
  const parts = cleaned.split(' · ');
  return { name: parts[0] || cleaned, equipment: parts[1] || '' };
}

function formatSets(sets: any[]): string {
  if (!sets?.length) return '';
  const unit = sets[0]?.unit || 'KG';
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

const KG_TO_LB = 2.20462;
const LB_TO_KG = 1 / KG_TO_LB;

function normalizeUnit(unit: string): 'kg' | 'lbs' {
  const u = (unit || 'kg').toLowerCase();
  if (u === 'lb' || u === 'lbs' || u === 'pound' || u === 'pounds') return 'lbs';
  return 'kg';
}

function convertWeight(value: number, fromUnit: string, toUnit: 'kg' | 'lbs'): number {
  const from = normalizeUnit(fromUnit);
  if (from === toUnit) return value;
  if (toUnit === 'lbs') return value * KG_TO_LB;
  return value * LB_TO_KG;
}

function WorkoutTrendsChart({ range }: { range: string }) {
  const [trends, setTrends] = useState<any>(null);
  const [metric, setMetric] = useState<'maxWeight' | 'totalVolume' | 'totalReps'>('maxWeight');
  const [selectedExercises, setSelectedExercises] = useState<string[]>([]);
  const [displayUnit, setDisplayUnit] = useState<'kg' | 'lbs'>('kg');

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
  const noSelection = exercises.length === 0;

  // Weight metrics need unit conversion
  const isWeightMetric = metric === 'maxWeight' || metric === 'totalVolume';

  const allPoints: { date: number; value: number }[] = [];
  for (const ex of exercises) {
    for (const pt of trends.trends[ex] || []) {
      let val = pt[metric];
      if (isWeightMetric) val = convertWeight(val, pt.unit || 'kg', displayUnit);
      allPoints.push({ date: new Date(pt.date).getTime(), value: val });
    }
  }
  const hasData = !noSelection && allPoints.length > 0;

  const minDate = hasData ? Math.min(...allPoints.map(p => p.date)) : 0;
  const maxDate = hasData ? Math.max(...allPoints.map(p => p.date)) : 1;
  const minVal = hasData ? Math.min(...allPoints.map(p => p.value)) : 0;
  const maxVal = hasData ? Math.max(...allPoints.map(p => p.value)) : 1;
  const valRange = maxVal - minVal || 1;
  const dateRange = maxDate - minDate || 1;

  const W = 600, H = 200, PAD_L = 45, PAD_R = 15, PAD_T = 15, PAD_B = 30;

  function toX(date: number) { return PAD_L + ((date - minDate) / dateRange) * (W - PAD_L - PAD_R); }
  function toY(val: number) { return H - PAD_B - ((val - minVal + valRange * 0.1) / (valRange * 1.2)) * (H - PAD_T - PAD_B); }

  // Generate x-axis date labels (5 evenly spaced) — include year if data spans multiple years
  const xLabelCount = 5;
  const xLabels: { date: number; label: string }[] = [];
  if (hasData) {
    const spanYears = new Date(maxDate).getFullYear() !== new Date(minDate).getFullYear();
    for (let i = 0; i < xLabelCount; i++) {
      const t = minDate + (dateRange * i) / (xLabelCount - 1);
      const d = new Date(t);
      const fmt: Intl.DateTimeFormatOptions = spanYears
        ? { month: 'short', year: 'numeric' }
        : { month: 'short', day: 'numeric' };
      xLabels.push({ date: t, label: d.toLocaleDateString('en-US', fmt) });
    }
  }

  const metricLabels: Record<string, string> = { maxWeight: 'Max Weight', totalVolume: 'Volume', totalReps: 'Total Reps' };
  const yAxisLabel = metric === 'totalReps' ? 'reps' : displayUnit;

  return (
    <div className={styles.weightSection}>
      <div className={styles.historyHeader}>
        <h3>Workout Trends</h3>
        <div className={styles.filters}>
          {(['maxWeight', 'totalVolume', 'totalReps'] as const).map(m => (
            <button key={m} className={`${styles.filterBtn} ${metric === m ? styles.filterActive : ''}`}
              onClick={() => setMetric(m)}>{metricLabels[m]}</button>
          ))}
          {isWeightMetric && (
            <button
              className={`${styles.filterBtn} ${styles.filterActive}`}
              onClick={() => setDisplayUnit(displayUnit === 'kg' ? 'lbs' : 'kg')}
              style={{ marginLeft: 8 }}
            >{displayUnit.toUpperCase()}</button>
          )}
        </div>
      </div>
      <div className={styles.trendChart}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
          {!hasData ? (
            <text x={W / 2} y={H / 2} fill="var(--text-muted)" fontSize={14} textAnchor="middle">
              Select exercises below to see trends
            </text>
          ) : (
          <>
          {/* Y-axis label */}
          <text x={12} y={H / 2} fill="var(--text-muted)" fontSize={10} textAnchor="middle"
            transform={`rotate(-90, 12, ${H / 2})`}>{yAxisLabel}</text>
          {/* Y-axis grid + labels (values already in display unit since allPoints are converted) */}
          {[0, 0.25, 0.5, 0.75, 1].map(frac => {
            const val = minVal + valRange * frac;
            const y = toY(val);
            return (
              <g key={frac}>
                <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--border)" strokeWidth={0.5} />
                <text x={PAD_L - 4} y={y + 3} fill="var(--text-muted)" fontSize={9} textAnchor="end">{Math.round(val)}</text>
              </g>
            );
          })}
          {/* X-axis date labels */}
          {xLabels.map((xl, i) => (
            <text key={i} x={toX(xl.date)} y={H - 6} fill="var(--text-muted)" fontSize={9} textAnchor="middle">
              {xl.label}
            </text>
          ))}
          {/* X-axis line */}
          <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="var(--border)" strokeWidth={0.5} />
          {exercises.map((exName, ei) => {
            const pts = (trends.trends[exName] || []).map((pt: any) => {
              let val = pt[metric];
              if (isWeightMetric) val = convertWeight(val, pt.unit || 'kg', displayUnit);
              return {
                x: toX(new Date(pt.date).getTime()),
                y: toY(val),
                raw: pt,
                convertedVal: val,
              };
            });
            if (pts.length === 0) return null;
            const pathD = pts.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
            return (
              <g key={exName}>
                <path d={pathD} fill="none" stroke={TREND_COLORS[ei % TREND_COLORS.length]} strokeWidth={2} />
                {pts.map((p: any, i: number) => (
                  <circle key={i} cx={p.x} cy={p.y} r={3}
                    fill={TREND_COLORS[ei % TREND_COLORS.length]}
                    style={{ cursor: 'pointer' }}>
                    <title>{`${exName} · ${new Date(p.raw.date).toLocaleDateString()} · ${metric === 'maxWeight' ? Math.round(p.convertedVal) + ' ' + displayUnit : metric === 'totalVolume' ? Math.round(p.convertedVal) + ' ' + displayUnit : p.raw.totalReps + ' reps'}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
          </>
          )}
        </svg>
      </div>
      <div className={styles.trendLegend}>
        {exercises.map((name, i) => (
          <span key={name} className={styles.trendLegendItem}>
            <span className={styles.trendDot} style={{ background: TREND_COLORS[i % TREND_COLORS.length] }} />
            {name}
          </span>
        ))}
      </div>
      {trends.allExercises?.length > 0 && (
        <details className={styles.exerciseSelector} open>
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
                      : [...prev, ex.name]
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

// Muscle groups for workout form
const MUSCLE_GROUPS = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core', 'Cardio', 'Other'];

interface WorkoutSet { weight: string; reps: string; done: boolean; }
interface WorkoutExercise { name: string; equipment: string; sets: WorkoutSet[]; }
interface ExerciseOption { id: number; name: string; muscle_group: string | null; equipment: string | null; }

function StructuredWorkoutForm({ onFinish, onCancel }: { onFinish: () => void; onCancel: () => void }) {
  const [muscleGroup, setMuscleGroup] = useState('');
  const [exercises, setExercises] = useState<WorkoutExercise[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ExerciseOption[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startTime] = useState(Date.now());
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (muscleGroup) params.set('muscle_group', muscleGroup.toLowerCase());
    if (!searchQuery && !muscleGroup) { setSearchResults([]); return; }
    fetch(`${API_BASE}/routine/exercises?${params}`)
      .then(r => r.json())
      .then(data => setSearchResults(data.exercises || []))
      .catch(() => {});
  }, [searchQuery, muscleGroup]);

  function addExercise(ex: ExerciseOption) {
    if (exercises.some(e => e.name === ex.name && e.equipment === (ex.equipment || ''))) return;
    const newIdx = exercises.length;
    setExercises(prev => [...prev, { name: ex.name, equipment: ex.equipment || '', sets: [{ weight: '', reps: '', done: false }] }]);
    setSearchQuery(''); setShowSearch(false);
    fetchSmartDefaults(ex.name, newIdx);
  }

  function addCustomExercise() {
    if (!searchQuery.trim()) return;
    setExercises(prev => [...prev, { name: searchQuery.trim(), equipment: '', sets: [{ weight: '', reps: '', done: false }] }]);
    setSearchQuery(''); setShowSearch(false);
  }

  async function fetchSmartDefaults(exerciseName: string, exerciseIndex: number) {
    try {
      const res = await fetch(`${API_BASE}/routine/logs?type=workout&limit=20`);
      const data = await res.json();
      for (const log of (data.logs || [])) {
        const logData = typeof log.data === 'string' ? JSON.parse(log.data) : log.data;
        for (const ex of (logData.exercises || [])) {
          const name = typeof ex === 'string' ? ex : (ex.name || '');
          if (parseExerciseName(name).name === exerciseName && ex.sets?.length) {
            setExercises(prev => prev.map((e, i) => i !== exerciseIndex ? e : {
              ...e, sets: ex.sets.map((s: any) => ({ weight: String(s.weight || ''), reps: String(s.reps || ''), done: false })),
            }));
            return;
          }
        }
      }
    } catch { /* no defaults */ }
  }

  function updateSet(exIdx: number, setIdx: number, field: keyof WorkoutSet, value: string | boolean) {
    setExercises(prev => prev.map((ex, i) => i !== exIdx ? ex : {
      ...ex, sets: ex.sets.map((s, j) => j === setIdx ? { ...s, [field]: value } : s),
    }));
  }

  function addSet(exIdx: number) {
    setExercises(prev => prev.map((ex, i) => {
      if (i !== exIdx) return ex;
      const last = ex.sets[ex.sets.length - 1];
      return { ...ex, sets: [...ex.sets, { weight: last?.weight || '', reps: last?.reps || '', done: false }] };
    }));
  }

  function removeExercise(exIdx: number) {
    setExercises(prev => prev.filter((_, i) => i !== exIdx));
  }

  async function finishWorkout() {
    if (exercises.length === 0) return;
    setSaving(true);
    const durationMin = Math.round((Date.now() - startTime) / 60000);
    const workoutData = {
      type: muscleGroup || 'Workout',
      muscle_group: muscleGroup.toLowerCase() || undefined,
      duration_min: durationMin,
      exercises: exercises.map(ex => ({
        name: ex.name, equipment: ex.equipment,
        sets: ex.sets.filter(s => s.weight || s.reps).map(s => ({ weight: parseFloat(s.weight) || 0, reps: parseInt(s.reps) || 0, unit: 'kg' })),
      })),
    };
    try {
      await fetch(`${API_BASE}/routine/logs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'workout', data: workoutData }),
      });
      setFinished(true);
    } finally { setSaving(false); }
  }

  if (finished) {
    const durationMin = Math.round((Date.now() - startTime) / 60000);
    const totalSets = exercises.reduce((sum, ex) => sum + ex.sets.filter(s => s.done).length, 0);
    const totalVolume = exercises.reduce((sum, ex) =>
      sum + ex.sets.filter(s => s.done).reduce((v, s) => v + (parseFloat(s.weight) || 0) * (parseInt(s.reps) || 0), 0), 0);
    return (
      <div className={styles.workoutForm}>
        <div className={styles.workoutSummary}>
          <h3>Workout Complete</h3>
          <div className={styles.summaryStats}>
            <div className={styles.summaryStat}><span className={styles.summaryValue}>{durationMin}</span><span className={styles.summaryLabel}>min</span></div>
            <div className={styles.summaryStat}><span className={styles.summaryValue}>{exercises.length}</span><span className={styles.summaryLabel}>exercises</span></div>
            <div className={styles.summaryStat}><span className={styles.summaryValue}>{totalSets}</span><span className={styles.summaryLabel}>sets</span></div>
            <div className={styles.summaryStat}><span className={styles.summaryValue}>{Math.round(totalVolume).toLocaleString()}</span><span className={styles.summaryLabel}>kg volume</span></div>
          </div>
          <button className={styles.submitBtn} onClick={onFinish}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.workoutForm}>
      <div className={styles.muscleGroupRow}>
        {MUSCLE_GROUPS.map(mg => (
          <button key={mg} className={`${styles.muscleChip} ${muscleGroup === mg ? styles.muscleChipActive : ''}`}
            onClick={() => setMuscleGroup(muscleGroup === mg ? '' : mg)}>{mg}</button>
        ))}
      </div>
      <div className={styles.exerciseSearch}>
        <input className={styles.formInput} placeholder="Search exercises..." value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setShowSearch(true); }} onFocus={() => setShowSearch(true)} />
        {showSearch && (searchResults.length > 0 || searchQuery) && (
          <div className={styles.searchDropdown}>
            {searchResults.map(ex => (
              <button key={ex.id} className={styles.searchItem} onClick={() => addExercise(ex)}>
                <span>{ex.name}</span>
                {ex.equipment && <span className={styles.searchEquip}>{ex.equipment}</span>}
              </button>
            ))}
            {searchQuery && !searchResults.some(r => r.name.toLowerCase() === searchQuery.toLowerCase()) && (
              <button className={styles.searchItem} onClick={addCustomExercise}>+ Add "{searchQuery}"</button>
            )}
          </div>
        )}
      </div>
      {exercises.map((ex, exIdx) => (
        <div key={exIdx} className={styles.exerciseBlock}>
          <div className={styles.exerciseBlockHeader}>
            <span className={styles.exerciseBlockName}>{ex.name}</span>
            {ex.equipment && <span className={styles.exerciseBlockEquip}>{ex.equipment}</span>}
            <button className={styles.exerciseRemoveBtn} onClick={() => removeExercise(exIdx)}>×</button>
          </div>
          <div className={styles.setsHeader}>
            <span className={styles.setCol}>Set</span><span className={styles.setCol}>Weight</span>
            <span className={styles.setCol}>Reps</span><span className={styles.setColSmall}></span>
          </div>
          {ex.sets.map((set, setIdx) => (
            <div key={setIdx} className={`${styles.setRow} ${set.done ? styles.setDone : ''}`}>
              <span className={styles.setNum}>{setIdx + 1}</span>
              <input className={styles.setInput} type="number" placeholder="0" value={set.weight}
                onChange={e => updateSet(exIdx, setIdx, 'weight', e.target.value)} />
              <input className={styles.setInput} type="number" placeholder="0" value={set.reps}
                onChange={e => updateSet(exIdx, setIdx, 'reps', e.target.value)} />
              <button className={`${styles.setCheck} ${set.done ? styles.setCheckDone : ''}`}
                onClick={() => updateSet(exIdx, setIdx, 'done', !set.done)}>✓</button>
            </div>
          ))}
          <button className={styles.addSetBtn} onClick={() => addSet(exIdx)}>+ Add set</button>
        </div>
      ))}
      <div className={styles.formActions}>
        {exercises.length > 0 && (
          <button className={styles.submitBtn} onClick={finishWorkout} disabled={saving}>
            {saving ? 'Saving...' : 'Finish Workout'}</button>
        )}
        <button className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Date helpers
function toDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function formatDateHeader(dateKey: string): string {
  const d = new Date(dateKey + 'T12:00:00');
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (toDateKey(today.toISOString()) === dateKey) return 'Today';
  if (toDateKey(yesterday.toISOString()) === dateKey) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDateNav(date: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const dk = toDateKey(date.toISOString());
  if (toDateKey(today.toISOString()) === dk) return 'Today';
  if (toDateKey(yesterday.toISOString()) === dk) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function WithingsStatus() {
  const [status, setStatus] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${API_BASE}/oauth/withings/status`)
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus({ connected: false }));
  }, []);

  async function handleSync() {
    setSyncing(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/oauth/withings/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.error) setError(data.error);
      else {
        // Refresh status after sync
        const s = await fetch(`${API_BASE}/oauth/withings/status`).then(r => r.json());
        setStatus(s);
      }
    } catch { setError('Sync failed'); }
    setSyncing(false);
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect Withings? Synced data will be kept.')) return;
    try {
      await fetch(`${API_BASE}/oauth/withings/disconnect`, { method: 'DELETE' });
      setStatus({ connected: false });
    } catch { setError('Disconnect failed'); }
  }

  if (!status) return null;

  if (!status.connected) {
    return (
      <div className={styles.withingsBar}>
        <a href={`${API_BASE}/oauth/withings/authorize`} className={styles.withingsConnectBtn}>
          Connect Withings
        </a>
      </div>
    );
  }

  return (
    <div className={styles.withingsBar}>
      <span className={styles.withingsStatus}>
        <span className={styles.withingsDot} />
        Withings Connected
      </span>
      {status.lastSync && (
        <span className={styles.withingsMeta}>
          Last sync: {new Date(status.lastSync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      <button className={styles.withingsSyncBtn} onClick={handleSync} disabled={syncing}>
        {syncing ? 'Syncing...' : 'Sync Now'}
      </button>
      <button className={styles.withingsDisconnectBtn} onClick={handleDisconnect}>
        Disconnect
      </button>
      {error && <span style={{ color: '#ef4444', fontSize: 12 }}>{error}</span>}
    </div>
  );
}

export function Forge() {
  // Tab state from URL hash
  const initialTab = (window.location.hash.replace('#', '') || 'log') as ForgeTab;
  const [tab, setTab] = useState<ForgeTab>(TAB_CONFIG.some(t => t.id === initialTab) ? initialTab : 'log');

  // Log tab state
  const [logs, setLogs] = useState<RoutineLog[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [activeForm, setActiveForm] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [mealItems, setMealItems] = useState<{ name: string; quantity: string; calories: string; protein: string; carbs: string; fat: string }[]>([]);
  const [addingItem, setAddingItem] = useState(false);
  const [itemDraft, setItemDraft] = useState({ name: '', quantity: '', calories: '', protein: '', carbs: '', fat: '' });
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [showWorkoutForm, setShowWorkoutForm] = useState(false);

  // Photo upload state
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoTag, setPhotoTag] = useState<string>('');

  // History tab state
  const [historyLogs, setHistoryLogs] = useState<RoutineLog[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Detail view state
  const [detailLog, setDetailLog] = useState<RoutineLog | null>(null);

  // Close detail overlay on ESC
  useEffect(() => {
    if (!detailLog) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetailLog(null); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [detailLog]);

  // Stats tab state
  const [weights, setWeights] = useState<any[]>([]);
  const [weightGrouping, setWeightGrouping] = useState<string>('daily');
  const [weightRange, setWeightRange] = useState('year');
  const [summary, setSummary] = useState<any>(null);
  const [personalRecords, setPersonalRecords] = useState<any[]>([]);
  const [prTimeFilter, setPrTimeFilter] = useState<'all' | 'month'>('all');
  const [weightUnit, setWeightUnit] = useState<'kg' | 'lbs'>('kg');

  const PAGE_SIZE = 30;

  function switchTab(t: ForgeTab) {
    setTab(t);
    window.location.hash = t === 'log' ? '' : t;
  }

  // Load logs for selected day
  const loadLogTab = useCallback(async () => {
    const dateStr = toDateKey(selectedDate.toISOString());
    const from = `${dateStr}T00:00:00`;
    const to = `${dateStr}T23:59:59`;
    const [logsRes, statsRes] = await Promise.all([
      fetch(`${API_BASE}/routine/logs?from=${from}&to=${to}&limit=100`),
      fetch(`${API_BASE}/routine/stats`),
    ]);
    const logsData = await logsRes.json();
    setLogs(logsData.logs || []);
    setStats(await statsRes.json());
  }, [selectedDate]);

  // Load history for the History tab
  const loadHistory = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (typeFilter) params.set('type', typeFilter);
    const res = await fetch(`${API_BASE}/routine/logs?${params}`);
    const data = await res.json();
    const newLogs = data.logs || [];
    setHistoryLogs(newLogs);
    setHasMore(newLogs.length >= PAGE_SIZE);
  }, [typeFilter]);

  // Load stats tab data
  const loadStats = useCallback(async () => {
    const [weightRes, summaryRes, prRes] = await Promise.all([
      fetch(`${API_BASE}/routine/weight?range=${weightRange}`),
      fetch(`${API_BASE}/routine/summary?range=week`),
      fetch(`${API_BASE}/routine/personal-records`),
    ]);
    const weightData = await weightRes.json();
    setWeights(weightData.weights || []);
    setWeightGrouping(weightData.grouping || 'daily');
    setSummary(await summaryRes.json());
    const prData = await prRes.json();
    setPersonalRecords(prData.records || []);
  }, [weightRange]);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(historyLogs.length) });
    if (typeFilter) params.set('type', typeFilter);
    const res = await fetch(`${API_BASE}/routine/logs?${params}`);
    const data = await res.json();
    const moreLogs = data.logs || [];
    setHistoryLogs(prev => [...prev, ...moreLogs]);
    setHasMore(moreLogs.length >= PAGE_SIZE);
    setLoadingMore(false);
  }

  // Load header stats on mount (always visible regardless of tab)
  useEffect(() => {
    fetch(`${API_BASE}/routine/stats`).then(r => r.json()).then(setStats).catch(() => {});
  }, []);

  // Load data based on active tab
  useEffect(() => {
    if (tab === 'log') loadLogTab();
    else if (tab === 'history') loadHistory();
    else if (tab === 'stats') loadStats();
  }, [tab, loadLogTab, loadHistory, loadStats]);

  async function createLog(type: string) {
    setLoading(true);
    try {
      let data: any;
      switch (type) {
        case 'meal': {
          const items = mealItems.map(it => ({
            name: it.name,
            quantity: it.quantity || undefined,
            calories: parseInt(it.calories || '0') || 0,
            protein: parseInt(it.protein || '0') || 0,
            carbs: parseInt(it.carbs || '0') || 0,
            fat: parseInt(it.fat || '0') || 0,
          }));
          const totals = items.reduce((acc, it) => ({
            calories: acc.calories + it.calories,
            protein: acc.protein + it.protein,
            carbs: acc.carbs + it.carbs,
            fat: acc.fat + it.fat,
          }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
          data = {
            description: formData.description || items.map(it => it.name).slice(0, 2).join(', ') + (items.length > 2 ? '...' : ''),
            items,
            ...totals,
            ...(formData.photo_url ? { photo_url: formData.photo_url } : {}),
          };
          break;
        }
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
      setMealItems([]);
      setAddingItem(false);
      setItemDraft({ name: '', quantity: '', calories: '', protein: '', carbs: '', fat: '' });
      setActiveForm(null);
      loadLogTab();
    } finally { setLoading(false); }
  }

  async function deleteLog(id: number) {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    await fetch(`${API_BASE}/routine/logs/${id}`, { method: 'DELETE' });
    if (tab === 'log') loadLogTab();
    else loadHistory();
  }

  function parseData(log: RoutineLog) {
    try { return typeof log.data === 'string' ? JSON.parse(log.data) : log.data; } catch { return {}; }
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatTimeShort(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function formatLogContent(log: RoutineLog): React.ReactNode {
    const d = parseData(log);
    switch (log.type) {
      case 'meal': {
        const macros = [
          d.calories ? `${d.calories} cal` : '',
          d.protein ? `${d.protein}g protein` : '',
          d.carbs ? `${d.carbs}g carbs` : '',
          d.fat ? `${d.fat}g fat` : '',
        ].filter(Boolean).join(' · ');
        const items = d.items as { name: string; quantity?: string; calories: number; protein: number; carbs: number; fat: number }[] | undefined;
        const itemCount = items?.length || 0;
        const label = d.description || (items ? items.slice(0, 2).map((it: any) => it.name).join(', ') + (itemCount > 2 ? '...' : '') : 'Meal');
        return (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            {d.photo_url && <img src={d.photo_url} alt="Meal" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 'var(--radius-sm)', flexShrink: 0 }} />}
            <div>
              <div>{label}{itemCount > 0 ? ` — ${itemCount} item${itemCount > 1 ? 's' : ''}` : ''}</div>
              {macros && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{macros}</div>}
            </div>
          </div>
        );
      }
      case 'workout': return <WorkoutCard data={d} />;
      case 'weight': return `${d.value} ${d.unit || 'kg'}`;
      case 'bodyfat': return `${d.value}% body fat`;
      case 'note': return d.text || 'Note';
      case 'photo': return `${d.tag ? `[${d.tag}] ` : ''}${d.notes || 'Progress photo'}`;
      default: return JSON.stringify(d);
    }
  }

  // Date navigation
  function navigateDate(delta: number) {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + delta);
    if (next <= new Date()) setSelectedDate(next);
  }

  // Group history logs by date
  function groupByDate(logs: RoutineLog[]): Map<string, RoutineLog[]> {
    const groups = new Map<string, RoutineLog[]>();
    for (const log of logs) {
      const key = toDateKey(log.logged_at);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(log);
    }
    return groups;
  }

  const isToday = toDateKey(selectedDate.toISOString()) === toDateKey(new Date().toISOString());

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
        <WithingsStatus />
      </div>

      {/* Tab navigation */}
      <div className={styles.tabBar}>
        {TAB_CONFIG.map(t => (
          <button
            key={t.id}
            className={`${styles.tabBtn} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => switchTab(t.id)}
          >
            <span className={styles.tabIcon}>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* ===== LOG TAB ===== */}
      {tab === 'log' && (
        <div className={styles.tabContent}>
          {/* Date navigator */}
          <div className={styles.dateNav}>
            <button className={styles.dateNavBtn} onClick={() => navigateDate(-1)}>‹</button>
            <span className={styles.dateNavLabel}>{formatDateNav(selectedDate)}</span>
            <button className={styles.dateNavBtn} onClick={() => navigateDate(1)} disabled={isToday}>›</button>
          </div>

          {/* Quick-add buttons — 4 main actions */}
          <div className={styles.quickAdd}>
            {['meal', 'workout', 'weight', 'note'].map(type => (
              <button
                key={type}
                className={`${styles.quickAddBtn} ${type === 'workout' ? (showWorkoutForm ? styles.quickAddActive : '') : (activeForm === type ? styles.quickAddActive : '')}`}
                onClick={() => {
                  if (type === 'workout') {
                    setShowWorkoutForm(!showWorkoutForm);
                    setActiveForm(null);
                    setFormData({});
                  } else {
                    setShowWorkoutForm(false);
                    setActiveForm(activeForm === type ? null : type);
                    setFormData({});
                  }
                }}
              >
                <span className={styles.quickAddIcon}>{TYPE_ICONS[type]}</span>
                <span>{type.charAt(0).toUpperCase() + type.slice(1)}</span>
              </button>
            ))}
          </div>

          {/* Photo + Import overflow */}
          <div className={styles.overflowRow}>
            <label className={styles.overflowBtn} style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setPendingPhoto(file);
                  setPhotoTag('');
                  e.target.value = '';
                }}
                disabled={loading}
              />
              {TYPE_ICONS.photo} {loading ? 'Uploading...' : 'Photo'}
            </label>

            <div className={styles.importDropdown}>
              <button className={styles.overflowBtn} onClick={() => setShowImportMenu(!showImportMenu)}>
                ⋯ Import
              </button>
              {showImportMenu && (
                <div className={styles.importMenu}>
                  <label className={styles.importMenuItem}>
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
                        setShowImportMenu(false);
                        try {
                          const fd = new FormData();
                          fd.append('file', file);
                          const res = await fetch(`${API_BASE}/routine/import/alpha-progression?preview=true`, { method: 'POST', body: fd });
                          const preview = await res.json();
                          preview._importType = 'workouts';
                          setImportPreview(preview);
                        } catch { setImportPreview({ error: 'Failed to parse CSV' }); }
                        setImporting(false);
                        e.target.value = '';
                      }}
                      disabled={importing}
                    />
                    💪 Import Workouts
                  </label>
                  <label className={styles.importMenuItem}>
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
                        setShowImportMenu(false);
                        try {
                          const fd = new FormData();
                          fd.append('file', file);
                          const res = await fetch(`${API_BASE}/routine/import/alpha-measurements?preview=true`, { method: 'POST', body: fd });
                          const preview = await res.json();
                          preview._importType = 'measurements';
                          setImportPreview(preview);
                        } catch { setImportPreview({ error: 'Failed to parse CSV' }); }
                        setImporting(false);
                        e.target.value = '';
                      }}
                      disabled={importing}
                    />
                    📊 Import Measurements
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* Photo tag picker */}
          {pendingPhoto && (
            <div className={styles.form}>
              <p style={{ margin: 0, fontSize: 14 }}>Tag this photo:</p>
              <div className={styles.muscleGroupRow}>
                {['Front', 'Side', 'Back'].map(tag => (
                  <button
                    key={tag}
                    className={`${styles.muscleChip} ${photoTag === tag.toLowerCase() ? styles.muscleChipActive : ''}`}
                    onClick={() => setPhotoTag(photoTag === tag.toLowerCase() ? '' : tag.toLowerCase())}
                  >{tag}</button>
                ))}
              </div>
              <div className={styles.formActions}>
                <button className={styles.submitBtn} disabled={loading} onClick={async () => {
                  setLoading(true);
                  try {
                    const fd = new FormData();
                    fd.append('file', pendingPhoto);
                    if (photoTag) fd.append('tag', photoTag);
                    await fetch(`${API_BASE}/routine/photo/upload`, { method: 'POST', body: fd });
                    setPendingPhoto(null);
                    setPhotoTag('');
                    loadLogTab();
                  } catch { /* ignore */ }
                  setLoading(false);
                }}>{loading ? 'Uploading...' : 'Upload'}</button>
                <button className={styles.cancelBtn} onClick={() => { setPendingPhoto(null); setPhotoTag(''); }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Import preview */}
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
                        const fd = new FormData();
                        fd.append('file', importFile);
                        const res = await fetch(`${API_BASE}/routine/import/${endpoint}`, { method: 'POST', body: fd });
                        const data = await res.json();
                        setImportResult(data);
                        setImportPreview(null);
                        setImportFile(null);
                        if (data.imported) loadLogTab();
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
                  <input placeholder="Meal name (optional)" value={formData.description || ''} onChange={e => setFormData(p => ({ ...p, description: e.target.value }))} className={styles.formInput} autoFocus />

                  {/* Item list */}
                  {mealItems.map((item, i) => (
                    <div key={i} className={styles.mealItemCard}>
                      <div className={styles.mealItemHeader}>
                        <span className={styles.mealItemName}>{item.name}{item.quantity ? ` ${item.quantity}` : ''}</span>
                        <button className={styles.mealItemRemove} onClick={() => setMealItems(prev => prev.filter((_, j) => j !== i))}>✕</button>
                      </div>
                      <div className={styles.mealItemMacros}>
                        {item.calories} cal · {item.protein}g P · {item.carbs}g C · {item.fat}g F
                      </div>
                    </div>
                  ))}

                  {/* Add item form */}
                  {addingItem ? (
                    <div className={styles.mealItemForm}>
                      <input placeholder="Food name *" value={itemDraft.name} onChange={e => setItemDraft(p => ({ ...p, name: e.target.value }))} className={styles.formInput} autoFocus />
                      <input placeholder="Quantity (e.g. 200g)" value={itemDraft.quantity} onChange={e => setItemDraft(p => ({ ...p, quantity: e.target.value }))} className={styles.formInput} />
                      <div className={styles.macroGrid}>
                        <input placeholder="Calories *" type="number" value={itemDraft.calories} onChange={e => setItemDraft(p => ({ ...p, calories: e.target.value }))} className={styles.formInput} />
                        <input placeholder="Protein (g) *" type="number" value={itemDraft.protein} onChange={e => setItemDraft(p => ({ ...p, protein: e.target.value }))} className={styles.formInput} />
                        <input placeholder="Carbs (g) *" type="number" value={itemDraft.carbs} onChange={e => setItemDraft(p => ({ ...p, carbs: e.target.value }))} className={styles.formInput} />
                        <input placeholder="Fat (g) *" type="number" value={itemDraft.fat} onChange={e => setItemDraft(p => ({ ...p, fat: e.target.value }))} className={styles.formInput} />
                      </div>
                      <div className={styles.formActions}>
                        <button
                          className={styles.submitBtn}
                          disabled={!itemDraft.name || !itemDraft.calories || !itemDraft.protein || !itemDraft.carbs || !itemDraft.fat}
                          onClick={() => {
                            setMealItems(prev => [...prev, { ...itemDraft }]);
                            setItemDraft({ name: '', quantity: '', calories: '', protein: '', carbs: '', fat: '' });
                            setAddingItem(false);
                          }}
                        >Add</button>
                        <button className={styles.cancelBtn} onClick={() => { setAddingItem(false); setItemDraft({ name: '', quantity: '', calories: '', protein: '', carbs: '', fat: '' }); }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button className={styles.addItemBtn} onClick={() => setAddingItem(true)}>+ Add item</button>
                  )}

                  {/* Auto-sum totals */}
                  {mealItems.length > 0 && (
                    <div className={styles.mealTotals}>
                      Total: {mealItems.reduce((s, it) => s + (parseInt(it.calories) || 0), 0)} cal
                      {' · '}{mealItems.reduce((s, it) => s + (parseInt(it.protein) || 0), 0)}g P
                      {' · '}{mealItems.reduce((s, it) => s + (parseInt(it.carbs) || 0), 0)}g C
                      {' · '}{mealItems.reduce((s, it) => s + (parseInt(it.fat) || 0), 0)}g F
                    </div>
                  )}

                  <div className={styles.formRow}>
                    <label className={styles.photoAttachBtn} style={{ cursor: 'pointer' }}>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const fd = new FormData();
                          fd.append('file', file);
                          const res = await fetch(`${API_BASE}/routine/photo/upload`, { method: 'POST', body: fd });
                          const data = await res.json();
                          if (data.url) setFormData(p => ({ ...p, photo_url: data.url }));
                          e.target.value = '';
                        }}
                      />
                      📷 {formData.photo_url ? 'Photo attached ✓' : 'Add photo'}
                    </label>
                    {formData.photo_url && (
                      <img src={formData.photo_url} alt="Meal" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 'var(--radius-sm)' }} />
                    )}
                  </div>
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
                <button className={styles.submitBtn} onClick={() => createLog(activeForm)} disabled={loading || (activeForm === 'meal' && mealItems.length === 0)}>
                  {loading ? 'Saving...' : 'Log it'}
                </button>
                <button className={styles.cancelBtn} onClick={() => { setActiveForm(null); setFormData({}); setMealItems([]); setAddingItem(false); }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Structured workout form */}
          {showWorkoutForm && (
            <StructuredWorkoutForm
              onFinish={() => { setShowWorkoutForm(false); loadLogTab(); }}
              onCancel={() => setShowWorkoutForm(false)}
            />
          )}

          {/* Today's feed */}
          <div className={styles.history}>
            {logs.length === 0 && (
              <div className={styles.empty}>
                No entries for {formatDateNav(selectedDate)}.
                {isToday && stats && stats.total_logs > 0 && (
                  <div style={{ marginTop: 8, fontSize: 13 }}>
                    {stats.total_logs} total logs · {stats.workouts_this_week} workouts this week
                  </div>
                )}
              </div>
            )}
            {logs.map(log => (
              <div key={log.id} className={styles.logCard} data-type={log.type} onClick={() => setDetailLog(log)} style={{ cursor: 'pointer' }}>
                <span className={styles.logIcon}>{TYPE_ICONS[log.type] || '📄'}</span>
                <div className={styles.logContent}>
                  <div className={styles.logText}>{formatLogContent(log)}</div>
                  <div className={styles.logMeta}>{formatTimeShort(log.logged_at)}{log.source !== 'manual' ? ` · ${log.source}` : ''}</div>
                </div>
                <button className={styles.deleteBtn} onClick={(e) => { e.stopPropagation(); deleteLog(log.id); }} title="Delete">×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== HISTORY TAB ===== */}
      {tab === 'history' && (
        <div className={styles.tabContent}>
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
            {historyLogs.length === 0 && <div className={styles.empty}>No logs yet. Start logging!</div>}
            {(() => {
              const groups = groupByDate(historyLogs);
              return Array.from(groups.entries()).map(([dateKey, dayLogs]) => (
                <div key={dateKey}>
                  <div className={styles.dateGroup}>{formatDateHeader(dateKey)}</div>
                  {dayLogs.map(log => (
                    <div key={log.id} className={styles.logCard} data-type={log.type} onClick={() => setDetailLog(log)} style={{ cursor: 'pointer' }}>
                      <span className={styles.logIcon}>{TYPE_ICONS[log.type] || '📄'}</span>
                      <div className={styles.logContent}>
                        <div className={styles.logText}>{formatLogContent(log)}</div>
                        <div className={styles.logMeta}>{formatTime(log.logged_at)}{log.source !== 'manual' ? ` · ${log.source}` : ''}</div>
                      </div>
                      <button className={styles.deleteBtn} onClick={(e) => { e.stopPropagation(); deleteLog(log.id); }} title="Delete">×</button>
                    </div>
                  ))}
                </div>
              ));
            })()}
            {hasMore && (
              <button className={styles.formButton} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ===== STATS TAB ===== */}
      {tab === 'stats' && (
        <div className={styles.tabContent}>
          {/* Summary Cards */}
          {summary && (
            <div className={styles.summaryCards}>
              <div className={styles.summaryCard}>
                <span className={styles.summaryValue}>{summary.workouts || 0}</span>
                <span className={styles.summaryLabel}>Workouts This Week</span>
              </div>
              <div className={styles.summaryCard}>
                <span className={styles.summaryValue}>
                  {summary.totalVolume ? (summary.totalVolume >= 1000000 ? `${(summary.totalVolume / 1000000).toFixed(1)}M` : summary.totalVolume >= 1000 ? `${(summary.totalVolume / 1000).toFixed(0)}K` : summary.totalVolume) : '0'}
                </span>
                <span className={styles.summaryLabel}>Volume This Week (kg)</span>
              </div>
              <div className={styles.summaryCard}>
                <span className={styles.summaryValue}>
                  {summary.latestWeight ? summary.latestWeight.value : '—'}
                  {summary.latestWeight?.trend === 'up' && <span className={styles.trendArrow}> ↑</span>}
                  {summary.latestWeight?.trend === 'down' && <span className={styles.trendArrowDown}> ↓</span>}
                </span>
                <span className={styles.summaryLabel}>Weight (kg)</span>
              </div>
              <div className={styles.summaryCard}>
                <span className={styles.summaryValue}>
                  {summary.bestLift ? `${summary.bestLift.weight}` : '—'}
                </span>
                <span className={styles.summaryLabel}>
                  {summary.bestLift ? `Best This Week: ${summary.bestLift.exercise} (${summary.bestLift.reps || '?'} reps)` : 'Best Lift This Week'}
                </span>
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
                  <button
                    className={`${styles.filterBtn} ${styles.filterActive}`}
                    onClick={() => setWeightUnit(weightUnit === 'kg' ? 'lbs' : 'kg')}
                    style={{ marginLeft: 8, fontWeight: 600 }}
                  >{weightUnit.toUpperCase()}</button>
                </div>
              </div>
              <div className={styles.trendChart}>
                {(() => {
                  const cv = (v: number) => convertWeight(v, 'kg', weightUnit);
                  const GOAL_WEIGHT = cv(120);
                  const W = 600, H = 200, PAD_L = 45, PAD_R = 15, PAD_T = 15, PAD_B = 30;

                  const values = weights.map((w: any) => cv(w.value));
                  const dates = weights.map((w: any) => new Date(w.logged_at).getTime());
                  const allMin = Math.min(...values);
                  const allMax = Math.max(...values, GOAL_WEIGHT);
                  const padding = (allMax - allMin) * 0.1 || 1;
                  const chartMin = allMin - padding;
                  const chartMax = allMax + padding;
                  const valRange = chartMax - chartMin || 1;
                  const minDate = Math.min(...dates);
                  const maxDate = Math.max(...dates);
                  const dateRange = maxDate - minDate || 1;

                  function toX(date: number) { return PAD_L + ((date - minDate) / dateRange) * (W - PAD_L - PAD_R); }
                  function toY(val: number) { return H - PAD_B - ((val - chartMin) / valRange) * (H - PAD_T - PAD_B); }

                  const pts = weights.map((w: any) => ({
                    x: toX(new Date(w.logged_at).getTime()),
                    y: toY(cv(w.value)),
                    w,
                    displayVal: cv(w.value),
                  }));
                  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

                  // X-axis labels (5 evenly spaced) — include year for wider ranges
                  const showYear = weightRange === '3y' || weightRange === '10y' || weightRange === 'all';
                  const xLabels: { x: number; label: string }[] = [];
                  for (let i = 0; i < 5; i++) {
                    const t = minDate + (dateRange * i) / 4;
                    const d = new Date(t);
                    const fmt: Intl.DateTimeFormatOptions = showYear
                      ? { month: 'short', year: 'numeric' }
                      : { month: 'short', day: 'numeric' };
                    xLabels.push({ x: toX(t), label: d.toLocaleDateString('en-US', fmt) });
                  }

                  return (
                    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
                      {/* Y-axis label */}
                      <text x={12} y={H / 2} fill="var(--text-muted)" fontSize={10} textAnchor="middle"
                        transform={`rotate(-90, 12, ${H / 2})`}>{weightUnit}</text>
                      {/* Y-axis grid + labels */}
                      {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                        const val = chartMin + valRange * frac;
                        const y = toY(val);
                        return (
                          <g key={frac}>
                            <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--border)" strokeWidth={0.5} />
                            <text x={PAD_L - 4} y={y + 3} fill="var(--text-muted)" fontSize={9} textAnchor="end">{Math.round(val)}</text>
                          </g>
                        );
                      })}
                      {/* X-axis date labels */}
                      {xLabels.map((xl, i) => (
                        <text key={i} x={xl.x} y={H - 6} fill="var(--text-muted)" fontSize={9} textAnchor="middle">{xl.label}</text>
                      ))}
                      {/* X-axis line */}
                      <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="var(--border)" strokeWidth={0.5} />
                      {/* Goal line */}
                      <line x1={PAD_L} y1={toY(GOAL_WEIGHT)} x2={W - PAD_R} y2={toY(GOAL_WEIGHT)}
                        stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="6 4" opacity={0.6} />
                      <text x={W - PAD_R + 2} y={toY(GOAL_WEIGHT) + 3} fill="var(--accent)" fontSize={9}>Goal</text>
                      {/* Weight line */}
                      <path d={pathD} fill="none" stroke="#d29922" strokeWidth={2} />
                      {/* Data points */}
                      {pts.map((p, i) => {
                        const w = p.w;
                        const isGrouped = weightGrouping !== 'daily' && w.min_value != null;
                        const periodLabel = w.period || new Date(w.logged_at).toLocaleDateString();
                        const dv = Math.round(p.displayVal * 10) / 10;
                        const tooltip = isGrouped
                          ? `${periodLabel}: avg ${dv} ${weightUnit} (${Math.round(cv(w.min_value) * 10) / 10}–${Math.round(cv(w.max_value) * 10) / 10}, ${w.count} entries)`
                          : `${dv} ${weightUnit} — ${new Date(w.logged_at).toLocaleDateString()}`;
                        return (
                          <circle key={i} cx={p.x} cy={p.y} r={3} fill="#d29922" style={{ cursor: 'pointer' }}>
                            <title>{tooltip}</title>
                          </circle>
                        );
                      })}
                    </svg>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Workout Trends */}
          <WorkoutTrendsChart range={weightRange} />

          {/* Personal Records */}
          {personalRecords.length > 0 && (
            <div className={styles.weightSection}>
              <div className={styles.historyHeader}>
                <h3>Personal Records</h3>
                <div className={styles.filters}>
                  <button
                    className={`${styles.filterBtn} ${prTimeFilter === 'all' ? styles.filterActive : ''}`}
                    onClick={() => setPrTimeFilter('all')}
                  >All-time</button>
                  <button
                    className={`${styles.filterBtn} ${prTimeFilter === 'month' ? styles.filterActive : ''}`}
                    onClick={() => setPrTimeFilter('month')}
                  >This month</button>
                </div>
              </div>
              <div className={styles.prList}>
                {personalRecords
                  .filter(pr => {
                    if (prTimeFilter === 'month') {
                      const prDate = new Date(pr.achieved_at);
                      const now = new Date();
                      return prDate.getMonth() === now.getMonth() && prDate.getFullYear() === now.getFullYear();
                    }
                    return true;
                  })
                  .slice(0, 20)
                  .map((pr: any) => {
                    const isRecent = (Date.now() - new Date(pr.achieved_at).getTime()) < 7 * 24 * 60 * 60 * 1000;
                    return (
                      <div key={pr.id} className={`${styles.prCard} ${isRecent ? styles.prRecent : ''}`}>
                        <div className={styles.prExercise}>{pr.exercise_name}</div>
                        <div className={styles.prDetail}>
                          <span className={styles.prWeight}>{pr.weight} {pr.unit} x {pr.reps}</span>
                          <span className={styles.prDate}>{new Date(pr.achieved_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                    );
                  })}
                {prTimeFilter === 'month' && personalRecords.filter(pr => {
                  const d = new Date(pr.achieved_at);
                  const now = new Date();
                  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
                }).length === 0 && (
                  <div className={styles.empty}>No PRs this month yet. Keep lifting.</div>
                )}
              </div>
            </div>
          )}

          {/* Muscle Group Balance */}
          {summary?.heatmap && Object.keys(summary.heatmap).length > 0 && (
            <div className={styles.weightSection}>
              <h3>Muscle Group Balance</h3>
              <div className={styles.muscleBalance}>
                {(() => {
                  const groups = summary.heatmap;
                  const maxVol = Math.max(...Object.values(groups).map((days: any) =>
                    Array.isArray(days) ? days.reduce((a: number, b: number) => a + b, 0) : (days as number)
                  ));
                  return Object.entries(groups).map(([group, vol]: [string, any]) => {
                    const total = Array.isArray(vol) ? vol.reduce((a: number, b: number) => a + b, 0) : vol;
                    const pct = maxVol > 0 ? (total / maxVol) * 100 : 0;
                    return (
                      <div key={group} className={styles.muscleRow}>
                        <span className={styles.muscleLabel}>{group}</span>
                        <div className={styles.muscleBarBg}>
                          <div className={styles.muscleBarFill} style={{ width: `${pct}%` }} />
                        </div>
                        <span className={styles.muscleValue}>{Math.round(total)}</span>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {weights.length === 0 && !summary && (
            <div className={styles.empty}>No stats data yet. Log some workouts and weights!</div>
          )}
        </div>
      )}

      {/* ===== PHOTOS TAB ===== */}
      {tab === 'photos' && (
        <div className={styles.tabContent}>
          <PhotosTab />
        </div>
      )}

      {/* Log detail overlay */}
      {detailLog && (() => {
        const d = parseData(detailLog);
        return (
          <div className={styles.detailOverlay} onClick={() => setDetailLog(null)}>
            <div className={styles.detailPanel} onClick={e => e.stopPropagation()}>
              <div className={styles.detailHeader}>
                <span className={styles.logIcon} style={{ fontSize: 24 }}>{TYPE_ICONS[detailLog.type] || '📄'}</span>
                <span className={styles.detailType}>{detailLog.type.charAt(0).toUpperCase() + detailLog.type.slice(1)}</span>
                <button className={styles.detailClose} onClick={() => setDetailLog(null)}>×</button>
              </div>
              <div className={styles.detailTime}>{formatTime(detailLog.logged_at)}{detailLog.source !== 'manual' ? ` · ${detailLog.source}` : ''}</div>
              <div className={styles.detailBody}>
                {detailLog.type === 'meal' && (
                  <>
                    {d.photo_url && <img src={d.photo_url} alt="Meal" className={styles.detailPhoto} />}
                    <div className={styles.detailField}><span className={styles.detailLabel}>Description</span><span>{d.description || '—'}</span></div>
                    {d.items && (
                      <div className={styles.detailField}>
                        <span className={styles.detailLabel}>Items</span>
                        <div>
                          {(d.items as any[]).map((item: any, i: number) => (
                            <div key={i} className={styles.mealItemCard} style={{ marginBottom: 6 }}>
                              <div className={styles.mealItemHeader}>
                                <span className={styles.mealItemName}>{item.name}{item.quantity ? ` ${item.quantity}` : ''}</span>
                              </div>
                              <div className={styles.mealItemMacros}>
                                {item.calories} cal · {item.protein}g P · {item.carbs}g C · {item.fat}g F
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className={styles.detailMacros}>
                      <div className={styles.detailMacro}><span className={styles.detailMacroVal}>{d.calories || 0}</span><span className={styles.detailMacroLabel}>cal</span></div>
                      <div className={styles.detailMacro}><span className={styles.detailMacroVal}>{d.protein || 0}g</span><span className={styles.detailMacroLabel}>protein</span></div>
                      <div className={styles.detailMacro}><span className={styles.detailMacroVal}>{d.carbs || 0}g</span><span className={styles.detailMacroLabel}>carbs</span></div>
                      <div className={styles.detailMacro}><span className={styles.detailMacroVal}>{d.fat || 0}g</span><span className={styles.detailMacroLabel}>fat</span></div>
                    </div>
                  </>
                )}
                {detailLog.type === 'workout' && <WorkoutCard data={d} />}
                {detailLog.type === 'weight' && (
                  <div className={styles.detailField}><span className={styles.detailLabel}>Weight</span><span style={{ fontSize: 28, fontWeight: 700 }}>{d.value} {d.unit || 'kg'}</span></div>
                )}
                {detailLog.type === 'note' && (
                  <div className={styles.detailField}><span className={styles.detailLabel}>Note</span><span>{d.text || '—'}</span></div>
                )}
                {detailLog.type === 'photo' && (
                  <>
                    {d.url && <img src={d.url} alt="Photo" className={styles.detailPhoto} />}
                    {d.tag && <div className={styles.detailField}><span className={styles.detailLabel}>Tag</span><span>{d.tag}</span></div>}
                    {d.notes && <div className={styles.detailField}><span className={styles.detailLabel}>Notes</span><span>{d.notes}</span></div>}
                  </>
                )}
              </div>
              <div className={styles.detailActions}>
                <button className={styles.cancelBtn} onClick={() => { deleteLog(detailLog.id); setDetailLog(null); }}>Delete</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
