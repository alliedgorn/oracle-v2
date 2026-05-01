import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import styles from './Board.module.css';
import ReactMarkdown from 'react-markdown';
import { autolinkIds } from '../utils/autolink';
import { EmojiButton } from '../components/EmojiButton';
import { FileUpload } from '../components/FileUpload';
import { VoiceInput } from '../components/VoiceInput';

interface Project {
  id: number;
  name: string;
  description: string;
  status: string;
  created_by: string;
  created_at: string;
}

interface SubtasksSummary {
  count: number;
  done: number;
  in_progress: number;
  todo: number;
  blocked: number;
  in_review: number;
  backlog: number;
  cancelled: number;
}

interface Task {
  id: number;
  project_id: number | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  created_by: string;
  project_name: string | null;
  thread_id: number | null;
  due_date: string | null;
  type: string;
  reviewer: string | null;
  risk_level: string;
  created_at: string;
  updated_at: string;
  parent_task_id: number | null;
  subtasks?: SubtasksSummary;
}

interface TaskComment {
  id: number;
  task_id: number;
  author: string;
  content: string;
  created_at: string;
}

interface BoardData {
  columns: Record<string, Task[]>;
  projects: Project[];
  total: number;
}

const API_BASE = '/api';

const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const;
const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const RISK_LEVELS = ['high', 'medium', 'low'] as const;

const BEAST_COLORS: Record<string, string> = {
  karo: '#d97706', zaghnal: '#7c3aed', gnarl: '#059669', bertus: '#dc2626',
  leonard: '#b45309', mara: '#2563eb', rax: '#6b7280', dex: '#0891b2',
  nyx: '#4b5563', pip: '#db2777', gorn: '#eab308',
};

