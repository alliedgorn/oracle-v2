import type { FormEvent } from 'react';
import styles from './SearchInput.module.css';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onClear?: () => void;
  onSubmit?: (e: FormEvent) => void;
  showClear?: boolean;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  onClear,
  onSubmit,
  showClear = false,
  className,
}: SearchInputProps) {
  const input = (
    <div className={`${styles.wrapper} ${className || ''}`}>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={styles.input}
      />
      {showClear && onClear && (
        <button type="button" className={styles.clearButton} onClick={onClear}>
          ✕
        </button>
      )}
    </div>
  );

  if (onSubmit) {
    return (
      <form onSubmit={onSubmit}>
        {input}
      </form>
    );
  }

  return input;
}
