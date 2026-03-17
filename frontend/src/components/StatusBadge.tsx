import styles from './StatusBadge.module.css';

const STATUS_VAR: Record<string, string> = {
  active: '--status-active',
  pending: '--status-pending',
  answered: '--status-answered',
  closed: '--status-closed',
};

function getStatusColor(status: string): string {
  const varName = STATUS_VAR[status];
  if (varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }
  return getComputedStyle(document.documentElement).getPropertyValue('--status-closed').trim();
}

interface StatusBadgeProps {
  status: string;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <span
      className={`${styles.badge} ${className || ''}`}
      style={{ backgroundColor: getStatusColor(status) }}
    >
      {label || status}
    </span>
  );
}
