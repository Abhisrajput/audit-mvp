import { Gavel as GavelIcon } from '@mui/icons-material';
import { Alert, Box, Button, Card, CardContent, Chip, Collapse, Divider, Link, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { formatUtc, gateSigning, sortGates, subjectLabel } from '../../agents';
import { useSession } from '../../session';
import { openSigningWindow, signGateWithReauth } from '../../signing';
import type { Gate } from '../../types';
import { ActionButton } from '../common';
import QaReportView from './QaReportView';
import type { AgentRunState } from './useAgentRun';

const title = (g: Gate) => (g.kind === 'finding' ? `Finding ${g.subjectId}` : `${subjectLabel(g.subjectKey).replace(/^./, (c) => c.toUpperCase())} gate`);

function GateCard({ gate, agent, onSigned, showFindings }: { gate: Gate; agent: AgentRunState; onSigned: () => Promise<void>; showFindings: () => void }) {
  const { user } = useSession();
  const [comment, setComment] = useState('');
  const [waiting, setWaiting] = useState<AbortController | null>(null);
  const signing = gateSigning(gate, user, agent.runs);
  const sign = (action: 'approve' | 'reject') => async () => {
    if (action === 'reject' && !comment.trim()) throw new Error('A rejection needs a comment: the agent redrafts from it.');
    // Open the window first, synchronously in the click, or the browser blocks it as a pop-up.
    const popup = openSigningWindow();
    const controller = new AbortController();
    setWaiting(controller);
    try {
      await signGateWithReauth(gate.id, action, comment.trim(), popup, { signal: controller.signal });
      setComment('');
    } finally {
      setWaiting(null);
      // Show what the server recorded, whatever happened here.
      await Promise.all([agent.refresh(), onSigned()]).catch(() => undefined);
    }
  };
  return (
    <Card variant="outlined" sx={{ borderLeft: 4, borderLeftColor: 'warning.main' }}>
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <GavelIcon fontSize="small" color="warning" />
          <Typography fontWeight={600}>{title(gate)}</Typography>
          <Chip size="small" variant="outlined" label={`attempt ${gate.attempt}`} />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            {gate.id} · opened {formatUtc(gate.openedAt)}
          </Typography>
        </Stack>
        {gate.qaReport && (
          <Box sx={{ mt: 1 }}>
            <QaReportView report={gate.qaReport} threshold={agent.settings?.qaThreshold ?? null} />
          </Box>
        )}
        <Divider sx={{ my: 1.5 }} />
        {waiting && (
          <Alert
            severity="info"
            sx={{ mb: 1.5 }}
            action={
              <Button color="inherit" size="small" onClick={() => waiting.abort()}>
                Cancel
              </Button>
            }
          >
            Waiting for you to confirm your identity in the sign-in window…
          </Alert>
        )}
        {gate.kind === 'finding' ? (
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <Typography variant="body2" color="text.secondary">
              {signing.note}
            </Typography>
            <Button size="small" onClick={showFindings}>
              Open Findings
            </Button>
          </Stack>
        ) : signing.canSign ? (
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <TextField size="small" placeholder="Comment (needed to reject)" value={comment} onChange={(e) => setComment(e.target.value)} sx={{ minWidth: 320 }} />
            <ActionButton size="small" color="success" disabled={!!waiting} action={sign('approve')}>
              Approve
            </ActionButton>
            <ActionButton size="small" color="warning" variant="outlined" disabled={!!waiting || !comment.trim()} action={sign('reject')}>
              Reject
            </ActionButton>
            <Typography variant="caption" color="text.secondary">
              {signing.note} A rejection goes back to the agent as its instruction.
            </Typography>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {signing.note}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

/** The engagement's gates (agent spec §7.2): each open one with its QA review and signing; decided ones on request. */
export default function GateList({ agent, onSigned, showFindings }: { agent: AgentRunState; onSigned: () => Promise<void>; showFindings: () => void }) {
  const [history, setHistory] = useState(false);
  if (!agent.gates.length) return null;
  const { open, decided, superseded } = sortGates(agent.gates);
  return (
    <Stack spacing={1.5} sx={{ mt: 2 }}>
      <Typography variant="subtitle1" fontWeight={600}>
        Gates
      </Typography>
      {open.map((g) => (
        <GateCard key={g.id} gate={g} agent={agent} onSigned={onSigned} showFindings={showFindings} />
      ))}
      {!open.length && (
        <Typography variant="body2" color="text.secondary">
          No gate is open.
        </Typography>
      )}
      {(decided.length > 0 || superseded > 0) && (
        <Link component="button" variant="body2" onClick={() => setHistory(!history)} sx={{ alignSelf: 'flex-start' }}>
          {history ? 'Hide' : 'Show'} {decided.length} decided gate(s){superseded ? `; ${superseded} superseded (changed before anyone signed) not listed` : ''}
        </Link>
      )}
      <Collapse in={history} unmountOnExit>
        <Stack spacing={0.5}>
          {decided.map((g) => (
            <Typography key={g.id} variant="body2" color="text.secondary">
              {title(g)}, attempt {g.attempt}: <b>{g.state}</b>
              {g.closedAt ? ` ${formatUtc(g.closedAt)}` : ''}
              {g.comment ? ` — "${g.comment}"` : ''}
            </Typography>
          ))}
        </Stack>
      </Collapse>
    </Stack>
  );
}
