import { Alert, Box, Card, Chip, Collapse, Link, Stack, Step, StepButton, Stepper, Tab, Tabs, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { api } from '../api';
import { onChanged } from '../assistant';
import EvidenceTab from '../components/evidence/EvidenceTab';
import FieldworkTab from '../components/engagement/FieldworkTab';
import FindingsTab from '../components/engagement/FindingsTab';
import RcmTab from '../components/engagement/RcmTab';
import ReportTab from '../components/engagement/ReportTab';
import RunPanel from '../components/engagement/RunPanel';
import ScopeTab from '../components/engagement/ScopeTab';
import TestPlansTab from '../components/engagement/TestPlansTab';
import TrailTab from '../components/engagement/TrailTab';
import { useAgentRun } from '../components/engagement/useAgentRun';
import type { Engagement, Gate, TrailBundle } from '../types';

const STEPS = ['Risk & scope', 'RCM', 'Test plans', 'Evidence', 'Fieldwork & testing', 'Findings', 'Report'];
const EVIDENCE_TAB = 3;
const FIELDWORK_TAB = 4;
const FINDINGS_TAB = 5;
const REPORT_TAB = 6;
const TRAIL_TAB = STEPS.length;

export interface TabProps {
  engagement: Engagement;
  setEngagement: (e: Engagement) => void;
  run: (moduleId: string) => Promise<void>;
  /** The engagement's agent gates, for the QA review a finding's signer reads. */
  gates: Gate[];
  /** Refetch the agent state (runs and gates), e.g. after a change that can close or supersede a gate. */
  refreshGates: () => Promise<void>;
  /** The QA score a gate's review should reach (agent settings); null until loaded. */
  qaThreshold: number | null;
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
  // A write the assistant confirmed on this engagement reloads it.
  useEffect(() => onChanged((changed) => { if (changed === id) void load(); }), [id, load]);

  // The agent run, its steps and gates; when the agent drafts something, the engagement is reloaded.
  const agent = useAgentRun(id!, load);

  const run = async (moduleId: string) => {
    const res = await api<{ bundle: TrailBundle; engagement: Engagement }>(`/engagements/${id}/modules/${moduleId}/run`, { method: 'POST', body: {}, ifMatch: engagement?.version });
    setEngagement(res.engagement);
    setLastRun(res.bundle);
  };

  if (!engagement) return null;
  const e = engagement;
  // The Evidence step (index 3) has no completion state, so it is never marked done.
  const done = [e.scope.length > 0, e.rcm.length > 0, Object.keys(e.testPlans).length > 0, false, Object.keys(e.testResults).length > 0, e.findings.length > 0, !!e.report];
  const props: TabProps = { engagement: e, setEngagement, run, gates: agent.gates, refreshGates: agent.refresh, qaThreshold: agent.settings?.qaThreshold ?? null };

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

      <RunPanel engagement={e} agent={agent} onSigned={load} showFindings={() => setTab(FINDINGS_TAB)} />

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

      {lastRun && tab < TRAIL_TAB && <GateSummary bundle={lastRun} />}

      {tab === 0 && <ScopeTab {...props} />}
      {tab === 1 && <RcmTab {...props} />}
      {tab === 2 && <TestPlansTab {...props} />}
      {tab === EVIDENCE_TAB && <EvidenceTab engagementId={e.id} />}
      {tab === FIELDWORK_TAB && <FieldworkTab {...props} />}
      {tab === FINDINGS_TAB && <FindingsTab {...props} />}
      {tab === REPORT_TAB && <ReportTab {...props} />}
      {tab === TRAIL_TAB && <TrailTab {...props} />}
    </Stack>
  );
}
