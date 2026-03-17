import { useState, useEffect } from 'react';
import styles from './Groups.module.css';

interface Group {
  id: number;
  name: string;
  description: string | null;
  created_by: string | null;
  members: string[];
  member_count: number;
  created_at: string;
}

interface Beast {
  name: string;
  displayName: string;
}

const API_BASE = '/api';

export function Groups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [beasts, setBeasts] = useState<Beast[]>([]);
  const [selected, setSelected] = useState<Group | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadGroups();
    fetch(`${API_BASE}/beasts`).then(r => r.json()).then(d => setBeasts(d.beasts || [])).catch(() => {});
  }, []);

  async function loadGroups() {
    const res = await fetch(`${API_BASE}/groups`);
    const data = await res.json();
    setGroups(data.groups || []);
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setLoading(true);
    try {
      await fetch(`${API_BASE}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null }),
      });
      setNewName('');
      setNewDesc('');
      setShowCreate(false);
      await loadGroups();
    } finally {
      setLoading(false);
    }
  }

  async function addMember(groupName: string, beastName: string) {
    await fetch(`${API_BASE}/group/${groupName}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beast: beastName }),
    });
    await loadGroups();
    // Refresh selected
    const res = await fetch(`${API_BASE}/group/${groupName}`);
    const data = await res.json();
    setSelected({ ...data, members: data.members, member_count: data.members.length });
  }

  async function removeMember(groupName: string, beastName: string) {
    await fetch(`${API_BASE}/group/${groupName}/members/${beastName}`, { method: 'DELETE' });
    await loadGroups();
    const res = await fetch(`${API_BASE}/group/${groupName}`);
    const data = await res.json();
    setSelected({ ...data, members: data.members, member_count: data.members.length });
  }

  async function deleteGroup(groupName: string) {
    await fetch(`${API_BASE}/group/${groupName}`, { method: 'DELETE' });
    setSelected(null);
    await loadGroups();
  }

  function selectGroup(group: Group) {
    setSelected(group);
    setShowCreate(false);
  }

  const nonMembers = selected ? beasts.filter(b => !selected.members.includes(b.name)) : [];

  return (
    <div className={styles.container}>
      {/* Sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2>Groups</h2>
          <button className={styles.createBtn} onClick={() => { setShowCreate(true); setSelected(null); }}>
            + Create
          </button>
        </div>

        <div className={styles.groupList}>
          {groups.map(g => (
            <div
              key={g.id}
              className={`${styles.groupItem} ${selected?.id === g.id ? styles.active : ''}`}
              onClick={() => selectGroup(g)}
            >
              <div className={styles.groupName}>@{g.name}</div>
              <div className={styles.groupMeta}>
                {g.member_count} members
              </div>
            </div>
          ))}
          {groups.length === 0 && <div className={styles.empty}>No groups yet</div>}
        </div>
      </div>

      {/* Main */}
      <div className={styles.main}>
        {showCreate && (
          <div className={styles.createForm}>
            <h2>Create Group</h2>
            <form onSubmit={createGroup}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Name</label>
                <input
                  className={styles.formInput}
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. frontend, devops, oncall"
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Description</label>
                <input
                  className={styles.formInput}
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  placeholder="What is this group for?"
                />
              </div>
              <div className={styles.formActions}>
                <button type="submit" className={styles.saveBtn} disabled={loading || !newName.trim()}>
                  {loading ? 'Creating...' : 'Create Group'}
                </button>
                <button type="button" className={styles.cancelBtn} onClick={() => setShowCreate(false)}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        {selected && (
          <div className={styles.groupDetail}>
            <div className={styles.detailHeader}>
              <div>
                <h2>@{selected.name}</h2>
                {selected.description && <p className={styles.detailDesc}>{selected.description}</p>}
              </div>
              <button className={styles.deleteBtn} onClick={() => deleteGroup(selected.name)}>Delete Group</button>
            </div>

            <div className={styles.membersSection}>
              <h3>Members ({selected.members.length})</h3>
              <div className={styles.memberList}>
                {selected.members.map(name => (
                  <div key={name} className={styles.memberItem}>
                    <span className={styles.memberName}>{name}</span>
                    <button
                      className={styles.removeBtn}
                      onClick={() => removeMember(selected.name, name)}
                    >Remove</button>
                  </div>
                ))}
                {selected.members.length === 0 && <div className={styles.empty}>No members</div>}
              </div>
            </div>

            {nonMembers.length > 0 && (
              <div className={styles.addSection}>
                <h3>Add Members</h3>
                <div className={styles.addList}>
                  {nonMembers.map(b => (
                    <button
                      key={b.name}
                      className={styles.addBtn}
                      onClick={() => addMember(selected.name, b.name)}
                    >
                      + {b.displayName}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!showCreate && !selected && (
          <div className={styles.placeholder}>
            <p>Select a group or create a new one</p>
          </div>
        )}
      </div>
    </div>
  );
}
