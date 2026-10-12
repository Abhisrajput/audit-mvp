import { FactCheck as FactCheckIcon, Logout as LogoutIcon } from '@mui/icons-material';
import { AppBar, Box, Button, Chip, Container, LinearProgress, Toolbar, Typography } from '@mui/material';
import { Link as RouterLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ActionButton } from './components/common';
import AdminPage from './pages/AdminPage';
import EngagementPage from './pages/EngagementPage';
import EngagementsPage from './pages/EngagementsPage';
import LibraryPage from './pages/LibraryPage';
import LoginPage from './pages/LoginPage';
import PendingAccessPage from './pages/PendingAccessPage';
import ValidationPage from './pages/ValidationPage';
import { ROLE_LABEL } from './roles';
import { SessionProvider, useSession } from './session';

const AUDIT_NAV = [
  { to: '/engagements', label: 'Engagements' },
  { to: '/library', label: 'Content library' },
  { to: '/validation', label: 'Evaluation & validation' },
];

function Shell() {
  const { user, provider, logout } = useSession();
  const { pathname } = useLocation();
  if (!user) return null;
  const isAdmin = user.role === 'admin';
  const nav = isAdmin ? [{ to: '/admin', label: 'Administration' }] : AUDIT_NAV;
  return (
    <>
      <AppBar position="sticky" elevation={0}>
        <Toolbar sx={{ gap: 2, flexWrap: 'wrap' }}>
          <FactCheckIcon />
          <Typography variant="h6" sx={{ mr: 2, fontWeight: 600 }}>
            Audit & Controls Platform
          </Typography>
          {nav.map((n) => (
            <Button key={n.to} component={RouterLink} to={n.to} color="inherit" sx={{ opacity: pathname.startsWith(n.to) ? 1 : 0.7, fontWeight: pathname.startsWith(n.to) ? 700 : 400 }}>
              {n.label}
            </Button>
          ))}
          <Box sx={{ flex: 1 }} />
          {provider && !isAdmin && (
            <Chip size="small" label={`Model: ${provider.id === 'offline' ? 'offline rules' : provider.model}`} sx={{ bgcolor: 'rgba(255,255,255,0.15)', color: 'inherit' }} />
          )}
          <Typography variant="body2">{user.name}</Typography>
          <Chip size="small" label={ROLE_LABEL[user.role]} sx={{ bgcolor: 'rgba(255,255,255,0.15)', color: 'inherit' }} />
          <ActionButton variant="text" color="inherit" startIcon={<LogoutIcon />} action={logout}>
            Sign out
          </ActionButton>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 3 }}>
        {isAdmin ? (
          <Routes>
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/admin" />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/engagements" />} />
            <Route path="/engagements" element={<EngagementsPage />} />
            <Route path="/engagements/:id" element={<EngagementPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/validation" element={<ValidationPage />} />
            <Route path="*" element={<Navigate to="/engagements" />} />
          </Routes>
        )}
      </Container>
    </>
  );
}

function Gate() {
  const { status } = useSession();
  if (status === 'loading') return <LinearProgress />;
  if (status === 'signed-out') return <LoginPage />;
  if (status === 'pending') return <PendingAccessPage />;
  return <Shell />;
}

export default function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
