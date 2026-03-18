import { useState, useRef, useEffect } from 'react';
import styles from './ImageUpload.module.css';

interface StagedImage {
  file: File;
  previewUrl: string;
}

interface ImageUploadProps {
  onUploadComplete: (markdownUrl: string) => void;
}

const API_BASE = '/api';

export function ImageUpload({ onUploadComplete }: ImageUploadProps) {
  const [staged, setStaged] = useState<StagedImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Clipboard paste support
  useEffect(() => {
    function handlePaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const previewUrl = URL.createObjectURL(file);
            setStaged({ file, previewUrl });
            autoUpload(file, previewUrl);
          }
          break;
        }
      }
    }
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;

    const previewUrl = URL.createObjectURL(file);
    setStaged({ file, previewUrl });

    // Auto-upload immediately
    autoUpload(file, previewUrl);
  }

  async function autoUpload(file: File, previewUrl: string) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (data.url) {
        onUploadComplete(`![${file.name}](${data.url})`);
        URL.revokeObjectURL(previewUrl);
        setStaged(null);
        if (fileRef.current) fileRef.current.value = '';
      }
    } catch { /* ignore */ }
    setUploading(false);
  }

  async function handleUpload() {
    if (!staged || uploading) return;
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', staged.file);

      const res = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (data.url) {
        onUploadComplete(`![${staged.file.name}](${data.url})`);
        clearStaged();
      }
    } catch {
      /* ignore */
    }
    setUploading(false);
  }

  function clearStaged() {
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  return (
    <>
      {staged && (
        <div className={styles.preview}>
          <img src={staged.previewUrl} alt="Preview" className={styles.thumbnail} />
          <span className={styles.fileName}>{staged.file.name}</span>
          <span className={styles.fileSize}>{formatSize(staged.file.size)}</span>
          {uploading ? (
            <span className={styles.progress}>Uploading...</span>
          ) : (
            <button className={styles.removeBtn} onClick={clearStaged} title="Remove">✕</button>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className={styles.fileInput}
        onChange={handleFileSelect}
      />

      <button
        type="button"
        className={`${styles.uploadBtn} ${uploading ? styles.uploading : ''}`}
        onClick={() => {
          if (staged) {
            handleUpload();
          } else {
            fileRef.current?.click();
          }
        }}
        title={staged ? 'Upload image' : 'Attach image'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {staged ? (
            <><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></>
          ) : (
            <><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>
          )}
        </svg>
      </button>
    </>
  );
}
