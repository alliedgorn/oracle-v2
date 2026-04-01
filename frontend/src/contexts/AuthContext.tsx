import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { getAuthStatus, login as apiLogin, logout as apiLogout, type AuthStatus } from '../api/oracle';
import { wsReconnect } from '../hooks/useWebSocket';

interface AuthContextType {
  isAuthenticated: boolean;
  authEnabled: boolean;
  hasPassword: boolean;
  localBypass: boolean;
  isLocal: boolean;
  isLoading: boolean;
  role: 'owner' | 'guest' | null;
  isGuest: boolean;
  guestName: string | null;
  guestUsername: string | null;
  login: (password: string, username?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthStatus>({
    authenticated: true,
    authEnabled: false,
    hasPassword: false,
    localBypass: true,
    isLocal: true
  });
  const [isLoading, setIsLoading] = useState(true);

  async function checkAuth() {
    try {
      const status = await getAuthStatus();
      setAuthState(status);
    } catch (e) {
      console.error('Failed to check auth status:', e);
      // On error, assume authenticated to not block
      setAuthState(prev => ({ ...prev, authenticated: true }));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    checkAuth();
  }, []);

  async function login(password: string, username?: string): Promise<{ success: boolean; error?: string }> {
    const result = await apiLogin(password, username);
    if (result.success) {
      await checkAuth();
      // Reconnect WebSocket to pick up new session cookie for presence tracking
      wsReconnect();
    }
    return result;
  }

  async function logout(): Promise<void> {
    await apiLogout();
    await checkAuth();
  }

  const role = authState.authenticated
    ? (authState.role || 'owner')
    : null;

  return (
    <AuthContext.Provider value={{
      isAuthenticated: authState.authenticated,
      authEnabled: authState.authEnabled,
      hasPassword: authState.hasPassword,
      localBypass: authState.localBypass,
      isLocal: authState.isLocal,
      isLoading,
      role,
      isGuest: role === 'guest',
      guestName: authState.guestName || authState.guestUsername || null,
      guestUsername: authState.guestUsername || null,
      login,
      logout,
      checkAuth
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
