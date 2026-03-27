import { useState, useRef, useEffect } from 'react';
import styles from './FileUpload.module.css';

interface StagedFile {
  file: File;
  previewUrl: string | null;
  isImage: boolean;
}

interface FileUploadProps {
  onUploadComplete: (markdownOrLink: string) => void;
}

const API_BASE = '/api';
const MAX_WIDTH = 800;
const QUALITY = 0.75;

const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp',
  'pdf', 'txt', 'md', 'csv', 'json',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip',
]);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const ACCEPT_STRING = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
].join(',');

function getFileExtension(name: string): string {
  const parts = name.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

function isImageFile(file: File): boolean {
  return IMAGE_TYPES.has(file.type);
}

function getFileIcon(file: File): string {
  const ext = getFileExtension(file.name);
  if (['pdf', 'doc', 'docx'].includes(ext)) return '\u{1F4C4}';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '\u{1F4CA}';
  if (['txt', 'md', 'json'].includes(ext)) return '\u{1F4DD}';
  if (ext === 'zip') return '\u{1F4E6}';
  return '\u{1F4CE}';
}

function isAllowedFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  // Reject double extensions
  const dots = file.name.split('.').length - 1;
  if (dots > 1) return false;
  return true;
}

function compressImage(file: File): Promise<File> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/') || file.type === 'image/gif') {
      resolve(file);
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (img.width <= MAX_WIDTH) {
        resolve(file);
        return;
      }
      const canvas = document.createElement('canvas');
      const scale = MAX_WIDTH / img.width;
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob && blob.size < file.size) {
          resolve(new File([blob], file.name, { type: 'image/jpeg' }));
        } else {
          resolve(file);
        }
      }, 'image/jpeg', QUALITY);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function FileUpload({ onUploadComplete }: FileUploadProps) {
  const [staged, setStaged] = useState<StagedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Clipboard paste support — only when focus is within the same form/container
  const containerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    function handlePaste(e: ClipboardEvent) {
      // Only handle paste if focus is within this component's parent form/container
      const form = containerRef.current?.closest('form') || containerRef.current?.closest('[class*="overlay"]');
      if (form && !form.contains(document.activeElement)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) handleFile(file);
          break;
        }
      }
    }
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  // Drag-over detection on document
  useEffect(() => {
    let dragCounter = 0;
    function handleDragEnter(e: DragEvent) {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) setDragging(true);
    }
    function handleDragLeave(e: DragEvent) {
      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0) setDragging(false);
    }
    function handleDragOver(e: DragEvent) {
      e.preventDefault();
    }
    function handleDrop(e: DragEvent) {
      e.preventDefault();
      dragCounter = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    }
    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);
    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
    };
  }, []);

  function handleFile(file: File) {
    setError(null);
    if (!isAllowedFile(file)) {
      setError(`File type not allowed: .${getFileExtension(file.name)}`);
      return;
    }
    const isImg = isImageFile(file);
    const previewUrl = isImg ? URL.createObjectURL(file) : null;
    setStaged({ file, previewUrl, isImage: isImg });
    autoUpload(file);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    handleFile(file);
  }

  async function autoUpload(file: File) {
    setUploading(true);
    setProgress(0);
    try {
      const toUpload = isImageFile(file) ? await compressImage(file) : file;
      const formData = new FormData();
      formData.append('file', toUpload);

      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };

      const result = await new Promise<{ url?: string; filename?: string }>((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.open('POST', `${API_BASE}/upload`);
        xhr.send(formData);
      });

      if (result.url) {
        if (isImageFile(file)) {
          onUploadComplete(`![${file.name}](${result.url})`);
        } else {
          onUploadComplete(`[${getFileIcon(file)} ${file.name}](${result.url})`);
        }
        clearStaged();
      }
    } catch {
      setError('Upload failed. Please try again.');
    }
    setUploading(false);
    setProgress(0);
  }

  function clearStaged() {
    if (staged?.previewUrl) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <>
      {dragging && (
        <div className={styles.dropOverlay}>
          <div className={styles.dropZone}>
            <span className={styles.dropIcon}>{'\u{1F4CE}'}</span>
            <span>Drop file to attach</span>
          </div>
        </div>
      )}

      {error && (
        <div className={styles.error}>
          {error}
          <button className={styles.errorDismiss} onClick={() => setError(null)}>{'\u2715'}</button>
        </div>
      )}

      {staged && (
        <div className={styles.preview}>
          {staged.isImage && staged.previewUrl ? (
            <img src={staged.previewUrl} alt="Preview" className={styles.thumbnail} />
          ) : (
            <span className={styles.fileIcon}>{getFileIcon(staged.file)}</span>
          )}
          <span className={styles.fileName}>{staged.file.name}</span>
          <span className={styles.fileSize}>{formatFileSize(staged.file.size)}</span>
          {uploading ? (
            <div className={styles.progressContainer}>
              <div className={styles.progressBar} style={{ width: `${progress}%` }} />
              <span className={styles.progressText}>{progress}%</span>
            </div>
          ) : (
            <button className={styles.removeBtn} onClick={clearStaged} title="Remove">{'\u2715'}</button>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_STRING}
        className={styles.fileInput}
        onChange={handleFileSelect}
      />

      <button
        type="button"
        ref={el => { containerRef.current = el; }}
        className={`${styles.uploadBtn} ${uploading ? styles.uploading : ''}`}
        onClick={() => fileRef.current?.click()}
        title="Attach file"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
    </>
  );
}
