import { useState, useEffect, useRef } from 'react';
import styles from './GuestSettings.module.css';

interface GuestProfile {
  username: string;
  display_name: string | null;
  bio: string | null;
  interests: string | null;
  avatar_url: string | null;
  created_at: string;
  expires_at: string | null;
}

export function GuestSettings() {
  const [profile, setProfile] = useState<GuestProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Profile form
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [interests, setInterests] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Avatar
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      const res = await fetch('/api/guest/profile');
      if (res.ok) {
        const data = await res.json();
        setProfile(data);
        setDisplayName(data.display_name || '');
        setBio(data.bio || '');
        setInterests(data.interests || '');
      }
    } catch {}
    setLoading(false);
  }

  async function saveProfile() {
    setSavingProfile(true);
    setMessage(null);
    try {
      const res = await fetch('/api/guest/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName, bio, interests }),
      });
      const data = await res.json();
      if (res.ok) {
        setProfile(prev => prev ? { ...prev, ...data } : prev);
        setMessage({ type: 'success', text: 'Profile updated' });
      } else {
        setMessage({ type: 'error', text: data.error || 'Failed to update profile' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    }
    setSavingProfile(false);
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/guest/avatar', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        setProfile(prev => prev ? { ...prev, avatar_url: data.avatar_url } : prev);
        setMessage({ type: 'success', text: 'Avatar updated' });
      } else {
        setMessage({ type: 'error', text: data.error || 'Upload failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Upload failed' });
    }
    setUploadingAvatar(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: 'Passwords do not match' });
      return;
    }
    setSavingPassword(true);
    setMessage(null);
    try {
      const res = await fetch('/api/guest/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: 'Password changed' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setMessage({ type: 'error', text: data.error || 'Failed to change password' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    }
    setSavingPassword(false);
  }

  if (loading) return <div className={styles.container}><p className={styles.loading}>Loading...</p></div>;

  const avatarLetter = (profile?.display_name || profile?.username || '?')[0].toUpperCase();

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Settings</h1>
      <p className={styles.subtitle}>Manage your guest profile</p>

      {message && (
        <div className={`${styles.message} ${styles[message.type]}`}>{message.text}</div>
      )}

      {/* Profile Section */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Profile</h2>

        <div className={styles.avatarRow}>
          <div
            className={styles.avatar}
            onClick={() => fileInputRef.current?.click()}
            title="Click to change avatar"
          >
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="Avatar" className={styles.avatarImg} />
            ) : (
              <span className={styles.avatarLetter}>{avatarLetter}</span>
            )}
            <div className={styles.avatarOverlay}>{uploadingAvatar ? '...' : 'Edit'}</div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleAvatarUpload}
            style={{ display: 'none' }}
          />
          <div className={styles.avatarHint}>Click to upload (jpg, png, webp, max 2MB)</div>
        </div>

        <label className={styles.label}>
          Username
          <input type="text" value={profile?.username || ''} disabled className={styles.input} />
        </label>

        <label className={styles.label}>
          Display Name
          <input
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            className={styles.input}
            maxLength={50}
          />
        </label>

        <label className={styles.label}>
          Bio
          <textarea
            value={bio}
            onChange={e => setBio(e.target.value)}
            className={styles.textarea}
            rows={3}
            maxLength={500}
            placeholder="Tell the pack about yourself"
          />
        </label>

        <label className={styles.label}>
          Interests
          <input
            type="text"
            value={interests}
            onChange={e => setInterests(e.target.value)}
            className={styles.input}
            maxLength={300}
            placeholder="What are you into?"
          />
        </label>

        <button className={styles.saveButton} onClick={saveProfile} disabled={savingProfile}>
          {savingProfile ? 'Saving...' : 'Save Profile'}
        </button>
      </div>

      {/* Account Section */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Change Password</h2>

        <label className={styles.label}>
          Current Password
          <input
            type="password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            className={styles.input}
          />
        </label>

        <label className={styles.label}>
          New Password
          <input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            className={styles.input}
          />
        </label>

        <label className={styles.label}>
          Confirm New Password
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            className={styles.input}
          />
        </label>

        <button className={styles.saveButton} onClick={changePassword} disabled={savingPassword}>
          {savingPassword ? 'Changing...' : 'Change Password'}
        </button>
      </div>
    </div>
  );
}
