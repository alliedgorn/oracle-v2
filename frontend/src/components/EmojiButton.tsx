import { useState, useRef, useEffect } from 'react';
import styles from './EmojiButton.module.css';

const EMOJI_GROUPS = [
  { label: 'Faces', emojis: ['😀','😂','🥹','😍','🤔','😎','🫡','😤','🤯','🥳','😴','🤓'] },
  { label: 'Hands', emojis: ['👍','👎','👏','🙌','🤝','✌️','🤞','💪','🫶','👋'] },
  { label: 'Objects', emojis: ['🔥','✅','❌','⚠️','💡','🎯','🚀','🏆','📌','🔧','📋','🐛'] },
  { label: 'Animals', emojis: ['🐾','🦛','🐊','🐻','🦝','🦘','🐺','🦉','🦅','🐍','🦔','🦨'] },
];

interface EmojiButtonProps {
  onSelect: (emoji: string) => void;
}

export function EmojiButton({ onSelect }: EmojiButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pickerStyle, setPickerStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      const pickerHeight = 320;

      if (spaceAbove > pickerHeight || spaceAbove > spaceBelow) {
        // Open above
        setPickerStyle({
          position: 'fixed',
          bottom: window.innerHeight - rect.top + 4,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
        });
      } else {
        // Open below
        setPickerStyle({
          position: 'fixed',
          top: rect.bottom + 4,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
        });
      }
    }
  }, [open]);

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        title="Insert emoji"
      >😊</button>
      {open && (
        <div className={styles.picker} style={pickerStyle}>
          {EMOJI_GROUPS.map(g => (
            <div key={g.label} className={styles.group}>
              <div className={styles.groupLabel}>{g.label}</div>
              <div className={styles.grid}>
                {g.emojis.map(e => (
                  <button
                    key={e}
                    type="button"
                    className={styles.emoji}
                    onClick={() => { onSelect(e); setOpen(false); }}
                  >{e}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
