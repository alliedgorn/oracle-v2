import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import styles from './Prowl.module.css';
import { EmojiButton } from '../components/EmojiButton';

interface ProwlTask {
  id: number;
  title: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
  due_date: string | null;
  status: 'pending' | 'done';
  notes: string | null;
  source: string | null;
  source_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface Counts {
  pending: number;
  done: number;
  overdue: number;
  high: number;
  medium: number;
  low: number;
}

type FilterTab = 'all' | 'high' | 'medium' | 'low' | 'done';

export function Prowl() {
  const [tasks, setTasks] = useState<ProwlTask[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, done: 0, overdue: 0, high: 0, medium: 0, low: 0 });
  const [categories, setCategories] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Partial<ProwlTask>>({});

  const loadTasks = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter === 'done') {
      params.set('status', 'done');
    } else if (filter === 'all') {
      params.set('status', 'pending');
    } else {
      params.set('status', 'pending');
      params.set('priority', filter);
    }
    if (categoryFilter) params.set('category', categoryFilter);

    const res = await fetch(`/api/prowl?${params}`);
    const data = await res.json();
    setTasks(data.tasks);
    setCounts(data.counts);
    setCategories(data.categories);
  }, [filter, categoryFilter]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  useWebSocket('prowl_update', loadTasks);

  async function addTask(e?: React.FormEvent) {
    e?.preventDefault();
    if (!newTitle.trim()) return;
    await fetch('/api/prowl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), priority: newPriority }),
    });
    setNewTitle('');
    setNewPriority('medium');
    await loadTasks();
  }

  async function toggleTask(id: number) {
    await fetch(`/api/prowl/${id}/toggle`, { method: 'POST' });
    await loadTasks();
  }

  async function saveEdit(id: number) {
    await fetch(`/api/prowl/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editData),
    });
    setExpandedId(null);
    setEditData({});
    await loadTasks();
  }

  async function deleteTask(id: number) {
    await fetch(`/api/prowl/${id}`, { method: 'DELETE' });
    setExpandedId(null);
    await loadTasks();
  }

  function expandTask(task: ProwlTask) {
    if (expandedId === task.id) {
      setExpandedId(null);
      setEditData({});
    } else {
      setExpandedId(task.id);
      setEditData({
        title: task.title,
        priority: task.priority,
        category: task.category,
        due_date: task.due_date ? task.due_date.slice(0, 10) : '',
        notes: task.notes || '',
      });
    }
  }

  function isOverdue(dueDate: string | null): boolean {
    if (!dueDate) return false;
    return new Date(dueDate) < new Date(new Date().toDateString());
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = d.getTime() - new Date(now.toDateString()).getTime();
    const days = Math.round(diff / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    if (days < -1) return `${Math.abs(days)}d overdue`;
    if (days <= 7) return `In ${days}d`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const filterTabs: { key: FilterTab; label: string; count?: number }[] = [
    { key: 'all', label: 'All', count: counts.pending },
    { key: 'high', label: 'High', count: counts.high },
    { key: 'medium', label: 'Medium', count: counts.medium },
    { key: 'low', label: 'Low', count: counts.low },
    { key: 'done', label: 'Done', count: counts.done },
  ];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Prowl</h1>
        <p className={styles.subtitle}>
          {counts.pending} pending{counts.overdue > 0 ? ` · ${counts.overdue} overdue` : ''}
        </p>
      </div>

      {/* Quick Add */}
      <form className={styles.quickAdd} onSubmit={addTask}>
        <input
          className={styles.quickAddInput}
          placeholder="Add a task..."
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
        />
        <select
          className={styles.prioritySelect}
          value={newPriority}
          onChange={e => setNewPriority(e.target.value as any)}
        >
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <button className={styles.addBtn} type="submit" disabled={!newTitle.trim()}>
          Add
        </button>
      </form>

      {/* Filter Tabs */}
      <div className={styles.filters}>
        {filterTabs.map(tab => (
          <button
            key={tab.key}
            className={`${styles.filterBtn} ${filter === tab.key ? styles.filterActive : ''}`}
            onClick={() => setFilter(tab.key)}
          >
            {tab.label}
            {tab.count !== undefined && <span className={styles.badge}>{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* Category Pills */}
      {categories.length > 0 && (
        <div className={styles.categories}>
          <button
            className={`${styles.categoryPill} ${!categoryFilter ? styles.categoryActive : ''}`}
            onClick={() => setCategoryFilter(null)}
          >
            All
          </button>
          {categories.map(cat => (
            <button
              key={cat}
              className={`${styles.categoryPill} ${categoryFilter === cat ? styles.categoryActive : ''}`}
              onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Task List */}
      {tasks.length === 0 ? (
        <div className={styles.empty}>Nothing on the Prowl. Add your first task above.</div>
      ) : (
        <div className={styles.taskList}>
          {tasks.map(task => (
            <div key={task.id}>
              <div
                className={`${styles.taskItem} ${task.status === 'done' ? styles.taskDone : ''}`}
              >
                <div
                  className={`${styles.checkbox} ${task.status === 'done' ? styles.checkboxChecked : ''}`}
                  onClick={() => toggleTask(task.id)}
                >
                  {task.status === 'done' && '\u2713'}
                </div>
                <div className={styles.taskContent} onClick={() => expandTask(task)}>
                  <div className={`${styles.taskTitle} ${task.status === 'done' ? styles.taskTitleDone : ''}`}>
                    {task.title}
                  </div>
                  <div className={styles.taskMeta}>
                    <span className={`${styles.priorityDot} ${
                      task.priority === 'high' ? styles.priorityHigh :
                      task.priority === 'medium' ? styles.priorityMedium :
                      styles.priorityLow
                    }`} />
                    <span className={styles.categoryTag}>{task.category}</span>
                    {task.due_date && (
                      <span className={`${styles.dueDate} ${isOverdue(task.due_date) && task.status === 'pending' ? styles.dueDateOverdue : ''}`}>
                        {formatDate(task.due_date)}
                      </span>
                    )}
                    {task.source && task.source !== 'manual' && (
                      <span className={styles.source}>{task.source}{task.source_id ? ` #${task.source_id}` : ''}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Expanded Edit */}
              {expandedId === task.id && (
                <div className={styles.taskExpanded}>
                  <div className={styles.expandedField}>
                    <label>Title</label>
                    <input
                      value={editData.title || ''}
                      onChange={e => setEditData({ ...editData, title: e.target.value })}
                    />
                  </div>
                  <div className={styles.expandedField}>
                    <label>Priority</label>
                    <select
                      value={editData.priority || 'medium'}
                      onChange={e => setEditData({ ...editData, priority: e.target.value as any })}
                    >
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </div>
                  <div className={styles.expandedField}>
                    <label>Category</label>
                    <input
                      value={editData.category || ''}
                      onChange={e => setEditData({ ...editData, category: e.target.value })}
                    />
                  </div>
                  <div className={styles.expandedField}>
                    <label>Due Date</label>
                    <input
                      type="date"
                      value={editData.due_date || ''}
                      onChange={e => setEditData({ ...editData, due_date: e.target.value || null })}
                    />
                  </div>
                  <div className={styles.expandedField}>
                    <label>Notes</label>
                    <textarea
                      value={(editData as any).notes || ''}
                      onChange={e => setEditData({ ...editData, notes: e.target.value })}
                      placeholder="Optional notes..."
                    />
                  </div>
                  <div className={styles.expandedActions}>
                    <EmojiButton onSelect={(e) => setEditData((prev: any) => ({ ...prev, notes: (prev.notes || '') + e }))} />
                    <button className={styles.saveBtn} onClick={() => saveEdit(task.id)}>Save</button>
                    <button className={styles.deleteBtn} onClick={() => deleteTask(task.id)}>Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
