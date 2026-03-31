import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { QuickLearn } from './components/QuickLearn';
import { Overview } from './pages/Overview';
import { Feed } from './pages/Feed';
import { DocDetail } from './pages/DocDetail';
import { Search } from './pages/Search';
import { Graph } from './pages/Graph';
import { Handoff } from './pages/Handoff';
import { Activity } from './pages/Activity';
import { Forum } from './pages/Forum';
import { DirectMessages } from './pages/DirectMessages';
import { Evolution } from './pages/Evolution';
import { Traces } from './pages/Traces';
import { Superseded } from './pages/Superseded';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Playground } from './pages/Playground';
import { Map } from './pages/Map';
import { PackPage } from './pages/PackPage';
import { TerminalView } from './pages/TerminalView';
import { BeastProfile } from './pages/BeastProfile';
import { Playbook } from './pages/Playbook';
import { GornQueue } from './pages/GornQueue';
import { RemoteControl } from './pages/RemoteControl';
import { RemotePanel } from './components/RemotePanel';
import { Prowl } from './pages/Prowl';
import { Risk } from './pages/Risk';
import { Rules } from './pages/Rules';
import { Forge } from './pages/Forge';
import { Library } from './pages/Library';
import { Board } from './pages/Board';
import { Scheduler } from './pages/Scheduler';
import { Teams } from './pages/Teams';
import { AuditLog } from './pages/AuditLog';
import { SpecReview } from './pages/SpecReview';
import { Files } from './pages/Files';
import { GuestWelcome } from './pages/GuestWelcome';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ChatProvider, useChat } from './contexts/ChatContext';
import { ChatOverlay } from './components/ChatOverlay';
import { getStats } from './api/oracle';
import { setVaultRepo } from './utils/docDisplay';

// Guest-accessible routes (no redirect for guests)
const GUEST_ROUTES = new Set(['/', '/pack', '/forum', '/dms', '/beast', '/welcome', '/terminal']);

function isGuestRoute(pathname: string): boolean {
  if (GUEST_ROUTES.has(pathname)) return true;
  if (pathname.startsWith('/beast/')) return true;
  return false;
}