export function Board() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>('__active__');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');
  const DONE_BATCH_SIZE = 5;
  const [doneTasks, setDoneTasks] = useState<Task[]>([]);
  const [doneTotal, setDoneTotal] = useState(0);
  const [doneLoading, setDoneLoading] = useState(false);
  const [doneOffset, setDoneOffset] = useState(0);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskComments, setTaskComments] = useState<TaskComment[]>([]);
  const [beasts, setBeasts] = useState<{ name: string; displayName: string }[]>([]);

  // Subtask expand/collapse
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set());
  const [subtasksByParent, setSubtasksByParent] = useState<Record<number, Task[]>>({});

  // New task form
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPriority, setNewPriority] = useState('medium');
  const [newAssignee, setNewAssignee] = useState('');
  const [newReviewer, setNewReviewer] = useState('');
  const [newRiskLevel, setNewRiskLevel] = useState('medium');
  const [newProjectId, setNewProjectId] = useState('');
  const [newStatus, setNewStatus] = useState('todo');
  const [newParentTaskId, setNewParentTaskId] = useState<number | null>(null);

  // New project form
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');

  // Comment form
  const [newComment, setNewComment] = useState('');

  useEffect(() => {
    loadBoard().then(() => {
      // Auto-open task from URL: /board?task=xxx
      const params = new URLSearchParams(window.location.search);
      const taskId = params.get('task');
      if (taskId) {
        fetch(`${API_BASE}/tasks/${taskId}`).then(r => r.json()).then(data => {
          if (data && data.id) {
            setSelectedTask(data);
            setTaskComments(data.comments || []);
          }
        }).catch(() => {});
      }
    });
    loadDoneTasks(0);
    fetch(`${API_BASE}/beasts`).then(r => r.json()).then(d => setBeasts(d.beasts || [])).catch(() => {});
  }, []);

  useEffect(() => {
    loadBoard();
    setAllDoneForActive([]);
    loadDoneTasks(0);
  }, [projectFilter, assigneeFilter]);

  // ESC key closes modal
  useEffect(() => {
    if (!selectedTask) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedTask(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedTask]);

  // Lock background scroll when modal is open
  useEffect(() => {
    if (selectedTask) {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      return () => {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
      };
    }
  }, [selectedTask]);

  // WebSocket real-time updates (replaced 10s polling)
  const handleWsUpdate = useCallback(() => {
    loadBoard();
    setAllDoneForActive([]);
    loadDoneTasks(0);
  }, [projectFilter, assigneeFilter]);

  useWebSocket('task_created', handleWsUpdate);
  useWebSocket('task_updated', handleWsUpdate);
  useWebSocket('tasks_bulk_updated', handleWsUpdate);

  // Refresh comments when a comment is added to the currently viewed task
  const handleCommentAdded = useCallback((data: { task_id: number }) => {
    if (selectedTask && data.task_id === selectedTask.id) {
      fetch(`${API_BASE}/tasks/${data.task_id}`).then(r => r.json()).then(d => {
        setTaskComments(d.comments || []);
      }).catch(() => {});
    }
  }, [selectedTask]);
  useWebSocket('task_comment_added', handleCommentAdded);

  // Refresh when page becomes visible (catch updates missed while hidden)
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        loadBoard();
        loadDoneTasks(0);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [projectFilter, assigneeFilter]);

  async function loadBoard() {
    const params = new URLSearchParams();
    if (projectFilter && projectFilter !== '__active__') params.set('project_id', projectFilter);
    if (assigneeFilter) params.set('assigned_to', assigneeFilter);
    const res = await fetch(`${API_BASE}/board?${params}`);
    const data = await res.json();
    // Filter to active projects only when "All Active" is selected
    if (projectFilter === '__active__' && data.columns) {
      const activeIds = new Set(data.projects.filter((p: any) => p.status === 'active').map((p: any) => p.id));
      for (const col of Object.keys(data.columns)) {
        data.columns[col] = data.columns[col].filter((t: any) => t.project_id && activeIds.has(t.project_id));
      }
      data.total = Object.values(data.columns).reduce((sum: number, col: any) => sum + col.length, 0);
    }
    // Clear done from board data — we fetch it separately via pagination
    if (data.columns) {
      data.columns.done = [];
    }
    setBoard(data);
  }

  // Cache all done tasks for __active__ filter (client-side filtering needs the full set)
  const [allDoneForActive, setAllDoneForActive] = useState<Task[]>([]);

  async function loadDoneTasks(offset: number = 0, append: boolean = false) {
    setDoneLoading(true);
    try {
      const isActiveFilter = projectFilter === '__active__';

      if (isActiveFilter) {
        // Fetch all done tasks and filter client-side by active projects
        if (!append || allDoneForActive.length === 0) {
          const params = new URLSearchParams({ status: 'done', limit: '200', offset: '0' });
          if (assigneeFilter) params.set('assigned_to', assigneeFilter);
          const res = await fetch(`${API_BASE}/tasks?${params}`);
          const data = await res.json();
          let all: Task[] = data.tasks || [];
          if (board) {
            const activeIds = new Set(board.projects.filter(p => p.status === 'active').map(p => p.id));
            all = all.filter(t => t.project_id && activeIds.has(t.project_id));
          }
          setAllDoneForActive(all);
          setDoneTasks(all.slice(0, DONE_BATCH_SIZE));
          setDoneTotal(all.length);
          setDoneOffset(DONE_BATCH_SIZE);
        } else {
          // Append from cached list
          const newSlice = allDoneForActive.slice(offset, offset + DONE_BATCH_SIZE);
          setDoneTasks(prev => [...prev, ...newSlice]);
          setDoneOffset(offset + newSlice.length);
        }
      } else {
        const params = new URLSearchParams({
          status: 'done',
          limit: String(DONE_BATCH_SIZE),
          offset: String(offset),
        });
        if (projectFilter) params.set('project_id', projectFilter);
        if (assigneeFilter) params.set('assigned_to', assigneeFilter);
        const res = await fetch(`${API_BASE}/tasks?${params}`);
        const data = await res.json();
        const tasks: Task[] = data.tasks || [];
        const total: number = data.total || 0;
        if (append) {
          setDoneTasks(prev => [...prev, ...tasks]);
        } else {
          setDoneTasks(tasks);
        }
        setDoneTotal(total);
        setDoneOffset(offset + tasks.length);
      }
    } catch {}
    setDoneLoading(false);
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || !newAssignee) return;
    await fetch(`${API_BASE}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newTitle,
        description: newDesc,
        priority: newPriority,
        assigned_to: newAssignee || null,
        reviewer: newReviewer || null,
        risk_level: newRiskLevel,
        project_id: newProjectId ? parseInt(newProjectId, 10) : null,
        status: newStatus,
        created_by: 'gorn',
        ...(newParentTaskId ? { parent_task_id: newParentTaskId } : {}),
      }),
    });
    setNewTitle(''); setNewDesc(''); setNewPriority('medium');
    setNewAssignee(''); setNewReviewer(''); setNewRiskLevel('medium'); setNewProjectId(''); setNewStatus('todo');
    setNewParentTaskId(null);
    setShowNewTask(false);
    loadBoard();
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjectName, description: newProjectDesc, created_by: 'gorn' }),
    });
    setNewProjectName(''); setNewProjectDesc('');
    setShowNewProject(false);
    loadBoard();
  }

  async function updateProjectStatus(projectId: number, status: string) {
    await fetch(`${API_BASE}/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    loadBoard();
  }

  async function updateTaskStatus(taskId: number, status: string) {
    await fetch(`${API_BASE}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    loadBoard();
    if (selectedTask?.id === taskId) {
      setSelectedTask(prev => prev ? { ...prev, status } : null);
    }
  }

  async function openTaskDetail(task: Task) {
    setSelectedTask(task);
    const res = await fetch(`${API_BASE}/tasks/${task.id}`);
    const data = await res.json();
    setSelectedTask(data);
    setTaskComments(data.comments || []);
  }

  async function toggleSubtasks(taskId: number, e: React.MouseEvent) {
    e.stopPropagation();
    const next = new Set(expandedTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
      if (!subtasksByParent[taskId]) {
        const res = await fetch(`${API_BASE}/tasks?parent_id=${taskId}&limit=50`);
        const data = await res.json();
        setSubtasksByParent(prev => ({ ...prev, [taskId]: data.tasks || [] }));
      }
    }
    setExpandedTasks(next);
  }

  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    if (!newComment.trim() || !selectedTask) return;
    await fetch(`${API_BASE}/tasks/${selectedTask.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'gorn', content: newComment }),
    });
    setNewComment('');
    const res = await fetch(`${API_BASE}/tasks/${selectedTask.id}`);
    const data = await res.json();
    setTaskComments(data.comments || []);
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  }

  function allTasks(): Task[] {
    if (!board) return [];
    return [...Object.values(board.columns).flat(), ...doneTasks];
  }

  if (!board) return <div className={styles.loading}>Loading board...</div>;

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <h1>PM Board</h1>
        <div className={styles.headerActions}>
          <button
            className={styles.viewToggle}
            onClick={() => setViewMode(prev => prev === 'kanban' ? 'list' : 'kanban')}
            title={viewMode === 'kanban' ? 'Switch to list view' : 'Switch to Kanban view'}
          >
            {viewMode === 'kanban' ? '☰' : '▦'}
          </button>
          <button className={styles.newTaskBtn} onClick={() => { setShowNewProject(false); setShowNewTask(!showNewTask); if (!showNewTask && projectFilter && projectFilter !== '__active__') setNewProjectId(projectFilter); }}>
            + Task
          </button>
          <button className={styles.newTaskBtn} onClick={() => { setShowNewTask(false); setShowNewProject(!showNewProject); }} style={{ background: 'var(--text-muted)' }}>
            + Project
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className={styles.filters}>
        <select
          className={styles.projectSelect}
          value={projectFilter}
          onChange={e => setProjectFilter(e.target.value)}
        >
          <option value="">All Projects</option>
          <option value="__active__">All Active</option>
          {(['active', 'paused', 'completed'] as const).map(status => {
            const group = board.projects.filter(p => p.status === status);
            return group.length > 0 ? (
              <optgroup key={status} label={status.charAt(0).toUpperCase() + status.slice(1)}>
                {group.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{status !== 'active' ? ` (${status})` : ''}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
        <select
          className={styles.projectSelect}
          value={assigneeFilter}
          onChange={e => setAssigneeFilter(e.target.value)}
        >
          <option value="">All Beasts</option>
          {beasts.map(b => (
            <option key={b.name} value={b.name}>{b.displayName}</option>
          ))}
          <option value="gorn">Gorn</option>
        </select>
        {projectFilter && projectFilter !== '__active__' && (() => {
          const proj = board.projects.find(p => String(p.id) === projectFilter);
          return proj ? (
            <>
              <select
                className={styles.projectSelect}
                value={proj.status}
                onChange={e => updateProjectStatus(proj.id, e.target.value)}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
              </select>
              <span className={`${styles.projectStatusBadge} ${
                proj.status === 'active' ? styles.statusActive :
                proj.status === 'paused' ? styles.statusPaused :
                styles.statusCompleted
              }`}>
                {proj.status}
              </span>
            </>
          ) : null;
        })()}
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {board.total} tasks
        </span>
      </div>

      {/* Paused/Completed project banner */}
      {(() => {
        const proj = projectFilter && projectFilter !== '__active__'
          ? board.projects.find(p => String(p.id) === projectFilter)
          : null;
        return proj && proj.status !== 'active' ? (
          <div className={styles.projectBanner} data-status={proj.status}>
            This project is {proj.status}.
            {proj.status === 'paused' && (
              <button
                className={styles.bannerAction}
                onClick={() => updateProjectStatus(proj.id, 'active')}
              >
                Reactivate
              </button>
            )}
          </div>
        ) : null;
      })()}

      {/* New Task Form */}
      {showNewTask && (
        <form onSubmit={createTask} className={styles.newTaskForm}>
          {newParentTaskId && (
            <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
              Creating subtask of T#{newParentTaskId}
              <button type="button" style={{ fontSize: 11, cursor: 'pointer', background: 'none', border: 'none', color: 'var(--text-muted)' }} onClick={() => setNewParentTaskId(null)}>✕ clear</button>
            </div>
          )}
          <input
            placeholder={newParentTaskId ? "Subtask title..." : "Task title..."}
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            className={styles.formInput}
            autoFocus
          />
          <textarea
            placeholder="Description (markdown)..."
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            className={styles.formTextarea}
            rows={2}
          />
          <div className={styles.formRow}>
            <select value={newPriority} onChange={e => setNewPriority(e.target.value)} className={styles.projectSelect}>
              {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={newStatus} onChange={e => setNewStatus(e.target.value)} className={styles.projectSelect}>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
            <select value={newAssignee} onChange={e => setNewAssignee(e.target.value)} className={styles.projectSelect} required>
              <option value="" disabled>Assignee</option>
              {beasts.map(b => <option key={b.name} value={b.name}>{b.displayName}</option>)}
              <option value="gorn">Gorn</option>
            </select>
            <select value={newReviewer} onChange={e => setNewReviewer(e.target.value)} className={styles.projectSelect} required>
              <option value="" disabled>Reviewer</option>
              {beasts.map(b => <option key={b.name} value={b.name}>{b.displayName}</option>)}
              <option value="gorn">Gorn</option>
            </select>
            <select value={newRiskLevel} onChange={e => setNewRiskLevel(e.target.value)} className={styles.projectSelect}>
              {RISK_LEVELS.map(r => <option key={r} value={r}>Risk: {r}</option>)}
            </select>
            <select value={newProjectId} onChange={e => setNewProjectId(e.target.value)} className={styles.projectSelect} required>
              <option value="" disabled>Select Project</option>
              {board.projects.filter(p => p.status === 'active').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button type="submit" className={styles.newTaskBtn} disabled={!newTitle.trim() || !newProjectId || !newReviewer}>Create</button>
            <button type="button" className={styles.cancelBtn} onClick={() => setShowNewTask(false)}>Cancel</button>
          </div>
        </form>
      )}

      {/* New Project Form */}
      {showNewProject && (
        <form onSubmit={createProject} className={styles.newTaskForm}>
          <input
            placeholder="Project name..."
            value={newProjectName}
            onChange={e => setNewProjectName(e.target.value)}
            className={styles.formInput}
            autoFocus
          />
          <input
            placeholder="Description..."
            value={newProjectDesc}
            onChange={e => setNewProjectDesc(e.target.value)}
            className={styles.formInput}
          />
          <div className={styles.formRow}>
            <button type="submit" className={styles.newTaskBtn} disabled={!newProjectName.trim()}>Create Project</button>
            <button type="button" className={styles.cancelBtn} onClick={() => setShowNewProject(false)}>Cancel</button>
          </div>
        </form>
      )}

      {/* Kanban View */}
      {viewMode === 'kanban' && (
        <div className={`${styles.board} ${(() => {
          const proj = projectFilter && projectFilter !== '__active__'
            ? board.projects.find(p => String(p.id) === projectFilter)
            : null;
          return proj && proj.status !== 'active' ? styles.pausedBoard : '';
        })()}`}>
          {STATUSES.map(status => {
            const isDone = status === 'done';
            const tasks = isDone ? doneTasks : (board.columns[status] || []);
            const taskCount = isDone ? doneTotal : tasks.length;
            const hasMoreDone = isDone && doneTasks.length < doneTotal;
            return (
              <div key={status} className={styles.column}>
                <div className={styles.columnHeader}>
                  <span className={styles.columnTitle}>{STATUS_LABELS[status]}</span>
                  <span className={styles.columnCount}>{taskCount}</span>
                </div>
                <div className={styles.columnBody}>
                  {tasks.length === 0 && !isDone && (
                    <div className={styles.emptyColumn}>No tasks</div>
                  )}
                  {isDone && tasks.length === 0 && !doneLoading && (
                    <div className={styles.emptyColumn}>No completed tasks</div>
                  )}
                  {tasks.filter(t => !t.parent_task_id).map(task => (
                    <React.Fragment key={task.id}>
                      <TaskCard
                        task={task}
                        onClick={() => openTaskDetail(task)}
                        hasSubtasks={!!task.subtasks?.count}
                        expanded={expandedTasks.has(task.id)}
                        onToggle={(e) => toggleSubtasks(task.id, e)}
                      />
                      {expandedTasks.has(task.id) && (subtasksByParent[task.id] || []).map(sub => (
                        <div key={sub.id} style={{ marginLeft: 20, borderLeft: '2px solid var(--border)', paddingLeft: 8, opacity: 0.85 }}>
                          <TaskCard task={sub} onClick={() => openTaskDetail(sub)} />
                        </div>
                      ))}
                    </React.Fragment>
                  ))}
                  {isDone && hasMoreDone && (
                    <button
                      className={styles.cancelBtn}
                      style={{ width: '100%', fontSize: 12, padding: '6px' }}
                      onClick={() => loadDoneTasks(doneOffset, true)}
                      disabled={doneLoading}
                    >
                      {doneLoading ? 'Loading...' : `Load More (${doneTotal - doneTasks.length} remaining)`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* List View */}
      {viewMode === 'list' && (
        <div className={`${styles.listView} ${(() => {
          const proj = projectFilter && projectFilter !== '__active__'
            ? board.projects.find(p => String(p.id) === projectFilter)
            : null;
          return proj && proj.status !== 'active' ? styles.pausedBoard : '';
        })()}`}>
          <table className={styles.listTable}>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Title</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Reviewer</th>
                <th>Project</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {allTasks().map(task => (
                <tr key={task.id} className={styles.listRow} onClick={() => openTaskDetail(task)}>
                  <td><span className={`${styles.priorityBadge} ${styles[`priority${task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}`]}`}>{task.priority}</span></td>
                  <td className={styles.listTitle}>{task.title}</td>
                  <td><span className={styles.statusBadge}>{STATUS_LABELS[task.status]}</span></td>
                  <td>
                    {task.assigned_to && (
                      <span className={styles.assignee}>
                        <span className={styles.assigneeDot} style={{ background: BEAST_COLORS[task.assigned_to] || '#666' }} />
                        {task.assigned_to}
                      </span>
                    )}
                  </td>
                  <td>
                    {task.reviewer && (
                      <span className={styles.assignee}>
                        <span className={styles.assigneeDot} style={{ background: BEAST_COLORS[task.reviewer] || '#666' }} />
                        {task.reviewer}
                      </span>
                    )}
                  </td>
                  <td>{task.project_name && <span className={styles.projectTag}>{task.project_name}</span>}</td>
                  <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{formatTime(task.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Task Detail Modal */}
      {selectedTask && (
        <div className={styles.modalOverlay} onClick={() => setSelectedTask(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2><span className={styles.modalTaskId}>T#{selectedTask.id}</span> {selectedTask.title}</h2>
              <button className={styles.modalClose} onClick={() => setSelectedTask(null)}>✕</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.modalMeta}>
                <div className={styles.metaRow}>
                  <label>Status</label>
                  <select
                    value={selectedTask.status}
                    onChange={e => updateTaskStatus(selectedTask.id, e.target.value)}
                    className={styles.projectSelect}
                  >
                    {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                  </select>
                </div>
                <div className={styles.metaRow}>
                  <label>Priority</label>
                  <span className={`${styles.priorityBadge} ${styles[`priority${selectedTask.priority.charAt(0).toUpperCase() + selectedTask.priority.slice(1)}`]}`}>
                    {selectedTask.priority}
                  </span>
                </div>
                <div className={styles.metaRow}>
                  <label>Assigned to</label>
                  <span>{selectedTask.assigned_to || 'Unassigned'}</span>
                </div>
                <div className={styles.metaRow}>
                  <label>Reviewer</label>
                  <span>{selectedTask.reviewer || 'None'}</span>
                </div>
                <div className={styles.metaRow}>
                  <label>Risk Level</label>
                  <span className={`${styles.priorityBadge} ${styles[`priority${(selectedTask.risk_level || 'medium') === 'high' ? 'High' : (selectedTask.risk_level || 'medium') === 'low' ? 'Low' : 'Medium'}`]}`}>
                    {selectedTask.risk_level || 'medium'}
                  </span>
                </div>
                {selectedTask.project_name && (
                  <div className={styles.metaRow}>
                    <label>Project</label>
                    <span className={styles.projectTag}>{selectedTask.project_name}</span>
                  </div>
                )}
                {selectedTask.thread_id && (
                  <div className={styles.metaRow}>
                    <label>Forum Thread</label>
                    <a href={`/forum?thread=${selectedTask.thread_id}`} style={{ color: 'var(--accent)' }}>#{selectedTask.thread_id}</a>
                  </div>
                )}
                <div className={styles.metaRow}>
                  <label>Created by</label>
                  <span>{selectedTask.created_by}</span>
                </div>
                <div className={styles.metaRow}>
                  <label>Created</label>
                  <span style={{ fontSize: '12px' }}>{new Date(selectedTask.created_at).toLocaleString()}</span>
                </div>
              </div>

              {selectedTask.parent_task_id && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  ↑ Subtask of <a href="#" onClick={e => { e.preventDefault(); fetch(`${API_BASE}/tasks/${selectedTask.parent_task_id}`).then(r=>r.json()).then(d => { setSelectedTask(d); setTaskComments(d.comments||[]); }); }} style={{ color: 'var(--accent)' }}>T#{selectedTask.parent_task_id}</a>
                </div>
              )}

              {selectedTask.description && (
                <div className={styles.taskDescription}>
                  <ReactMarkdown>{autolinkIds(selectedTask.description)}</ReactMarkdown>
                </div>
              )}

              {/* Subtasks */}
              {selectedTask.subtasks && selectedTask.subtasks.count > 0 && (
                <div style={{ marginTop: 12, marginBottom: 12, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                  <h3 style={{ fontSize: 14, margin: '0 0 8px 0' }}>Subtasks ({selectedTask.subtasks.done}/{selectedTask.subtasks.count})</h3>
                  {(subtasksByParent[selectedTask.id] || []).map(sub => (
                    <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>#{sub.id}</span>
                      <span style={{ flex: 1, cursor: 'pointer', color: 'var(--accent)' }} onClick={() => openTaskDetail(sub)}>{sub.title}</span>
                      <span className={`${styles.priorityBadge} ${styles[`priority${sub.status === 'done' ? 'Low' : sub.status === 'in_progress' ? 'High' : 'Medium'}`]}`} style={{ fontSize: 10 }}>
                        {STATUS_LABELS[sub.status] || sub.status}
                      </span>
                    </div>
                  ))}
                  {!subtasksByParent[selectedTask.id] && (
                    <button className={styles.cancelBtn} style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => {
                      fetch(`${API_BASE}/tasks?parent_id=${selectedTask.id}&limit=50`).then(r=>r.json()).then(d => {
                        setSubtasksByParent(prev => ({...prev, [selectedTask.id]: d.tasks || []}));
                      });
                    }}>Load subtasks</button>
                  )}
                </div>
              )}

              {!selectedTask.parent_task_id && (
                <button
                  className={styles.cancelBtn}
                  style={{ fontSize: 12, padding: '4px 8px', marginBottom: 12 }}
                  onClick={() => {
                    setNewParentTaskId(selectedTask.id);
                    if (selectedTask.project_id) setNewProjectId(String(selectedTask.project_id));
                    setSelectedTask(null);
                    setShowNewTask(true);
                    setNewStatus('todo');
                  }}
                >
                  + Add Subtask
                </button>
              )}

              {/* Comments */}
              <div className={styles.commentsSection}>
                <h3>Comments ({taskComments.length})</h3>
                {taskComments.map(comment => (
                  <div key={comment.id} className={styles.comment}>
                    <div className={styles.commentHeader}>
                      <span style={{ fontWeight: 600, color: BEAST_COLORS[comment.author] || 'var(--accent)', textTransform: 'capitalize' }}>{comment.author}</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{formatTime(comment.created_at)}</span>
                    </div>
                    <div className={styles.commentContent}>
                      <ReactMarkdown>{autolinkIds(comment.content)}</ReactMarkdown>
                    </div>
                  </div>
                ))}
                <form onSubmit={addComment} className={styles.commentForm}>
                  <textarea
                    placeholder="Add a comment..."
                    value={newComment}
                    onChange={e => setNewComment(e.target.value)}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                    className={styles.formTextarea}
                    rows={2}
                  />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <FileUpload onUploadComplete={(md) => setNewComment(prev => prev + md)} />
                    <EmojiButton onSelect={(e) => setNewComment(prev => prev + e)} />
                    <VoiceInput onTranscript={(text) => setNewComment(prev => prev ? prev + ' ' + text : text)} />
                    <button type="submit" className={styles.newTaskBtn} disabled={!newComment.trim()}>Comment</button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Task card component
function TaskCard({ task, onClick, hasSubtasks, expanded, onToggle }: { task: Task; onClick: () => void; hasSubtasks?: boolean; expanded?: boolean; onToggle?: (e: React.MouseEvent) => void }) {
  return (
    <div
      className={styles.taskCard}
      style={{ '--priority-color': getPriorityColor(task.priority) } as React.CSSProperties}
      onClick={onClick}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {hasSubtasks && (
          <span
            onClick={onToggle}
            style={{ cursor: 'pointer', fontSize: 12, userSelect: 'none', width: 16, textAlign: 'center' }}
            title={expanded ? 'Collapse subtasks' : 'Expand subtasks'}
          >
            {expanded ? '▾' : '▸'}
          </span>
        )}
        <span className={styles.taskId}>#{task.id}</span>
        {task.subtasks && task.subtasks.count > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-secondary)', borderRadius: 8, padding: '1px 6px' }}>
            {task.subtasks.done}/{task.subtasks.count}
          </span>
        )}
      </div>
      <div className={styles.taskTitle}>{task.title}</div>
      <div className={styles.taskMeta}>
        <span className={`${styles.priorityBadge} ${styles[`priority${task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}`]}`}>
          {task.priority}
        </span>
        {task.type && task.type !== 'task' && (
          <span className={`${styles.typeBadge} ${styles[`type${task.type.charAt(0).toUpperCase() + task.type.slice(1)}`]}`}>
            {task.type}
          </span>
        )}
        {task.risk_level && task.risk_level !== 'medium' && (
          <span className={styles.riskBadge} title={`Risk: ${task.risk_level}`}>
            {task.risk_level === 'high' ? '⚠' : '▽'} {task.risk_level}
          </span>
        )}
        {task.assigned_to && (
          <span className={styles.assignee}>
            <span className={styles.assigneeDot} style={{ background: BEAST_COLORS[task.assigned_to] || '#666' }} />
            {task.assigned_to}
          </span>
        )}
        {task.assigned_to && task.reviewer && (
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>·</span>
        )}
        {task.reviewer && (
          <span className={styles.assignee} title="Reviewer">
            <span className={styles.assigneeDot} style={{ background: BEAST_COLORS[task.reviewer] || '#666' }} />
            {task.reviewer}
          </span>
        )}
        {task.project_name && (
          <span className={styles.projectTag}>{task.project_name}</span>
        )}
      </div>
    </div>
  );
}

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'critical': return 'var(--danger)';
    case 'high': return 'var(--accent)';
    case 'medium': return 'var(--success)';
    case 'low': return 'var(--text-muted)';
    default: return 'var(--border)';
  }
}
