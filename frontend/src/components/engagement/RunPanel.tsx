import { Pause as PauseIcon, PlayArrow as PlayArrowIcon, SmartToyOutlined as AgentIcon, StopCircleOutlined as StopIcon, TrendingUp as RaiseIcon } from '@mui/icons-material';
import { Alert, Box, Button, Card, CardContent, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, Grid, LinearProgress, Link, Stack, TextField, Typography } from '@mui/material';
import { useState, type ReactNode } from 'react';
import { agentApi, BUDGET_LABEL, budgetProblem, explainStatus, hasEnded, spendRows, STATUS_CHIP } from '../../agents';
import { canPrepare } from '../../roles';
import { useSession } from '../../session';
import type { Budget } from '../../types';
import { ActionButton } from '../common';
import GateList from './GateList';
import StepTimeline from './StepTimeline';
import type { AgentRunState } from './useAgentRun';

const FIELDS = Object.keys(BUDGET_LABEL) as (keyof Budget)[];

/** Starts a run with a budget at or below the server's ceiling, or raises a live run's budget. */
function BudgetDialog(props: {
  title: string;
  intro: ReactNode;
  initial: Budget;
  bounds: { min?: Budget; max?: Budget };
  submitLabel: string;
  onSubmit: (budget: Budget) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState<Record<keyof Budget, string>>({
    maxSteps: String(props.initial.maxSteps), maxTokens: String(props.initial.maxTokens), maxCostUsd: String(props.initial.maxCostUsd),
  });
  const next: Budget = { maxSteps: Number(text.maxSteps), maxTokens: Number(text.maxTokens), maxCostUsd: Number(text.maxCostUsd) };
  const problem = budgetProblem(next, props.bounds);
  return (
    <Dialog open onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{props.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {props.intro}
          {FIELDS.map((k) => (
            <TextField
              key={k}
              type="number"
              label={BUDGET_LABEL[k]}
              value={text[k]}
              onChange={(e) => setText({ ...text, [k]: e.target.value })}
              inputProps={{ min: 0, step: k === 'maxCostUsd' ? 0.5 : 1 }}
            />
          ))}
          <Typography variant="caption" color="text.secondary">
            An iteration is one decision and what it led to, so it usually adds two or more steps to the run.
          </Typography>
          {problem && <Alert severity="warning">{problem}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>Cancel</Button>
        <ActionButton
          disabled={!!problem}
          action={async () => {
            await props.onSubmit(next);
            props.onClose();
          }}
        >
          {props.submitLabel}
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}

export interface RunPanelProps {
  engagementId: string;
  agent: AgentRunState;
  /** Reloads the engagement after a signature, so the page shows what the server recorded. */
  onSigned: () => Promise<void>;
  /** Opens the Findings tab, where finding gates are signed. */
  showFindings: () => void;
}

/** The engagement's agent run (agent spec §7.2): status and reason, spend against budget, controls, steps. */
export default function RunPanel({ engagementId, agent, onSigned, showFindings }: RunPanelProps) {
  const { user } = useSession();
  const [dialog, setDialog] = useState<'start' | 'budget' | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showSteps, setShowSteps] = useState(false);
  const { settings, run, steps, error, refresh } = agent;
  const liveRun = run && !hasEnded(run) ? run : null;
  const preparer = canPrepare(user?.role);
  const paused = liveRun?.statusReason === 'paused_by_user';
  const act = (call: (runId: string) => Promise<unknown>) => async () => {
    if (!liveRun) return;
    await call(liveRun.id);
    await refresh();
  };
  const status = run ? explainStatus(run) : null;
  const chip = run ? STATUS_CHIP[run.status] : null;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
          <AgentIcon color="primary" />
          <Typography variant="h6" sx={{ fontSize: 17 }}>
            Agent run
          </Typography>
          {chip && <Chip size="small" color={chip.color} label={chip.label} />}
          {run && <Chip size="small" variant="outlined" label={run.id} sx={{ fontFamily: 'monospace' }} />}
          {run && (
            <Typography variant="caption" color="text.secondary">
              {run.policy === 'llm' ? 'decides with the model, within the rails' : 'decides by the offline rules'} · started by {run.startedBy}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {preparer && !liveRun && (
            <Button size="small" variant="contained" startIcon={<PlayArrowIcon />} disabled={!settings?.enabled} onClick={() => setDialog('start')}>
              Start agent run
            </Button>
          )}
          {preparer && liveRun && !paused && liveRun.status !== 'needs_human' && (
            <ActionButton size="small" variant="outlined" startIcon={<PauseIcon />} action={act(agentApi.pause)}>
              Pause
            </ActionButton>
          )}
          {preparer && liveRun && (paused || liveRun.status === 'needs_human') && (
            <ActionButton size="small" startIcon={<PlayArrowIcon />} action={act(agentApi.resume)}>
              Resume
            </ActionButton>
          )}
          {user?.role === 'audit_manager' && liveRun && (
            <Button size="small" startIcon={<RaiseIcon />} onClick={() => setDialog('budget')}>
              Raise budget
            </Button>
          )}
          {preparer && liveRun && (
            <ActionButton
              size="small"
              variant="outlined"
              color="warning"
              startIcon={<StopIcon />}
              action={act(async (runId) => {
                if (!window.confirm('Cancel this run? Its open gates close unsigned. Work it has already drafted stays.')) return;
                await agentApi.cancel(runId);
              })}
            >
              Cancel run
            </ActionButton>
          )}
        </Stack>

        {settings && !settings.enabled && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            Agent runs are switched off on this server (AGENT_ENABLED=false). Existing runs stay as they are.
          </Alert>
        )}
        {!run && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No agent run yet. A run drafts each stage in turn, has QA review it, and stops at each gate for a person to sign. It never signs, records test results or edits a reviewed finding.
          </Typography>
        )}
        {warnings.map((w) => (
          <Alert key={w} severity="warning" sx={{ mt: 1.5 }} onClose={() => setWarnings(warnings.filter((x) => x !== w))}>
            {w}
          </Alert>
        ))}
        {run && status && (
          <Alert severity={run.status === 'needs_human' || run.status === 'failed' ? 'warning' : 'info'} sx={{ mt: 1.5 }}>
            <Typography variant="body2">{status.text}</Typography>
            {status.next && (
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                <b>Next:</b> {status.next}
              </Typography>
            )}
          </Alert>
        )}
        {run && (
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            {spendRows(run).map((r) => (
              <Grid item xs={12} md={4} key={r.label}>
                <Typography variant="caption" color="text.secondary">
                  {r.label}
                </Typography>
                <LinearProgress variant="determinate" value={r.pct} color={r.pct >= 90 ? 'warning' : 'primary'} sx={{ my: 0.5 }} />
                <Typography variant="body2">
                  {r.used} of {r.limit}
                </Typography>
              </Grid>
            ))}
          </Grid>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            Could not refresh the agent run: {error}
          </Alert>
        )}
        <GateList agent={agent} onSigned={onSigned} showFindings={showFindings} />
        {run && (
          <Box sx={{ mt: 1.5 }}>
            <Link component="button" variant="body2" onClick={() => setShowSteps(!showSteps)}>
              {showSteps ? 'Hide' : 'Show'} the run's {steps.length} steps
            </Link>
            <Collapse in={showSteps} unmountOnExit>
              <StepTimeline steps={steps} />
            </Collapse>
          </Box>
        )}
      </CardContent>

      {dialog === 'start' && settings && (
        <BudgetDialog
          title="Start an agent run"
          submitLabel="Start"
          initial={settings.budget}
          bounds={{ max: settings.budget }}
          intro={
            <>
              <Typography variant="body2">
                The agent drafts the scope, the RCM, test plans, findings and the report in turn. QA reviews each one, and the run stops at each gate for a person to sign. Its work is recorded as done on your behalf, so you cannot sign its gates yourself.
              </Typography>
              {user?.role === 'audit_manager' && (
                <Alert severity="warning">As the run's starter you cannot sign its scope or RCM gates: another audit manager must.</Alert>
              )}
              <Typography variant="body2" color="text.secondary">
                You may set a budget below the server's limits. Only an audit manager can raise it later.
              </Typography>
            </>
          }
          onSubmit={async (budget) => {
            const started = await agentApi.start(engagementId, budget);
            setWarnings(started.warnings);
            await refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'budget' && liveRun && (
        <BudgetDialog
          title="Raise the run's budget"
          submitLabel="Raise budget"
          initial={liveRun.budget}
          bounds={{ min: liveRun.budget }}
          intro={<Typography variant="body2">A run stopped by its budget resumes at once. The change is recorded in the audit trail.</Typography>}
          onSubmit={async (budget) => {
            await agentApi.raiseBudget(liveRun.id, budget);
            await refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}
