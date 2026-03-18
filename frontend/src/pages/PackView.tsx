import { useState, useEffect, useRef, useCallback } from 'react';
// Link removed — BeastCard handles name clicks
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import styles from './PackView.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';
import { BeastCard } from '../components/BeastCard';

interface Beast {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl: string | null;
  bio: string | null;
  themeColor: string | null;
  role: string | null;
  online: boolean;
  status: 'processing' | 'idle' | 'shell' | 'offline';
  sessionName: string;
}

const API_BASE = '/api';

export function PackView() {
  const [beasts, setBeasts] = useState<Beast[]>([]);
  const [selected, setSelected] = useState<Beast | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastContentRef = useRef<string>('');

  // Load beast list with online status
  const loadPack = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/pack`);
      const data = await res.json();
      setBeasts(data.beasts || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadPack();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadPack();
    }, 10000); // refresh online status every 10s
    return () => clearInterval(interval);
  }, [loadPack]);

  // Initialize terminal when a beast is selected
  useEffect(() => {
    if (!selected || !termRef.current) return;

    // Clean up previous terminal
    if (terminalRef.current) {
      terminalRef.current.dispose();
    }

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      cursorBlink: interactive,
      disableStdin: !interactive,
      scrollback: 500,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    // Small delay to let the DOM settle before fitting
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    // Wire up direct typing when interactive
    if (interactive && selected) {
      term.onData((data) => {
        // Send printable chars as literal input, special chars as keys
        const specialMap: Record<string, string> = {
          '\r': 'Enter', '\x1b': 'Escape', '\x7f': 'BSpace', '\t': 'Tab',
          '\x03': 'C-c', '\x04': 'C-d', '\x1a': 'C-z', '\x0c': 'C-l',
        };
        const arrowMap: Record<string, string> = {
          '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
        };

        if (arrowMap[data]) {
          fetch(`${API_BASE}/beast/${selected.name}/terminal/key`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: arrowMap[data] }),
          }).catch(() => {});
        } else if (specialMap[data]) {
          fetch(`${API_BASE}/beast/${selected.name}/terminal/key`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: specialMap[data] }),
          }).catch(() => {});
        } else {
          fetch(`${API_BASE}/beast/${selected.name}/terminal/input`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: data }),
          }).catch(() => {});
        }
      });
    }

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Poll faster in interactive mode, but skip when page is hidden
    const pollInterval = interactive ? 500 : 2000;
    fetchTerminal(selected.name, term);
    const poll = setInterval(() => {
      if (document.hidden) return;
      fetchTerminal(selected.name, term);
    }, pollInterval);
    pollRef.current = poll;

    return () => {
      clearInterval(poll);
      term.dispose();
      terminalRef.current = null;
      lastContentRef.current = ''; // Force re-render on next mount
    };
  }, [selected?.name, interactive]);

  // Handle window resize
  useEffect(() => {
    const onResize = () => {
      if (fitAddonRef.current) {
        try { fitAddonRef.current.fit(); } catch { /* ignore */ }
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  async function handleInputSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !inputValue.trim()) return;
    await fetch(`${API_BASE}/beast/${selected.name}/terminal/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: inputValue }),
    });
    await fetch(`${API_BASE}/beast/${selected.name}/terminal/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'Enter' }),
    });
    setInputValue('');
  }

  async function sendSpecialKey(key: string) {
    if (!selected) return;
    await fetch(`${API_BASE}/beast/${selected.name}/terminal/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  }

  async function fetchTerminal(name: string, term: Terminal) {
    try {
      const res = await fetch(`${API_BASE}/beast/${name}/terminal?rows=80`);
      const data = await res.json();
      if (data.content && data.content !== lastContentRef.current) {
        lastContentRef.current = data.content;
        term.reset();
        const lines = data.content.split('\n');
        for (const line of lines) {
          term.writeln(line);
        }
      }
    } catch { /* ignore */ }
  }

  function selectBeast(beast: Beast) {
    if (pollRef.current) clearInterval(pollRef.current);
    lastContentRef.current = '';
    setSelected(beast);
  }

  return (
    <div className={styles.container}>
      {/* Beast Grid */}
      <div className={styles.packGrid}>
        <h2 className={styles.title}>The Den</h2>
        <div className={styles.beastGrid}>
          {beasts.map(beast => (
            <BeastCard
              key={beast.name}
              {...beast}
              selected={selected?.name === beast.name}
              onClick={() => selectBeast(beast)}
              onNameClick={(e) => { e.stopPropagation(); window.location.href = `/beast/${beast.name}`; }}
            />
          ))}
        </div>
      </div>

      {/* Terminal Viewer */}
      <div className={styles.terminalPanel}>
        {selected ? (
          <>
            <div className={styles.terminalHeader}>
              <span className={styles.terminalTitle}>
                {ANIMAL_EMOJI[selected.animal?.toLowerCase()] || '🐾'}{' '}
                {selected.displayName}
                <span className={styles.terminalRole}> — {selected.role || selected.animal}</span>
              </span>
              <div className={styles.terminalControls}>
                <button
                  className={`${styles.interactiveToggle} ${interactive ? styles.toggleActive : ''}`}
                  onClick={() => setInteractive(!interactive)}
                  title={interactive ? 'Switch to view-only mode' : 'Enable interactive mode'}
                >
                  {interactive ? '⌨️ INTERACTIVE' : '👁️ VIEW'}
                </button>
                <span className={`${styles.terminalStatus} ${selected.status === 'processing' ? styles.statusProcessing : selected.status === 'idle' ? styles.statusIdle : selected.status === 'shell' ? styles.statusShell : styles.statusOffline}`}>
                  {selected.status === 'processing' ? 'PROCESSING' : selected.status === 'idle' ? 'IDLE' : selected.status === 'shell' ? 'SHELL' : 'OFFLINE'}
                </span>
              </div>
            </div>
            <div className={styles.terminalContainer} ref={termRef} />
            {interactive && selected.online && (
              <div className={styles.inputBar}>
                <div className={styles.specialKeys}>
                  <button onClick={() => sendSpecialKey('C-c')} className={styles.keyButton} title="Ctrl+C">^C</button>
                  <button onClick={() => sendSpecialKey('C-d')} className={styles.keyButton} title="Ctrl+D">^D</button>
                  <button onClick={() => sendSpecialKey('C-z')} className={styles.keyButton} title="Ctrl+Z">^Z</button>
                  <button onClick={() => sendSpecialKey('C-l')} className={styles.keyButton} title="Ctrl+L (clear)">^L</button>
                  <button onClick={() => sendSpecialKey('Tab')} className={styles.keyButton} title="Tab">Tab</button>
                  <button onClick={() => sendSpecialKey('Up')} className={styles.keyButton} title="Up arrow">↑</button>
                  <button onClick={() => sendSpecialKey('Down')} className={styles.keyButton} title="Down arrow">↓</button>
                </div>
                <form onSubmit={handleInputSubmit} className={styles.inputForm}>
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={e => setInputValue(e.target.value)}
                    placeholder="Type command and press Enter..."
                    className={styles.terminalInput}
                  />
                  <button type="submit" className={styles.sendButton}>Send</button>
                </form>
              </div>
            )}
          </>
        ) : (
          <div className={styles.terminalPlaceholder}>
            <div className={styles.placeholderContent}>
              <span className={styles.placeholderIcon}>🏔️</span>
              <p>Select a Beast to view their session</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
