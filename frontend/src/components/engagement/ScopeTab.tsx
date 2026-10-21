import { PlayArrow as PlayArrowIcon } from '@mui/icons-material';
import { Box, Card, CardContent, Checkbox, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { TabProps } from '../../pages/EngagementPage';
import { areaOptions, contextLocked, raisedAreas } from '../../judgment';
import type { Engagement } from '../../types';
import { ActionButton, Citations, RiskChip } from '../common';
import ContextForm from './ContextForm';

export default function ScopeTab({ engagement: e, setEngagement, run, gates }: TabProps) {
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  useEffect(() => setIncluded(Object.fromEntries(e.scope.map((s) => [s.controlId, s.included]))), [e.scope]);
  // The chosen packs' controls, loaded once per engagement, give the context form its areas before a scope run.
  const [packControls, setPackControls] = useState<{ processArea: string; packId: string }[]>([]);
  const packKey = e.packIds.join(',');
  useEffect(() => {
    let live = true;
    setPackControls([]);
    // The server's controls carry no pack id, so tag each with the pack it was requested from.
    Promise.all(e.packIds.map((id) => api<{ controls: { processArea: string }[] }>(`/packs/${id}`).then((p) => p.controls.map((c) => ({ processArea: c.processArea, packId: id })))))
      .then((lists) => live && setPackControls(lists.flat()))
      .catch((err) => console.warn('Could not load the pack controls for the area picker', err));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packKey]);
  const raised = raisedAreas(e.scope);
  const dirty = e.scope.some((s) => included[s.controlId] !== s.included);

  return (
    <Stack spacing={2}>
      <ContextForm engagement={e} locked={contextLocked(gates)} areas={areaOptions(e.scope, packControls, e.packIds)} onSaved={setEngagement} />
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
                <TableCell>Assessed risk</TableCell>
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
                    {s.riskFactors.length > 0 ? (
                      <Tooltip title={s.riskFactors.join('; ')}>
                        <span>
                          <RiskChip rating={s.assessedRisk} />
                        </span>
                      </Tooltip>
                    ) : (
                      <RiskChip rating={s.assessedRisk} />
                    )}
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
      {raised.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography fontWeight={600} sx={{ mb: 1 }}>
              Risk assessment
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Process area</TableCell>
                  <TableCell>Library risk</TableCell>
                  <TableCell>Assessed risk</TableCell>
                  <TableCell>Raised by</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {raised.map((a) => (
                  <TableRow key={a.processArea}>
                    <TableCell>{a.processArea}</TableCell>
                    <TableCell>
                      <RiskChip rating={a.library} />
                    </TableCell>
                    <TableCell>
                      <RiskChip rating={a.assessed} />
                    </TableCell>
                    <TableCell>{a.factors.join('; ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {e.coverage && (
        <Card variant="outlined">
          <CardContent>
            <Typography fontWeight={600}>Coverage</Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {e.coverage.statement}
            </Typography>
            {e.coverage.excluded.length > 0 && (
              <Table size="small" sx={{ mt: 1 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Excluded process area</TableCell>
                    <TableCell>Reason</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {e.coverage.excluded.map((x) => (
                    <TableRow key={x.processArea}>
                      <TableCell>{x.processArea}</TableCell>
                      <TableCell>{x.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