// Protected route wrapper with guest role awareness
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, authEnabled, isLoading, isGuest } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <div style={{ padding: 48, textAlign: 'center', color: '#888' }}>Loading...</div>;
  }

  if (authEnabled && !isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Guests can only access whitelisted routes — redirect others to /
  if (isGuest && !isGuestRoute(location.pathname)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function AppContent() {
  const location = useLocation();
  const { isGuest, isLoading: authLoading } = useAuth();
  const isLoginPage = location.pathname === '/login';
  const [remoteCollapsed, setRemoteCollapsed] = useState(false);
  const [remoteMobileOpen, setRemoteMobileOpen] = useState(false);

  // Fix mobile keyboard dismiss: reset scroll position when virtual keyboard closes
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevHeight = vv.height;
    function onResize() {
      const currentHeight = vv!.height;
      // Keyboard closing = viewport height increases significantly
      if (currentHeight - prevHeight > 100) {
        window.scrollTo(0, 0);
      }
      prevHeight = currentHeight;
    }
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  return (
    <>
      {!isLoginPage && <Header onRemoteToggle={() => setRemoteMobileOpen(prev => !prev)} />}
      <div className={!isLoginPage ? 'app-layout' : undefined}>
      <div className={!isLoginPage ? 'app-main' : undefined}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/welcome" element={<RequireAuth><GuestWelcome /></RequireAuth>} />
        <Route path="/" element={<RequireAuth><PackPage /></RequireAuth>} />
        <Route path="/overview" element={<RequireAuth><Overview /></RequireAuth>} />
        <Route path="/feed" element={<RequireAuth><Feed /></RequireAuth>} />
        <Route path="/doc/:id" element={<RequireAuth><DocDetail /></RequireAuth>} />
        <Route path="/search" element={<RequireAuth><Search /></RequireAuth>} />
        <Route path="/playground" element={<RequireAuth><Playground /></RequireAuth>} />
        <Route path="/map" element={<RequireAuth><Map /></RequireAuth>} />
        <Route path="/graph" element={<RequireAuth><Graph /></RequireAuth>} />
        <Route path="/graph3d" element={<Navigate to="/graph" replace />} />
        <Route path="/handoff" element={<RequireAuth><Handoff /></RequireAuth>} />
        <Route path="/activity" element={<RequireAuth><Activity /></RequireAuth>} />
        <Route path="/pack" element={<RequireAuth><PackPage /></RequireAuth>} />
        <Route path="/terminal" element={<RequireAuth><TerminalView /></RequireAuth>} />
        <Route path="/beast/:name" element={<RequireAuth><BeastProfile /></RequireAuth>} />
        <Route path="/playbook" element={<RequireAuth><Playbook /></RequireAuth>} />
        <Route path="/queue" element={<RequireAuth><GornQueue /></RequireAuth>} />
        <Route path="/prowl" element={<RequireAuth><Prowl /></RequireAuth>} />
        <Route path="/risk" element={<RequireAuth><Risk /></RequireAuth>} />
        <Route path="/rules" element={<RequireAuth><Rules /></RequireAuth>} />
        <Route path="/forge" element={<RequireAuth><Forge /></RequireAuth>} />
        <Route path="/mindlink" element={<Navigate to="/prowl" replace />} />
        <Route path="/remote" element={<RequireAuth><RemoteControl /></RequireAuth>} />
        <Route path="/library" element={<RequireAuth><Library /></RequireAuth>} />
        <Route path="/board" element={<RequireAuth><Board /></RequireAuth>} />
        <Route path="/forum" element={<RequireAuth><Forum /></RequireAuth>} />
        <Route path="/dms" element={<RequireAuth><DirectMessages /></RequireAuth>} />
        <Route path="/evolution" element={<RequireAuth><Evolution /></RequireAuth>} />
        <Route path="/traces" element={<RequireAuth><Traces /></RequireAuth>} />
        <Route path="/traces/:id" element={<RequireAuth><Traces /></RequireAuth>} />
        <Route path="/superseded" element={<RequireAuth><Superseded /></RequireAuth>} />
        <Route path="/scheduler" element={<RequireAuth><Scheduler /></RequireAuth>} />
        <Route path="/teams" element={<RequireAuth><Teams /></RequireAuth>} />
        <Route path="/audit" element={<RequireAuth><AuditLog /></RequireAuth>} />
        <Route path="/specs" element={<RequireAuth><SpecReview /></RequireAuth>} />
        <Route path="/files" element={<RequireAuth><Files /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
      </Routes>
      {!isLoginPage && !authLoading && !isGuest && <QuickLearn />}
      </div>
      {!isLoginPage && !authLoading && !isGuest && (
        <RemotePanel
          isOpen={remoteMobileOpen}
          onClose={() => setRemoteMobileOpen(false)}
          collapsed={remoteCollapsed}
          onToggleCollapse={() => setRemoteCollapsed(prev => !prev)}
        />
      )}
      </div>
      {!isLoginPage && !authLoading && !isGuest && <GlobalChatOverlay />}
    </>
  );
}

function GlobalChatOverlay() {
  const { chatTarget, collapsed, closeChat, toggleCollapse } = useChat();
  if (!chatTarget) return null;
  return (
    <ChatOverlay
      beastName={chatTarget.beastName}
      displayName={chatTarget.displayName}
      collapsed={collapsed}
      onToggleCollapse={toggleCollapse}
      onClose={closeChat}
    />
  );
}

function AppInit() {
  const { isGuest, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading || isGuest) return;
    getStats().then(stats => {
      if (stats.vault_repo) setVaultRepo(stats.vault_repo);
    }).catch(() => {});
  }, [isLoading, isGuest]);

  return null;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ChatProvider>
          <AppInit />
          <AppContent />
        </ChatProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
