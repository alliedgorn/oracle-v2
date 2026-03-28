import { useState, useEffect, useCallback } from 'react';
import styles from './PhotosTab.module.css';

const API_BASE = '/api';

interface Photo {
  id: number;
  logged_at: string;
  data: {
    url: string;
    tag?: 'front' | 'side' | 'back' | string;
    notes?: string;
  };
}

interface PhotoGroup {
  date: string;
  label: string;
  photos: Photo[];
}

function parseData(raw: any): Photo['data'] {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { url: '' }; }
}

function groupByDate(photos: Photo[]): PhotoGroup[] {
  const groups: Record<string, Photo[]> = {};
  for (const p of photos) {
    const date = new Date(p.logged_at).toISOString().slice(0, 10);
    if (!groups[date]) groups[date] = [];
    groups[date].push(p);
  }
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, photos]) => ({
      date,
      label: date === today ? 'Today' : date === yesterday ? 'Yesterday' : new Date(date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      photos,
    }));
}

function TagBadge({ tag }: { tag?: string }) {
  if (!tag) return null;
  return <span className={styles.tag}>{tag.charAt(0).toUpperCase() + tag.slice(1)}</span>;
}

export function PhotosTab() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<Photo | null>(null);
  const [compare, setCompare] = useState<{ left: Photo | null; right: Photo | null; picking: 'left' | 'right' | null }>({ left: null, right: null, picking: null });
  const [tagFilter, setTagFilter] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadTag, setUploadTag] = useState('');
  const PAGE_SIZE = 30;

  const loadPhotos = useCallback(async (append = false) => {
    const params = new URLSearchParams({ type: 'photo', limit: String(PAGE_SIZE) });
    if (append) params.set('offset', String(photos.length));
    const res = await fetch(`${API_BASE}/routine/logs?${params}`);
    const data = await res.json();
    let logs = (data.logs || []).map((log: any) => ({
      ...log,
      data: parseData(log.data),
    }));
    // Client-side tag filter (API may not support tag param)
    if (tagFilter) {
      logs = logs.filter((p: Photo) => p.data.tag === tagFilter);
    }
    if (append) {
      setPhotos(prev => [...prev, ...logs]);
    } else {
      setPhotos(logs);
    }
    setHasMore(logs.length >= PAGE_SIZE);
    setLoading(false);
  }, [tagFilter]);

  useEffect(() => {
    setLoading(true);
    loadPhotos();
  }, [loadPhotos]);

  async function handleUpload(file: File, tag?: string) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (tag) fd.append('tag', tag);
      await fetch(`${API_BASE}/routine/photo/upload`, { method: 'POST', body: fd });
      loadPhotos();
    } catch { /* ignore */ }
    setUploading(false);
  }

  async function handleDelete(id: number) {
    await fetch(`${API_BASE}/routine/logs/${id}`, { method: 'DELETE' });
    setPhotos(prev => prev.filter(p => p.id !== id));
    if (lightbox?.id === id) setLightbox(null);
  }

  function handlePhotoClick(photo: Photo) {
    if (compare.picking) {
      if (compare.picking === 'left') {
        setCompare(prev => ({ ...prev, left: photo, picking: prev.right ? null : 'right' }));
      } else {
        setCompare(prev => ({ ...prev, right: photo, picking: null }));
      }
    } else {
      setLightbox(photo);
    }
  }

  function navigateLightbox(dir: -1 | 1) {
    if (!lightbox) return;
    const idx = photos.findIndex(p => p.id === lightbox.id);
    const next = photos[idx + dir];
    if (next) setLightbox(next);
  }

  const groups = groupByDate(photos);
  const isComparing = compare.left && compare.right;

  return (
    <div className={styles.container}>
      {/* Header: title + upload + compare toggle */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h3>Progress Photos</h3>
          <div className={styles.filters}>
            {['', 'front', 'side', 'back'].map(t => (
              <button
                key={t}
                className={`${styles.filterBtn} ${tagFilter === t ? styles.filterActive : ''}`}
                onClick={() => setTagFilter(t)}
              >
                {t || 'All'}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.actions}>
          <button
            className={`${styles.compareBtn} ${compare.picking ? styles.comparePicking : ''}`}
            onClick={() => {
              if (compare.picking || isComparing) {
                setCompare({ left: null, right: null, picking: null });
              } else {
                setCompare({ left: null, right: null, picking: 'left' });
              }
            }}
          >
            {isComparing ? 'Exit Compare' : compare.picking ? 'Cancel' : 'Compare'}
          </button>
          <label className={styles.uploadBtn}>
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setPendingFile(file);
                  setUploadTag('');
                }
                e.target.value = '';
              }}
              disabled={uploading}
            />
            {uploading ? 'Uploading...' : '+ Add'}
          </label>
        </div>
      </div>

      {/* Upload tag selector */}
      {pendingFile && (
        <div className={styles.compareHint} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 13 }}>Tag this photo:</span>
          <div className={styles.filters}>
            {['', 'front', 'side', 'back'].map(t => (
              <button
                key={t}
                className={`${styles.filterBtn} ${uploadTag === t ? styles.filterActive : ''}`}
                onClick={() => setUploadTag(t)}
              >
                {t || 'None'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={styles.uploadBtn}
              onClick={async () => {
                await handleUpload(pendingFile, uploadTag || undefined);
                setPendingFile(null);
                setUploadTag('');
              }}
              disabled={uploading}
              style={{ cursor: 'pointer' }}
            >
              {uploading ? 'Uploading...' : 'Upload'}
            </button>
            <button
              className={styles.compareBtn}
              onClick={() => { setPendingFile(null); setUploadTag(''); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Compare picking hint */}
      {compare.picking && (
        <div className={styles.compareHint}>
          Select {compare.picking === 'left' ? 'first' : 'second'} photo to compare
          {compare.left && <span> — first: {new Date(compare.left.logged_at).toLocaleDateString()}</span>}
        </div>
      )}

      {/* Compare view */}
      {isComparing && (
        <div className={styles.compareView}>
          <div className={styles.compareSide}>
            <img src={compare.left!.data.url} alt="Before" className={styles.compareImg} />
            <div className={styles.compareMeta}>
              {new Date(compare.left!.logged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {compare.left!.data.tag && <TagBadge tag={compare.left!.data.tag} />}
            </div>
          </div>
          <div className={styles.compareDivider} />
          <div className={styles.compareSide}>
            <img src={compare.right!.data.url} alt="After" className={styles.compareImg} />
            <div className={styles.compareMeta}>
              {new Date(compare.right!.logged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {compare.right!.data.tag && <TagBadge tag={compare.right!.data.tag} />}
            </div>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && <div className={styles.empty}>Loading photos...</div>}

      {/* Empty state */}
      {!loading && photos.length === 0 && (
        <div className={styles.empty}>
          No progress photos yet. Tap "+ Add" to upload your first.
        </div>
      )}

      {/* Photo grid grouped by date */}
      {!isComparing && groups.map(group => (
        <div key={group.date} className={styles.dateGroup}>
          <div className={styles.dateLabel}>{group.label}</div>
          <div className={styles.grid}>
            {group.photos.map(photo => (
              <div
                key={photo.id}
                className={`${styles.gridItem} ${compare.picking ? styles.gridItemSelectable : ''} ${compare.left?.id === photo.id || compare.right?.id === photo.id ? styles.gridItemSelected : ''}`}
                onClick={() => handlePhotoClick(photo)}
              >
                <img
                  src={photo.data.url}
                  alt={photo.data.tag || 'Progress photo'}
                  className={styles.gridImg}
                  loading="lazy"
                />
                {photo.data.tag && <TagBadge tag={photo.data.tag} />}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Load more */}
      {!loading && hasMore && !isComparing && (
        <button className={styles.loadMore} onClick={() => loadPhotos(true)}>
          Load more
        </button>
      )}

      {/* Lightbox */}
      {lightbox && !compare.picking && (
        <div className={styles.lightbox} onClick={() => setLightbox(null)}>
          <div className={styles.lightboxContent} onClick={e => e.stopPropagation()}>
            <button className={styles.lightboxClose} onClick={() => setLightbox(null)}>x</button>
            <button
              className={`${styles.lightboxNav} ${styles.lightboxPrev}`}
              onClick={() => navigateLightbox(-1)}
              disabled={photos.findIndex(p => p.id === lightbox.id) === 0}
            >
              &lt;
            </button>
            <img src={lightbox.data.url} alt={lightbox.data.tag || 'Photo'} className={styles.lightboxImg} />
            <button
              className={`${styles.lightboxNav} ${styles.lightboxNext}`}
              onClick={() => navigateLightbox(1)}
              disabled={photos.findIndex(p => p.id === lightbox.id) === photos.length - 1}
            >
              &gt;
            </button>
            <div className={styles.lightboxMeta}>
              <span className={styles.lightboxDate}>
                {new Date(lightbox.logged_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              {lightbox.data.tag && <TagBadge tag={lightbox.data.tag} />}
              {lightbox.data.notes && <span className={styles.lightboxNotes}>{lightbox.data.notes}</span>}
              <button className={styles.deleteBtn} onClick={() => handleDelete(lightbox.id)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
