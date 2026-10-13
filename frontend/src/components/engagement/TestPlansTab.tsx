import { Alert, Card, CardContent, Chip, Grid, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { api } from '../../api';
import { agentApi, formatUtc, planDraft, planPatch, REASON_MAX, rowsAwaitingTests, type PlanDraft } from '../../agents';
import type { TabProps } from '../../pages/EngagementPage';
import { canPrepare } from '../../roles';
import { useSession } from '../../session';
import type { Engagement, RcmRow, TestPlan } from '../../types';
import { ActionButton, RiskChip } from '../common';

const METHODS: TestPlan['selectionMethod'][] = ['random', 'all', 'judgemental'];

function PlanCard({ row, plan, engagementId, version, canEdit, onSaved }: {
  row: RcmRow;
  plan?: TestPlan;
  engagementId: string;
  version?: number;
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const [d, setD] = useState<PlanDraft | null>(plan ? planDraft(plan) : null);
  const set = (k: keyof PlanDraft) => (ev: React.ChangeEvent<HTMLInputElement>) => d && setD({ ...d, [k]: ev.target.value });
  const result = plan && d ? planPatch(plan, d) : null;
  const problem = result && 'problem' in result ? result.problem : null;
  const patch = result && 'patch' in result ? result.patch : null;
  const dirty = !!patch && Object.keys(patch).length > 0;

  return (
    <Card variant="outlined" sx={{ borderLeft: 4, borderLeftColor: plan?.notTestedJustification ? 'warning.main' : 'grey.400' }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }} useFlexGap flexWrap="wrap">
          <Typography sx={{ fontFamily: 'monospace' }}>{row.controlId}</Typography>
          <Typography fontWeight={600} sx={{ flex: 1 }}>
            {row.control}
          </Typography>
          <RiskChip rating={row.riskRating} />
          <Chip size="small" variant="outlined" label={`RCM sample ${row.sampleSize}`} />
          {plan?.notTestedJustification && <Chip size="small" color="warning" label="Not to be tested" />}
        </Stack>
        {!plan || !d ? (
          <Typography variant="body2" color="text.secondary">
            No plan yet. An agent run drafts one for every RCM row, starting from the row's sample size and test steps.
          </Typography>
        ) : (
          <>
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <TextField fullWidth size="small" label="Attribute tested" value={d.attribute} onChange={set('attribute')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField fullWidth size="small" label="Population" value={d.population} onChange={set('population')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={6} md={2}>
                <TextField fullWidth size="small" type="number" label="Sample size" value={d.sampleSize} onChange={set('sampleSize')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={6} md={3}>
                <TextField select fullWidth size="small" label="Selection" value={d.selectionMethod} onChange={set('selectionMethod')} disabled={!canEdit}>
                  {METHODS.map((m) => (
                    <MenuItem key={m} value={m}>
                      {m}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} md={7}>
                <TextField fullWidth size="small" multiline minRows={2} label="Evidence to request (one per line)" value={d.evidenceToRequest} onChange={set('evidenceToRequest')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={12}>
                <TextField fullWidth size="small" multiline minRows={2} label="Procedure" value={d.procedure} onChange={set('procedure')} disabled={!canEdit} />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  fullWidth
                  size="small"
                  multiline
                  label="Reason not to test this control"
                  helperText={`Only a person can decide this, never the agent. A run waiting for field work then counts this control as done. ${d.notTestedJustification.trim().length} of ${REASON_MAX} characters.`}
                  value={d.notTestedJustification}
                  onChange={set('notTestedJustification')}
                  disabled={!canEdit}
                />
              </Grid>
            </Grid>
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1.5 }} useFlexGap flexWrap="wrap">
              {canEdit && (
                <ActionButton
                  size="small"
                  variant="outlined"
                  disabled={!dirty}
                  action={async () => {
                    if (!patch) return;
                    await agentApi.editTestPlan(engagementId, row.id, patch, version);
                    await onSaved();
                  }}
                >
                  Save plan
                </ActionButton>
              )}
              {problem && <Typography variant="body2" color="warning.main">{problem}</Typography>}
              <Typography variant="caption" color="text.secondary">
                {plan.editedBy ? `Edited by ${plan.editedBy}${plan.editedAt ? ` at ${formatUtc(plan.editedAt)}` : ''}` : 'Drafted by the agent'}
              </Typography>
            </Stack>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Test plans for each RCM row (agent spec §7.2): drafted by the agent, edited by auditors. */
export default function TestPlansTab({ engagement: e, setEngagement }: TabProps) {
  const { user } = useSession();
  // The route returns the plan, not the engagement: reload it, or the next save would be refused as stale.
  const reload = async () => setEngagement(await api<Engagement>(`/engagements/${e.id}`));
  const awaiting = rowsAwaitingTests(e);
  const planned = e.rcm.filter((r) => e.testPlans[r.id]).length;
  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        {planned} of {e.rcm.length} controls have a test plan. The agent drafts each plan from its RCM row, and you can change any of it. A plan you edited is kept as it is until its RCM row changes.
      </Typography>
      {!e.rcm.length && <Typography color="text.secondary">Generate the risk & control matrix first.</Typography>}
      {e.rcm.length > 0 && awaiting.length > 0 && (
        <Alert severity="info">
          {awaiting.length} control(s) still need a recorded test (in Fieldwork & testing) or a reason not to test them: {awaiting.join(', ')}.
        </Alert>
      )}
      {e.rcm.map((r) => {
        const plan = e.testPlans[r.id];
        return (
          <PlanCard
            key={`${r.id}-${plan?.rowHash ?? ''}-${plan?.editedAt ?? ''}`}
            row={r}
            plan={plan}
            engagementId={e.id}
            version={e.version}
            canEdit={canPrepare(user?.role)}
            onSaved={reload}
          />
        );
      })}
    </Stack>
  );
}
