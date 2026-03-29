import { createContext, useContext, useState, useCallback, useRef } from 'react';

interface ChatTarget {
  beastName: string;
  displayName: string;
}

interface ChatContextType {
  chatTarget: ChatTarget | null;
  collapsed: boolean;
  openChat: (beastName: string, displayName: string) => void;
  closeChat: () => void;
  toggleCollapse: () => void;
}

const ChatContext = createContext<ChatContextType>({
  chatTarget: null,
  collapsed: false,
  openChat: () => {},
  closeChat: () => {},
  toggleCollapse: () => {},
});

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(() => {
    const stored = localStorage.getItem('chatBeast');
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch { /* ignore */ }
    }
    return null;
  });
  const [collapsed, setCollapsedRaw] = useState(() => localStorage.getItem('chat-overlay-collapsed') === 'true');
  const chatTargetRef = useRef(chatTarget);
  chatTargetRef.current = chatTarget;

  const setCollapsed = useCallback((val: boolean | ((prev: boolean) => boolean)) => {
    setCollapsedRaw(prev => {
      const next = typeof val === 'function' ? val(prev) : val;
      localStorage.setItem('chat-overlay-collapsed', String(next));
      return next;
    });
  }, []);

  const openChat = useCallback((beastName: string, displayName: string) => {
    const current = chatTargetRef.current;
    if (current && current.beastName === beastName) {
      // Same beast: toggle collapsed
      setCollapsed(prev => !prev);
    } else {
      // Different beast or no chat open: switch and expand
      const target = { beastName, displayName };
      setChatTarget(target);
      setCollapsed(false);
      localStorage.setItem('chatBeast', JSON.stringify(target));
    }
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => !prev);
  }, []);

  const closeChat = useCallback(() => {
    setChatTarget(null);
    setCollapsed(false);
    localStorage.removeItem('chatBeast');
  }, []);

  return (
    <ChatContext.Provider value={{ chatTarget, collapsed, openChat, closeChat, toggleCollapse }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
