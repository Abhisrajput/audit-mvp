import { PlayArrow as PlayArrowIcon } from '@mui/icons-material';
import { Box, Card, Checkbox, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { TabProps } from '../../pages/EngagementPage';
import type { Engagement } from '../../types';
import { ActionButton, Citations, RiskChip } from '../common';

export default function ScopeTab({ engagement: e, setEngagement, run }: TabProps) {
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  useEffect(() => setIncluded(Object.fromEntries(e.scope.map((s) => [s.controlId, s.included]))), [e.scope]);
  const dirty = e.scope.some((s) => included[s.controlId] !== s.included);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <ActionButton startIcon={<PlayArrowIcon />} action={() => run('scope')}>
          {e.scope.length ? 'Re-run' : 'Run'} Risk & Scope analysis
        </ActionButton>
        <ActionButton
          variant="outlined"
          disabled={!dirty}
          action={async () =>
            setEngagement(await api<Engagement>(`/engagements/${e.id}/scope`, { method: 'PUT', ifMatch: e.version, body: { items: e.scope.map((s) => ({ controlId: s.controlId, included: included[s.controlId] })) } }))
          }
        >
          Save scope decisions
        </ActionButton>
        <Typography color="text.secondary">
          {Object.values(included).filter(Boolean).length} of {e.scope.length} library controls in scope. Your decisions are recorded in the audit trail.
        </Typography>
      </Stack>
      {e.scope.length > 0 && (
        <Card variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">In</TableCell>
                <TableCell>Control</TableCell>
                <TableCell>Process area</TableCell>
                <TableCell>Inherent risk</TableCell>
                <TableCell width={140}>Relevance</TableCell>
                <TableCell>Rationale</TableCell>
                <TableCell>Citations</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {e.scope.map((s) => (
                <TableRow key={s.controlId} sx={{ opacity: included[s.controlId] ? 1 : 0.55 }}>
                  <TableCell padding="checkbox">
                    <Checkbox checked={!!included[s.controlId]} onChange={(ev) => setIncluded({ ...included, [s.controlId]: ev.target.checked })} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {s.controlId}
                    </Typography>
                    <Typography variant="body2">{s.risk}</Typography>
                  </TableCell>
                  <TableCell>{s.processArea}</TableCell>
                  <TableCell>
                    <RiskChip rating={s.inherentRisk} />
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <LinearProgress variant="determinate" value={s.relevance * 100} sx={{ flex: 1 }} />
                      <Typography variant="caption">{s.relevance.toFixed(2)}</Typography>
                    </Box>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 300 }}>
                    <Typography variant="body2">{s.rationale}</Typography>
                  </TableCell>
                  <TableCell>
                    <Citations citations={s.citations} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </Stack>
  );
}
