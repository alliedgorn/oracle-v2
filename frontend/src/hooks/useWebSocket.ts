import { useEffect, useRef, useCallback } from 'react';

type EventHandler = (data: any) => void;

const listeners = new Map<string, Set<EventHandler>>();
let globalWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000; // Start at 1s, exponential backoff
const RECONNECT_MAX = 30000; // Cap at 30s
const RECONNECT_BASE = 1000;
let hasConnectedBefore = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL = 30000; // 30s

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (globalWs?.readyState === WebSocket.OPEN && !document.hidden) {
      globalWs.send(JSON.stringify({ type: 'heartbeat' }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connect() {
  if (globalWs?.readyState === WebSocket.OPEN) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws`;

  try {
    globalWs = new WebSocket(url);

    globalWs.onopen = () => {
      // Reset backoff on successful connection
      reconnectDelay = RECONNECT_BASE;
      // Notify listeners of reconnect so they can refetch stale data (T#534)
      if (hasConnectedBefore) {
        const handlers = listeners.get('ws_reconnect');
        if (handlers) {
          for (const handler of handlers) handler({});
        }
      }
      hasConnectedBefore = true;
      // Send immediate heartbeat on connect so presence registers instantly
      globalWs?.send(JSON.stringify({ type: 'heartbeat' }));
      startHeartbeat();
    };

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
      stopHeartbeat();
      // Reconnect with exponential backoff, only if page is visible
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!document.hidden) connect();
        }, reconnectDelay);
        // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (capped)
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
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
  if (!document.hidden && !globalWs) {
    reconnectDelay = RECONNECT_BASE; // Reset backoff when user returns
    connect();
  }
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
