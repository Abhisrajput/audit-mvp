import { Alert, Box, Card, Chip, Collapse, Link, Stack, Step, StepButton, Stepper, Tab, Tabs, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { api } from '../api';
import FieldworkTab from '../components/engagement/FieldworkTab';
import FindingsTab from '../components/engagement/FindingsTab';
import RcmTab from '../components/engagement/RcmTab';
import ReportTab from '../components/engagement/ReportTab';
import ScopeTab from '../components/engagement/ScopeTab';
import TrailTab from '../components/engagement/TrailTab';
import type { Engagement, TrailBundle } from '../types';

const STEPS = ['Risk & scope', 'RCM', 'Fieldwork & testing', 'Findings', 'Report'];

export interface TabProps {
  engagement: Engagement;
  setEngagement: (e: Engagement) => void;
  run: (moduleId: string) => Promise<void>;
}

function GateSummary({ bundle }: { bundle: TrailBundle }) {
  const [open, setOpen] = useState(false);
  const count = (o: string) => bundle.qaActions.filter((a) => a.outcome === o).length;
  const fails = count('fail');
  const warns = count('warn');
  return (
    <Alert severity={fails ? 'error' : warns ? 'warning' : 'success'} sx={{ mb: 2 }}>
      <Typography variant="body2">
        <b>{bundle.moduleId}</b> ran as {bundle.id} via {bundle.provider.id}/{bundle.provider.model}. QA gates: {count('pass')} passed, {warns} warnings, {fails} failed.{' '}
        {bundle.qaActions.length > 0 && (
          <Link component="button" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'} gate decisions
          </Link>
        )}
      </Typography>
      <Collapse in={open}>
        <Box component="ul" sx={{ m: 0, pl: 2 }}>
          {bundle.qaActions.map((a, i) => (
            <li key={i}>
              <Typography variant="body2">
                [{a.gate}] {a.outcome.toUpperCase()} on {a.target}: {a.detail} {a.action !== 'none' && <b>→ {a.action}</b>}
              </Typography>
            </li>
          ))}
        </Box>
      </Collapse>
    </Alert>
  );
}

export default function EngagementPage() {
  const { id } = useParams();
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [tab, setTab] = useState(0);
  const [lastRun, setLastRun] = useState<TrailBundle | null>(null);

  const load = useCallback(() => api<Engagement>(`/engagements/${id}`).then(setEngagement), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (moduleId: string) => {
    const res = await api<{ bundle: TrailBundle; engagement: Engagement }>(`/engagements/${id}/modules/${moduleId}/run`, { method: 'POST', body: {}, ifMatch: engagement?.version });
    setEngagement(res.engagement);
    setLastRun(res.bundle);
  };

  if (!engagement) return null;
  const e = engagement;
  const done = [e.scope.length > 0, e.rcm.length > 0, Object.keys(e.testResults).length > 0, e.findings.length > 0, !!e.report];
  const props: TabProps = { engagement: e, setEngagement, run };

  return (
    <Stack spacing={2}>
      <Box>
        <Link component={RouterLink} to="/engagements" underline="hover">
          ← Engagements
        </Link>
        <Typography variant="h5" fontWeight={600} sx={{ mt: 1 }}>
          {e.name}
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mt: 0.5 }}>
          <Chip size="small" label={e.id} sx={{ fontFamily: 'monospace' }} />
          <Typography color="text.secondary">
            {e.entity} · {e.site} · {e.periodFrom} to {e.periodTo}
          </Typography>
          {e.packIds.map((p) => (
            <Chip key={p} size="small" color="primary" variant="outlined" label={p} />
          ))}
        </Stack>
        <Typography variant="body2" sx={{ mt: 1, maxWidth: 1000 }}>
          <b>Scope:</b> {e.scopeStatement}
        </Typography>
      </Box>

      <Card variant="outlined" sx={{ p: 2 }}>
        <Stepper nonLinear activeStep={tab}>
          {STEPS.map((label, i) => (
            <Step key={label} completed={done[i]}>
              <StepButton onClick={() => setTab(i)}>{label}</StepButton>
            </Step>
          ))}
        </Stepper>
      </Card>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable">
        {[...STEPS, 'Audit trail'].map((l) => (
          <Tab key={l} label={l} />
        ))}
      </Tabs>

      {lastRun && tab < 5 && <GateSummary bundle={lastRun} />}

      {tab === 0 && <ScopeTab {...props} />}
      {tab === 1 && <RcmTab {...props} />}
      {tab === 2 && <FieldworkTab {...props} />}
      {tab === 3 && <FindingsTab {...props} />}
      {tab === 4 && <ReportTab {...props} />}
      {tab === 5 && <TrailTab {...props} />}
    </Stack>
  );
}
