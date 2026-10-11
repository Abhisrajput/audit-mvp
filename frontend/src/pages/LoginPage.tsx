import { Login as LoginIcon } from '@mui/icons-material';
import { Alert, Box, Button, Card, CardContent, Divider, List, ListItemButton, ListItemText, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { request } from '../api';
import { ROLE_LABEL } from '../roles';
import { useSession } from '../session';
import type { User } from '../types';

export default function LoginPage() {
  const { options, devLogin, error } = useSession();
  const [devUsers, setDevUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (options?.devAuth) request<User[]>('/auth/dev-users').then(setDevUsers, () => setDevUsers([]));
  }, [options?.devAuth]);

  const signInAs = async (id: string) => {
    setBusy(id);
    setFailure(null);
    try {
      await devLogin(id);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Card variant="outlined" sx={{ width: '100%', maxWidth: 440 }}>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h5" fontWeight={600}>
              Audit & Controls Platform
            </Typography>
            <Typography color="text.secondary">Sign in to continue.</Typography>
            {(failure || error) && <Alert severity="error">{failure ?? error}</Alert>}
            {options?.oidc && (
              <Button variant="contained" size="large" startIcon={<LoginIcon />} href="/auth/login">
                Sign in with your organisation account
              </Button>
            )}
            {options?.devAuth && (
              <>
                {options.oidc && <Divider>or</Divider>}
                <Alert severity="warning">Demo sign-in is enabled. It is for development only and is refused in production.</Alert>
                <List dense disablePadding>
                  {devUsers.map((u) => (
                    <ListItemButton key={u.id} disabled={!!busy} onClick={() => signInAs(u.id)}>
                      <ListItemText primary={u.name} secondary={ROLE_LABEL[u.role]} />
                    </ListItemButton>
                  ))}
                </List>
              </>
            )}
            {options && !options.oidc && !options.devAuth && <Alert severity="error">No sign-in method is configured. Contact your administrator.</Alert>}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
