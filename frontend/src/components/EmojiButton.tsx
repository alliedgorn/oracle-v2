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

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        title="Insert emoji"
      >😊</button>
      {open && (
        <div className={styles.picker}>
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
