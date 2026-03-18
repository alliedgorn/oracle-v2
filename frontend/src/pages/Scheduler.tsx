import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import styles from './Scheduler.module.css';

const API_BASE = '/api';

const VALID_INTERVALS = ['10m', '30m', '1h', '3h', '6h', '12h', '1d', '7d'];

interface Schedule {
  id: number;
  beast: string;
  task: string;
  command: string | null;
  interval: string;
  interval_seconds: number;
  last_run_at: string | null;
  next_due_at: string;
  enabled: number;
  source: string | null;
  created_at: string;
  updated_at: string;
}

function formatTime(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

function getStatus(schedule: Schedule): 'overdue' | 'due-soon' | 'on-schedule' | 'paused' {
  if (!schedule.enabled) return 'paused';
  const now = new Date();
  const due = new Date(schedule.next_due_at);
  const diffMs = due.getTime() - now.getTime();
  if (diffMs <= 0) return 'overdue';
  if (diffMs < schedule.interval_seconds * 250) return 'due-soon'; // within 25% of interval
  return 'on-schedule';
}

const STATUS_COLORS: Record<string, string> = {
  'overdue': 'var(--danger)',
  'due-soon': 'var(--accent)',
  'on-schedule': 'var(--success)',
  'paused': 'var(--text-muted)',
};

const BEAST_COLORS: Record<string, string> = {
  karo: '#d4943a', zaghnal: '#3a7dd4', gnarl: '#5a9a3e', bertus: '#8b6914',
  leonard: '#c4a235', mara: '#a855f7', rax: '#7c8a94', pip: '#d4563a',
  dex: '#4dd4ac', nyx: '#6366f1',
};

export function Scheduler() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [beastFilter, setBeastFilter] = useState<string>('all');
  const [showForm, setShowForm] = useState(false);
  const [formBeast, setFormBeast] = useState('');
  const [formTask, setFormTask] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formInterval, setFormInterval] = useState('1h');
  const [formSource, setFormSource] = useState('gorn');

  const loadSchedules = useCallback(async () => {
    const url = beastFilter === 'all' ? `${API_BASE}/schedules` : `${API_BASE}/schedules?beast=${beastFilter}`;
    const res = await fetch(url);
    const data = await res.json();
    setSchedules(data.schedules || []);
  }, [beastFilter]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);

  // Poll every 30s
  useEffect(() => {
    const interval = setInterval(() => { if (!document.hidden) loadSchedules(); }, 30000);
    return () => clearInterval(interval);
  }, [loadSchedules]);

  // WebSocket updates
  useWebSocket('schedule_update', () => loadSchedules());

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!formBeast || !formTask) return;
    await fetch(`${API_BASE}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beast: formBeast, task: formTask, command: formCommand || null, interval: formInterval, source: formSource }),
    });
    setShowForm(false);
    setFormBeast(''); setFormTask(''); setFormCommand(''); setFormInterval('1h');
    loadSchedules();
  }

  async function toggleEnabled(schedule: Schedule) {
    await fetch(`${API_BASE}/schedules/${schedule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !schedule.enabled }),
    });
    loadSchedules();
  }

  async function markRun(id: number) {
    await fetch(`${API_BASE}/schedules/${id}/run`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    loadSchedules();
  }

  async function deleteSchedule(id: number) {
    await fetch(`${API_BASE}/schedules/${id}`, { method: 'DELETE' });
    loadSchedules();
  }

  const beasts = [...new Set(schedules.map(s => s.beast))].sort();

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Beast Scheduler</h1>
        <p className={styles.subtitle}>Persistent schedules that survive sleep cycles</p>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <button className={`${styles.filterBtn} ${beastFilter === 'all' ? styles.active : ''}`} onClick={() => setBeastFilter('all')}>All</button>
          {beasts.map(b => (
            <button key={b} className={`${styles.filterBtn} ${beastFilter === b ? styles.active : ''}`} onClick={() => setBeastFilter(b)}
              style={beastFilter === b ? { borderColor: BEAST_COLORS[b] || '#666' } : undefined}
            >{b}</button>
          ))}
        </div>
        <button className={styles.newBtn} onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ New Schedule'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className={styles.form}>
          <input placeholder="Beast name" value={formBeast} onChange={e => setFormBeast(e.target.value)} required />
          <input placeholder="Task name" value={formTask} onChange={e => setFormTask(e.target.value)} required />
          <input placeholder="Command (optional)" value={formCommand} onChange={e => setFormCommand(e.target.value)} />
          <select value={formInterval} onChange={e => setFormInterval(e.target.value)}>
            {VALID_INTERVALS.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
          <select value={formSource} onChange={e => setFormSource(e.target.value)}>
            <option value="gorn">gorn</option>
            <option value="standing_order">standing_order</option>
            <option value="self">self</option>
          </select>
          <button type="submit" className={styles.submitBtn}>Create</button>
        </form>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Beast</th>
              <th>Task</th>
              <th>Interval</th>
              <th>Last Run</th>
              <th>Next Due</th>
              <th>Source</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 && (
              <tr><td colSpan={8} className={styles.empty}>No schedules yet</td></tr>
            )}
            {schedules.map(s => {
              const status = getStatus(s);
              return (
                <tr key={s.id} className={styles[status]}>
                  <td>
                    <span className={styles.statusDot} style={{ background: STATUS_COLORS[status] }} />
                    {status.replace('-', ' ')}
                  </td>
                  <td>
                    <span className={styles.beastDot} style={{ background: BEAST_COLORS[s.beast] || '#666' }} />
                    {s.beast}
                  </td>
                  <td className={styles.taskCell}>
                    <span className={styles.taskName}>{s.task}</span>
                    {s.command && <span className={styles.command}>{s.command}</span>}
                  </td>
                  <td>{s.interval}</td>
                  <td>{formatTime(s.last_run_at)}</td>
                  <td>{formatTime(s.next_due_at)}</td>
                  <td className={styles.source}>{s.source || '—'}</td>
                  <td className={styles.actions}>
                    <button onClick={() => markRun(s.id)} title="Mark as run">Run</button>
                    <button onClick={() => toggleEnabled(s)} title={s.enabled ? 'Pause' : 'Resume'}>
                      {s.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button onClick={() => deleteSchedule(s.id)} title="Delete" className={styles.deleteBtn}>Del</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
