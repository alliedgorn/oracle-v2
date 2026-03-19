import { useState, useEffect } from 'react';
import styles from './Teams.module.css';

interface Team {
  id: number;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  member_count: number;
  members?: { beast: string; role: string; joined_at: string }[];
}

const API_BASE = '/api';

export function Teams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newMember, setNewMember] = useState('');

  async function loadTeams() {
    try {
      const res = await fetch(`${API_BASE}/teams`);
      const data = await res.json();
      setTeams(data.teams || []);
    } catch { setTeams([]); }
    setLoading(false);
  }

  async function loadTeamDetail(id: number) {
    const res = await fetch(`${API_BASE}/teams/${id}`);
    const data = await res.json();
    setSelectedTeam(data);
  }

  useEffect(() => { loadTeams(); }, []);

  async function createTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    await fetch(`${API_BASE}/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, description: newDesc || null, created_by: 'gorn' }),
    });
    setNewName('');
    setNewDesc('');
    setShowCreate(false);
    loadTeams();
  }

  async function addMember(teamId: number) {
    if (!newMember.trim()) return;
    const res = await fetch(`${API_BASE}/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beast: newMember.toLowerCase() }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    setNewMember('');
    loadTeamDetail(teamId);
  }

  async function removeMember(teamId: number, beast: string) {
    await fetch(`${API_BASE}/teams/${teamId}/members/${beast}`, { method: 'DELETE' });
    loadTeamDetail(teamId);
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Teams</h1>
        <button className={styles.createBtn} onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : '+ New Team'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={createTeam} className={styles.createForm}>
          <input
            placeholder="Team name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            className={styles.input}
          />
          <input
            placeholder="Description (optional)"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            className={styles.input}
          />
          <button type="submit" className={styles.submitBtn}>Create</button>
        </form>
      )}

      {loading ? (
        <div className={styles.empty}>Loading...</div>
      ) : teams.length === 0 ? (
        <div className={styles.empty}>No teams yet</div>
      ) : (
        <div className={styles.grid}>
          {teams.map(team => (
            <div
              key={team.id}
              className={`${styles.card} ${selectedTeam?.id === team.id ? styles.selected : ''}`}
              onClick={() => loadTeamDetail(team.id)}
            >
              <div className={styles.cardHeader}>
                <h3 className={styles.teamName}>{team.name}</h3>
                <span className={styles.memberCount}>{team.member_count} members</span>
              </div>
              {team.description && <p className={styles.desc}>{team.description}</p>}
              <div className={styles.cardMeta}>Created by {team.created_by}</div>
            </div>
          ))}
        </div>
      )}

      {selectedTeam && (
        <div className={styles.detail}>
          <div className={styles.detailHeader}>
            <h2>{selectedTeam.name}</h2>
            <button className={styles.closeBtn} onClick={() => setSelectedTeam(null)}>Close</button>
          </div>
          {selectedTeam.description && <p className={styles.detailDesc}>{selectedTeam.description}</p>}

          <h3>Members</h3>
          <div className={styles.memberList}>
            {selectedTeam.members?.map(m => (
              <div key={m.beast} className={styles.member}>
                <span className={styles.memberName}>{m.beast}</span>
                <span className={styles.memberRole}>{m.role}</span>
                <button className={styles.removeBtn} onClick={() => removeMember(selectedTeam.id, m.beast)}>Remove</button>
              </div>
            ))}
          </div>

          <div className={styles.addMember}>
            <input
              placeholder="Beast name"
              value={newMember}
              onChange={e => setNewMember(e.target.value)}
              className={styles.input}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMember(selectedTeam.id); } }}
            />
            <button className={styles.addBtn} onClick={() => addMember(selectedTeam.id)}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}
