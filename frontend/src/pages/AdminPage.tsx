import { Logout as LogoutIcon } from '@mui/icons-material';
import {
  Alert, Card, CardContent, Chip, MenuItem, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ActionButton } from '../components/common';
import { ROLE_LABEL } from '../roles';
import { useSession } from '../session';
import type { Role } from '../types';

interface AdminUser {
  id: string;
  issuer: string;
  name: string;
  email: string | null;
  role: Role | null;
  roleSource: 'idp' | 'admin';
  active: boolean;
  lastLoginAt: string | null;
}

interface AdminSettings {
  devAuth: boolean;
  oidc: { issuer: string; groupsClaim: string; roleMap: Record<string, Role> } | null;
  session: { idleMinutes: number; maxHours: number };
}

interface DueConcept {
  nodeId: string;
  conceptId: string;
  type: string;
  packId: string;
  packVersion: string;
  title: string;
  sourcePath: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  staleAfter: string | null;
  reasons: ('unverified' | 'stale')[];
}

const ROLE_OPTIONS: Role[] = ['auditor', 'audit_manager', 'cae', 'admin', 'viewer'];

export default function AdminPage() {
  const { user } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  // null until loaded: a failed request must never read as "everything is verified".
  const [due, setDue] = useState<DueConcept[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<AdminUser[]>('/admin/users').then(setUsers), []);
  useEffect(() => {
    load();
    api<AdminSettings>('/admin/settings').then(setSettings);
    api<DueConcept[]>('/admin/knowledge/due')
      .then(setDue)
      .catch((e) => setError(`Could not load knowledge due for re-review: ${e instanceof Error ? e.message : String(e)}`));
  }, [load]);

  const patch = async (id: string, body: { role?: Role | null; active?: boolean }) => {
    setError(null);
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await load();
  };

  return (
    <Stack spacing={2}>
      <Typography variant="h5" fontWeight={600}>
        User administration
      </Typography>
      <Typography color="text.secondary">
        Every change here is recorded in the audit trail. A role set here overrides the identity provider's groups for that person.
      </Typography>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Card variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              {['Name', 'Email', 'Sign-in', 'Role', 'Active', 'Last sign-in', ''].map((h) => (
                <TableCell key={h}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {users.map((u) => {
              const self = u.id === user?.id;
              return (
                <TableRow key={u.id}>
                  <TableCell>
                    {u.name}
                    <Typography variant="caption" display="block" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                      {u.id}
                    </Typography>
                  </TableCell>
                  <TableCell>{u.email ?? '—'}</TableCell>
                  <TableCell>
                    <Chip size="small" label={u.issuer === 'dev' ? 'demo' : 'SSO'} />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <TextField
                        select
                        size="small"
                        value={u.role ?? ''}
                        disabled={self}
                        onChange={(e) => patch(u.id, { role: (e.target.value || null) as Role | null })}
                        sx={{ minWidth: 220 }}
                      >
                        <MenuItem value="">No role (pending access)</MenuItem>
                        {ROLE_OPTIONS.map((r) => (
                          <MenuItem key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </MenuItem>
                        ))}
                      </TextField>
                      {u.roleSource === 'admin' && <Chip size="small" variant="outlined" label="set by admin" />}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Switch checked={u.active} disabled={self} onChange={(e) => patch(u.id, { active: e.target.checked })} />
                  </TableCell>
                  <TableCell>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</TableCell>
                  <TableCell>
                    <ActionButton size="small" variant="outlined" startIcon={<LogoutIcon />} action={() => api(`/admin/users/${u.id}/revoke-sessions`, { method: 'POST' })}>
                      Sign out everywhere
                    </ActionButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" fontSize={16}>
            Knowledge due for re-review{due ? ` (${due.length})` : ''}
          </Typography>
          {due === null ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Not loaded.
            </Typography>
          ) : due.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Every library concept is verified and current.
            </Typography>
          ) : (
            <Table size="small" sx={{ mt: 1 }}>
              <TableHead>
                <TableRow>
                  {['ID', 'Title', 'Pack', 'Reason', 'Re-review by', 'Source file'].map((h) => (
                    <TableCell key={h}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {due.map((d) => (
                  <TableRow key={d.nodeId}>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{d.conceptId}</TableCell>
                    <TableCell>{d.title}</TableCell>
                    <TableCell>{d.packId}@{d.packVersion}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5}>
                        {d.reasons.map((r) => (
                          <Chip key={r} size="small" color={r === 'stale' ? 'error' : 'warning'} label={r} />
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell>{d.staleAfter ?? '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{d.sourcePath}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {settings && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" fontSize={16}>
              Sign-in settings
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              Sessions end after {settings.session.idleMinutes} idle minutes and at most {settings.session.maxHours} hours after sign-in.
            </Typography>
            {settings.devAuth && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                Demo sign-in is enabled. Turn it off (DEV_AUTH=false) before real use.
              </Alert>
            )}
            {settings.oidc ? (
              <>
                <Typography variant="body2" sx={{ mt: 1 }}>
                  Identity provider: <b>{settings.oidc.issuer}</b> · groups claim <code>{settings.oidc.groupsClaim}</code>
                </Typography>
                <Table size="small" sx={{ mt: 1, maxWidth: 520 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Identity-provider group</TableCell>
                      <TableCell>Role</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(settings.oidc.roleMap).map(([group, role]) => (
                      <TableRow key={group}>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{group}</TableCell>
                        <TableCell>{ROLE_LABEL[role]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                No identity provider is configured.
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              Group mappings come from the deployment configuration (OIDC_ROLE_MAP) and change under change control, not here.
            </Typography>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
