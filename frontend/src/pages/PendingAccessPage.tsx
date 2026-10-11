import { Box, Button, Card, CardContent, Stack, Typography } from '@mui/material';
import { useSession } from '../session';

export default function PendingAccessPage() {
  const { me, logout } = useSession();
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Card variant="outlined" sx={{ width: '100%', maxWidth: 520 }}>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h5" fontWeight={600}>
              Waiting for access
            </Typography>
            <Typography>
              You are signed in as <b>{me?.user.name}</b>
              {me?.user.email ? ` (${me.user.email})` : ''}, but no role has been assigned to your account yet.
            </Typography>
            <Typography color="text.secondary">Ask your audit platform administrator to assign you a role, then check again.</Typography>
            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={() => window.location.reload()}>
                Check again
              </Button>
              <Button onClick={logout}>Sign out</Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
