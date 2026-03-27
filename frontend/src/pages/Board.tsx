import { useState, useEffect, useCallback } from 'react';
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
  created_at: string;
  updated_at: string;
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

const STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const;
const STATUS_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

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
  const [showNewTask, setShowNewTask] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskComments, setTaskComments] = useState<TaskComment[]>([]);
  const [beasts, setBeasts] = useState<{ name: string; displayName: string }[]>([]);

  // New task form
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPriority, setNewPriority] = useState('medium');
  const [newAssignee, setNewAssignee] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newStatus, setNewStatus] = useState('todo');

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
    fetch(`${API_BASE}/beasts`).then(r => r.json()).then(d => setBeasts(d.beasts || [])).catch(() => {});
  }, []);

  useEffect(() => {
    loadBoard();
  }, [projectFilter, assigneeFilter]);

  // ESC key closes modal
  useEffect(() => {
    if (!selectedTask) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedTask(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedTask]);

  // Poll for updates
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadBoard();
    }, 10000);
    return () => clearInterval(interval);
  }, [projectFilter, assigneeFilter]);

  // WebSocket real-time updates
  const handleWsUpdate = useCallback(() => {
    loadBoard();
  }, [projectFilter, assigneeFilter]);

  useWebSocket('task_created', handleWsUpdate);
  useWebSocket('task_updated', handleWsUpdate);
  useWebSocket('tasks_bulk_updated', handleWsUpdate);

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
    setBoard(data);
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    await fetch(`${API_BASE}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newTitle,
        description: newDesc,
        priority: newPriority,
        assigned_to: newAssignee || null,
        project_id: newProjectId ? parseInt(newProjectId, 10) : null,
        status: newStatus,
        created_by: 'gorn',
      }),
    });
    setNewTitle(''); setNewDesc(''); setNewPriority('medium');
    setNewAssignee(''); setNewProjectId(''); setNewStatus('todo');
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
    setTaskComments(data.comments || []);
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
    return Object.values(board.columns).flat();
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
          <input
            placeholder="Task title..."
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
            <select value={newAssignee} onChange={e => setNewAssignee(e.target.value)} className={styles.projectSelect}>
              <option value="">Unassigned</option>
              {beasts.map(b => <option key={b.name} value={b.name}>{b.displayName}</option>)}
              <option value="gorn">Gorn</option>
            </select>
            <select value={newProjectId} onChange={e => setNewProjectId(e.target.value)} className={styles.projectSelect} required>
              <option value="" disabled>Select Project</option>
              {board.projects.filter(p => p.status === 'active').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button type="submit" className={styles.newTaskBtn} disabled={!newTitle.trim() || !newProjectId}>Create</button>
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
            const tasks = board.columns[status] || [];
            return (
              <div key={status} className={styles.column}>
                <div className={styles.columnHeader}>
                  <span className={styles.columnTitle}>{STATUS_LABELS[status]}</span>
                  <span className={styles.columnCount}>{tasks.length}</span>
                </div>
                <div className={styles.columnBody}>
                  {tasks.length === 0 && (
                    <div className={styles.emptyColumn}>No tasks</div>
                  )}
                  {tasks.map(task => (
                    <TaskCard key={task.id} task={task} onClick={() => openTaskDetail(task)} />
                  ))}
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
              <h2>{selectedTask.title}</h2>
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

              {selectedTask.description && (
                <div className={styles.taskDescription}>
                  <ReactMarkdown>{autolinkIds(selectedTask.description)}</ReactMarkdown>
                </div>
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
function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <div
      className={styles.taskCard}
      style={{ '--priority-color': getPriorityColor(task.priority) } as React.CSSProperties}
      onClick={onClick}
    >
      <span className={styles.taskId}>#{task.id}</span>
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
        {task.assigned_to && (
          <span className={styles.assignee}>
            <span className={styles.assigneeDot} style={{ background: BEAST_COLORS[task.assigned_to] || '#666' }} />
            {task.assigned_to}
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
