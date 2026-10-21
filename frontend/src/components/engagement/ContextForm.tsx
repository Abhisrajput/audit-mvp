import { Add as AddIcon, DeleteOutline as DeleteIcon } from '@mui/icons-material';
import { Button, Card, CardContent, IconButton, MenuItem, Select, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { contextProblems, FACTOR_LABELS } from '../../judgment';
import type { ContextFactor, Engagement, FactorKind } from '../../types';
import { ActionButton } from '../common';

/** The auditor's engagement context (spec §3.1): facts that raise risk in named process areas. Read-only once the RCM is approved. */
export default function ContextForm({ engagement: e, locked, areas, onSaved }: { engagement: Engagement; locked: boolean; areas: string[]; onSaved: (e: Engagement) => void }) {
  const [factors, setFactors] = useState<ContextFactor[]>([]);
  const [background, setBackground] = useState('');
  // Start from what is saved, and again whenever the saved context changes (a reload, another save).
  // Only when the saved value really differs, so a reload that returns the same context keeps an unsaved draft.
  const synced = useRef<string | null>(null);
  useEffect(() => {
    const saved = JSON.stringify(e.context);
    if (saved === synced.current) return;
    synced.current = saved;
    setFactors(e.context?.factors ?? []);
    setBackground(e.context?.background ?? '');
  }, [e.context]);
  const problems = contextProblems({ factors, background });
  const change = (i: number, patch: Partial<ContextFactor>) => setFactors(factors.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography fontWeight={600}>Engagement context</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Changes, incidents, regulatory actions and prior findings that bear on risk. The risk assessment raises the areas you name.
          {locked && ' Locked: the scope and RCM are approved.'}
        </Typography>
        {factors.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={230}>Kind</TableCell>
                <TableCell width={230}>Process areas</TableCell>
                <TableCell>Description</TableCell>
                <TableCell padding="checkbox" />
              </TableRow>
            </TableHead>
            <TableBody>
              {factors.map((f, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Select size="small" fullWidth value={f.kind} disabled={locked} inputProps={{ 'aria-label': 'Factor kind' }} onChange={(ev) => change(i, { kind: ev.target.value as FactorKind })}>
                      {(Object.keys(FACTOR_LABELS) as FactorKind[]).map((k) => (
                        <MenuItem key={k} value={k}>
                          {FACTOR_LABELS[k]}
                        </MenuItem>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      size="small"
                      fullWidth
                      multiple
                      inputProps={{ 'aria-label': 'Process areas' }}
                      displayEmpty
                      value={f.processAreas}
                      disabled={locked}
                      renderValue={(v) => (v.length ? v.join(', ') : 'Whole engagement')}
                      onChange={(ev) => change(i, { processAreas: typeof ev.target.value === 'string' ? ev.target.value.split(',') : ev.target.value })}
                    >
                      {/* Keep a saved area selectable even when it is no longer among the options. */}
                      {[...new Set([...areas, ...f.processAreas])].map((a) => (
                        <MenuItem key={a} value={a}>
                          {a}
                        </MenuItem>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <TextField size="small" fullWidth value={f.description} disabled={locked} inputProps={{ 'aria-label': 'Description' }} onChange={(ev) => change(i, { description: ev.target.value })} />
                  </TableCell>
                  <TableCell padding="checkbox">
                    {!locked && (
                      <IconButton aria-label="Remove factor" onClick={() => setFactors(factors.filter((_, j) => j !== i))}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Stack spacing={1.5} sx={{ mt: 1.5 }}>
          {!locked && (
            <Button size="small" startIcon={<AddIcon />} sx={{ alignSelf: 'flex-start' }} onClick={() => setFactors([...factors, { kind: 'change', processAreas: [], description: '' }])}>
              Add factor
            </Button>
          )}
          <TextField label="Background" multiline minRows={2} fullWidth value={background} disabled={locked} onChange={(ev) => setBackground(ev.target.value)} />
          {!locked && (
            <Stack direction="row" spacing={2} alignItems="center">
              <ActionButton
                variant="outlined"
                disabled={problems.length > 0}
                action={async () => onSaved(await api<Engagement>(`/engagements/${e.id}/context`, { method: 'PUT', ifMatch: e.version, body: { factors, background } }))}
              >
                Save context
              </ActionButton>
              {problems.length > 0 && (
                <Typography variant="body2" color="error">
                  {problems.join('. ')}
                </Typography>
              )}
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
