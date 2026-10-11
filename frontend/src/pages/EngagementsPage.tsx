import { Add as AddIcon } from '@mui/icons-material';
import {
  Box, Button, Card, CardContent, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  FormGroup, FormLabel, Grid, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ActionButton } from '../components/common';
import { canPrepare } from '../roles';
import { useSession } from '../session';

interface Summary {
  id: string;
  name: string;
  entity: string;
  site: string;
  auditType: string;
  packIds: string[];
  stage: string;
  createdAt: string;
  findings: number;
  rcm: number;
}

interface PackSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  controlCount: number;
  clauseCount: number;
}

const EMPTY = { name: '', entity: '', site: '', periodFrom: '', periodTo: '', auditType: '', scopeStatement: '', packIds: ['common'] as string[] };

export default function EngagementsPage() {
  const [rows, setRows] = useState<Summary[]>([]);
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const navigate = useNavigate();
  const { user } = useSession();

  useEffect(() => {
    api<Summary[]>('/engagements').then(setRows);
    api<PackSummary[]>('/packs').then(setPacks);
  }, []);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const togglePack = (id: string) =>
    setForm({ ...form, packIds: form.packIds.includes(id) ? form.packIds.filter((p) => p !== id) : [...form.packIds, id] });

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center">
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" fontWeight={600}>
            Audit engagements
          </Typography>
          <Typography color="text.secondary">
            Each engagement runs the module chain: Risk & Scope → Control & Risk Writer → Testing → Gap Writer → Report Writer.
          </Typography>
        </Box>
        {canPrepare(user?.role) && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpen(true)}>
            New engagement
          </Button>
        )}
      </Stack>

      <Grid container spacing={2}>
        {packs.map((p) => (
          <Grid item xs={12} md={4} key={p.id}>
            <Card variant="outlined" sx={{ height: '100%' }}>
              <CardContent>
                <Typography fontWeight={600}>
                  {p.name} <Typography component="span" color="text.secondary">v{p.version}</Typography>
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ my: 1 }}>
                  {p.description}
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Chip size="small" label={`${p.controlCount} controls`} />
                  <Chip size="small" label={`${p.clauseCount} clauses`} />
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Card variant="outlined">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Engagement</TableCell>
              <TableCell>Entity / site</TableCell>
              <TableCell>Packs</TableCell>
              <TableCell>Stage</TableCell>
              <TableCell align="right">RCM rows</TableCell>
              <TableCell align="right">Findings</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/engagements/${r.id}`)}>
                <TableCell sx={{ fontFamily: 'monospace' }}>{r.id}</TableCell>
                <TableCell>
                  <Typography fontWeight={600}>{r.name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {r.auditType}
                  </Typography>
                </TableCell>
                <TableCell>
                  {r.entity}
                  <br />
                  <Typography variant="body2" color="text.secondary">
                    {r.site}
                  </Typography>
                </TableCell>
                <TableCell>
                  {r.packIds.map((p) => (
                    <Chip key={p} size="small" label={p} sx={{ mr: 0.5 }} />
                  ))}
                </TableCell>
                <TableCell>
                  <Chip size="small" color="primary" variant="outlined" label={r.stage} />
                </TableCell>
                <TableCell align="right">{r.rcm}</TableCell>
                <TableCell align="right">{r.findings}</TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  No engagements yet. Run <code>npm run seed</code> in the backend for demo data, or create one.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>New audit engagement</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Engagement name" value={form.name} onChange={set('name')} required />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Entity" value={form.entity} onChange={set('entity')} fullWidth required />
              <TextField label="Site / plant" value={form.site} onChange={set('site')} fullWidth required />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Audit type" placeholder="e.g. Food safety internal audit" value={form.auditType} onChange={set('auditType')} fullWidth required />
              <TextField label="Period from" type="date" InputLabelProps={{ shrink: true }} value={form.periodFrom} onChange={set('periodFrom')} required />
              <TextField label="Period to" type="date" InputLabelProps={{ shrink: true }} value={form.periodTo} onChange={set('periodTo')} required />
            </Stack>
            <TextField
              label="Scope statement"
              helperText="Describe processes, risks and areas in scope; the Risk & Scope module ranks the control library against this."
              value={form.scopeStatement}
              onChange={set('scopeStatement')}
              multiline
              minRows={3}
              required
            />
            <Box>
              <FormLabel>Content packs</FormLabel>
              <FormGroup row>
                {packs.map((p) => (
                  <FormControlLabel key={p.id} control={<Checkbox checked={form.packIds.includes(p.id)} onChange={() => togglePack(p.id)} />} label={p.name} />
                ))}
              </FormGroup>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <ActionButton
            action={async () => {
              const e = await api<{ id: string }>('/engagements', { method: 'POST', body: form });
              navigate(`/engagements/${e.id}`);
            }}
          >
            Create
          </ActionButton>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
