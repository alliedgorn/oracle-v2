import { createContext, useContext, useState, useCallback } from 'react';

interface ChatTarget {
  beastName: string;
  displayName: string;
}

interface ChatContextType {
  chatTarget: ChatTarget | null;
  openChat: (beastName: string, displayName: string) => void;
  closeChat: () => void;
  expandSignal: number;
}

const ChatContext = createContext<ChatContextType>({
  chatTarget: null,
  openChat: () => {},
  closeChat: () => {},
  expandSignal: 0,
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
  const [expandSignal, setExpandSignal] = useState(0);

  const openChat = useCallback((beastName: string, displayName: string) => {
    const target = { beastName, displayName };
    setChatTarget(target);
    setExpandSignal(s => s + 1);
    localStorage.setItem('chatBeast', JSON.stringify(target));
  }, []);

  const closeChat = useCallback(() => {
    setChatTarget(null);
    localStorage.removeItem('chatBeast');
  }, []);

  return (
    <ChatContext.Provider value={{ chatTarget, openChat, closeChat, expandSignal }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
