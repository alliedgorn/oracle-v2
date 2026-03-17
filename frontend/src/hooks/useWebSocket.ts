import { useEffect, useRef, useCallback } from 'react';

type EventHandler = (data: any) => void;

const listeners = new Map<string, Set<EventHandler>>();
let globalWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connect() {
  if (globalWs?.readyState === WebSocket.OPEN) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws`;

  try {
    globalWs = new WebSocket(url);

    globalWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const handlers = listeners.get(msg.event);
        if (handlers) {
          for (const handler of handlers) handler(msg.data);
        }
        // Also fire a wildcard for any event
        const wildcardHandlers = listeners.get('*');
        if (wildcardHandlers) {
          for (const handler of wildcardHandlers) handler(msg);
        }
      } catch { /* ignore parse errors */ }
    };

    globalWs.onclose = () => {
      globalWs = null;
      // Reconnect after 5s, but ONLY if page is visible
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!document.hidden) connect();
        }, 5000);
      }
    };

    globalWs.onerror = () => {
      globalWs?.close();
    };
  } catch { /* WebSocket not available */ }
}

// Start connection when page is visible (avoid reconnect stealing focus in background)
if (!document.hidden) {
  connect();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !globalWs) connect();
});

/**
 * Hook to subscribe to WebSocket events.
 * Returns nothing — just registers a callback for the given event.
 */
export function useWebSocket(event: string, handler: EventHandler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const stableHandler = useCallback((data: any) => {
    handlerRef.current(data);
  }, []);

  useEffect(() => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(stableHandler);

    // Ensure connected (only if page is visible)
    if (!document.hidden) connect();

    return () => {
      listeners.get(event)?.delete(stableHandler);
    };
  }, [event, stableHandler]);
}
