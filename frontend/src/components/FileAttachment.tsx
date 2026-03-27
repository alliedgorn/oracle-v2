import styles from './FileAttachment.module.css';
import { formatFileSize } from './FileUpload';

interface FileAttachmentProps {
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

function getFileTypeIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['pdf', 'doc', 'docx'].includes(ext)) return '\u{1F4C4}';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '\u{1F4CA}';
  if (['txt', 'md', 'json'].includes(ext)) return '\u{1F4DD}';
  if (ext === 'zip') return '\u{1F4E6}';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return '\u{1F5BC}';
  return '\u{1F4CE}';
}

function getTypeBadge(name: string): string {
  const ext = name.split('.').pop()?.toUpperCase() || '';
  return ext || 'FILE';
}

export function FileAttachment({ originalName, sizeBytes, url }: FileAttachmentProps) {
  const icon = getFileTypeIcon(originalName);
  const badge = getTypeBadge(originalName);
  const truncatedName = originalName.length > 30
    ? originalName.slice(0, 27) + '...'
    : originalName;

  return (
    <a href={url} download={originalName} className={styles.attachment} title={originalName}>
      <span className={styles.icon}>{icon}</span>
      <span className={styles.name}>{truncatedName}</span>
      <span className={styles.badge}>{badge}</span>
      <span className={styles.size}>{formatFileSize(sizeBytes)}</span>
      <span className={styles.download}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </span>
    </a>
  );
}
