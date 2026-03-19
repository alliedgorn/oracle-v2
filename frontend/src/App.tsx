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
import { PackView } from './pages/PackView';
import { BeastProfile } from './pages/BeastProfile';
import { Groups } from './pages/Groups';
import { Playbook } from './pages/Playbook';
import { GornQueue } from './pages/GornQueue';
import { RemoteControl } from './pages/RemoteControl';
import { RemotePanel } from './components/RemotePanel';
import { Mindlink } from './pages/Mindlink';
import { Library } from './pages/Library';
import { Board } from './pages/Board';
import { Scheduler } from './pages/Scheduler';
import { Notifications } from './pages/Notifications';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { getStats } from './api/oracle';
import { setVaultRepo } from './utils/docDisplay';

// Protected route wrapper
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, authEnabled, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <div style={{ padding: 48, textAlign: 'center', color: '#888' }}>Loading...</div>;
  }

  if (authEnabled && !isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

function AppContent() {
  const location = useLocation();
  const isLoginPage = location.pathname === '/login';
  const [remoteCollapsed, setRemoteCollapsed] = useState(false);
  const [remoteMobileOpen, setRemoteMobileOpen] = useState(false);

  return (
    <>
      {!isLoginPage && <Header onRemoteToggle={() => setRemoteMobileOpen(prev => !prev)} />}
      <div className={!isLoginPage ? 'app-layout' : undefined}>
      <div className={!isLoginPage ? 'app-main' : undefined}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><PackView /></RequireAuth>} />
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
        <Route path="/pack" element={<RequireAuth><PackView /></RequireAuth>} />
        <Route path="/beast/:name" element={<RequireAuth><BeastProfile /></RequireAuth>} />
        <Route path="/groups" element={<RequireAuth><Groups /></RequireAuth>} />
        <Route path="/playbook" element={<RequireAuth><Playbook /></RequireAuth>} />
        <Route path="/queue" element={<RequireAuth><GornQueue /></RequireAuth>} />
        <Route path="/mindlink" element={<RequireAuth><Mindlink /></RequireAuth>} />
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
        <Route path="/notifications" element={<RequireAuth><Notifications /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
      </Routes>
      {!isLoginPage && <QuickLearn />}
      </div>
      {!isLoginPage && (
        <RemotePanel
          isOpen={remoteMobileOpen}
          onClose={() => setRemoteMobileOpen(false)}
          collapsed={remoteCollapsed}
          onToggleCollapse={() => setRemoteCollapsed(prev => !prev)}
        />
      )}
      </div>
    </>
  );
}

function App() {
  useEffect(() => {
    getStats().then(stats => {
      if (stats.vault_repo) setVaultRepo(stats.vault_repo);
    }).catch(() => {});
  }, []);

  return (
    <BrowserRouter>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
