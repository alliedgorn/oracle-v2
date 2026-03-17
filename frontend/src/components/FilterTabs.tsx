import styles from './FilterTabs.module.css';

interface TabItem {
  id: string;
  label: string;
  count?: number;
}

interface FilterTabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  variant?: 'normal' | 'compact';
  className?: string;
}

export function FilterTabs({
  items,
  activeId,
  onChange,
  variant = 'normal',
  className,
}: FilterTabsProps) {
  return (
    <div className={`${styles.tabs} ${variant === 'compact' ? styles.compact : ''} ${className || ''}`}>
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          className={`${styles.tab} ${activeId === item.id ? styles.active : ''}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count != null && item.count > 0 && (
            <span className={styles.count}>{item.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
