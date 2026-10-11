import { PlayArrow as PlayArrowIcon } from '@mui/icons-material';
import {
  Alert, Button, Card, CardContent, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import { useState } from 'react';
import { api } from '../../api';
import type { TabProps } from '../../pages/EngagementPage';
import { useSession } from '../../session';
import type { Engagement, Finding } from '../../types';
import { ActionButton, Citations, RiskChip, StatusChip } from '../common';

const FIELDS = ['condition', 'criteria', 'cause', 'effect', 'recommendation'] as const;

function EditDialog({ finding, engagementId, onClose, onSaved }: { finding: Finding; engagementId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ ...finding, evidence: finding.evidenceRefs.join(', ') });
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Edit finding {finding.id}</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          Saving resets sign-offs to draft and re-runs the triple-citation gate.
        </Alert>
        <Stack spacing={2}>
          <TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <TextField select label="Rating" value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value as Finding['rating'] })}>
            {['High', 'Medium', 'Low'].map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </TextField>
          {FIELDS.map((k) => (
            <TextField key={k} label={k[0].toUpperCase() + k.slice(1)} multiline minRows={2} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          ))}
          <TextField label="Evidence references" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <ActionButton
          action={async () => {
            await api(`/engagements/${engagementId}/findings/${finding.id}`, {
              method: 'PUT',
              body: { title: f.title, rating: f.rating, ...Object.fromEntries(FIELDS.map((k) => [k, f[k]])), evidenceRefs: f.evidence.split(',').map((s) => s.trim()).filter(Boolean) },
            });
            await onSaved();
            onClose();
          }}
        >
          Save
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}

function FindingCard({ f, engagementId, reload }: { f: Finding; engagementId: string; reload: () => Promise<void> }) {
  const { user } = useSession();
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const sign = (action: string) => async () => {
    await api(`/engagements/${engagementId}/findings/${f.id}/signoff`, { method: 'POST', body: { action, comment } });
    setComment('');
    await reload();
  };
  const role = user?.role;

  return (
    <Card variant="outlined" sx={{ borderLeft: 4, borderLeftColor: f.status === 'blocked' ? 'error.main' : f.status === 'approved' ? 'success.main' : 'grey.400' }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography variant="h6" sx={{ flex: 1, fontSize: 17 }}>
            {f.title}
          </Typography>
          <RiskChip rating={f.rating} />
          <StatusChip status={f.status} />
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {f.id} · control {f.controlId} · drafted in {f.bundleId}
        </Typography>
        {f.status === 'blocked' && (
          <Alert severity="error" sx={{ mt: 1 }}>
            Blocked by QA gate: {f.blockedReasons.join('; ')}
          </Alert>
        )}
        <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
          {FIELDS.map((k) => (
            <Grid item xs={12} md={k === 'criteria' ? 12 : 6} key={k}>
              <Typography variant="subtitle2" sx={{ textTransform: 'capitalize' }}>
                {k}
              </Typography>
              <Typography variant="body2">{f[k]}</Typography>
            </Grid>
          ))}
        </Grid>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mt: 1.5 }} alignItems={{ md: 'center' }}>
          <Typography variant="subtitle2">Triple citation:</Typography>
          <Citations citations={f.citations} />
          <Typography variant="body2">
            control <b>{f.controlId}</b> · evidence <b>{f.evidenceRefs.join(', ') || '—'}</b>
          </Typography>
        </Stack>
        {f.signOffs.length > 0 && (
          <Stack sx={{ mt: 1.5 }}>
            {f.signOffs.map((s, i) => (
              <Typography key={i} variant="body2" color="text.secondary">
                ✍ {s.meaning} by {s.userName} ({s.role}) at {new Date(s.at).toLocaleString()}
                {s.comment && ` — "${s.comment}"`}
              </Typography>
            ))}
          </Stack>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          {(role === 'auditor' || role === 'audit_manager') && f.status !== 'approved' && (
            <Button size="small" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {((role === 'audit_manager' && f.status === 'draft') || (role === 'cae' && f.status === 'reviewed')) && (
            <>
              <TextField size="small" placeholder="Sign-off comment" value={comment} onChange={(e) => setComment(e.target.value)} sx={{ minWidth: 280 }} />
              {role === 'audit_manager' && (
                <ActionButton size="small" action={sign('review')}>
                  Sign as reviewed
                </ActionButton>
              )}
              {role === 'cae' && (
                <>
                  <ActionButton size="small" color="success" action={sign('approve')}>
                    Approve
                  </ActionButton>
                  <ActionButton size="small" color="warning" variant="outlined" action={sign('reject')}>
                    Reject
                  </ActionButton>
                </>
              )}
            </>
          )}
          {f.status === 'draft' && role !== 'audit_manager' && <Typography variant="caption" color="text.secondary">Awaiting review by an audit manager.</Typography>}
          {f.status === 'reviewed' && role !== 'cae' && <Typography variant="caption" color="text.secondary">Awaiting approval by the Chief Audit Executive.</Typography>}
        </Stack>
      </CardContent>
      {editing && <EditDialog finding={f} engagementId={engagementId} onClose={() => setEditing(false)} onSaved={reload} />}
    </Card>
  );
}

export default function FindingsTab({ engagement: e, setEngagement, run }: TabProps) {
  const reload = async () => setEngagement(await api<Engagement>(`/engagements/${e.id}`));
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <ActionButton startIcon={<PlayArrowIcon />} action={() => run('gaps')}>
          Run Gap Writer
        </ActionButton>
        <Typography color="text.secondary">
          Drafts a finding for each failed control. Approved findings are locked; others are redrafted.
        </Typography>
      </Stack>
      {e.findings.map((f) => (
        <FindingCard key={f.id} f={f} engagementId={e.id} reload={reload} />
      ))}
      {!e.findings.length && <Typography color="text.secondary">No findings yet.</Typography>}
    </Stack>
  );
}
