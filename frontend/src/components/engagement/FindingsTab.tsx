import { PlayArrow as PlayArrowIcon } from '@mui/icons-material';
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Button, Card, CardContent, Chip, Divider, Grid, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { findingContentHash, openFindingGate, reviewIsCurrent } from '../../agents';
import { IMPACT_LABELS, LIKELIHOOD_LABELS, memoFor, responsesLocked } from '../../judgment';
import type { TabProps } from '../../pages/EngagementPage';
import { canPrepare } from '../../roles';
import { openSigningWindow, signWithReauth } from '../../signing';
import { useSession } from '../../session';
import type { Engagement, Finding, Gate, SignOff } from '../../types';
import { ActionButton, Citations, RiskChip, StatusChip } from '../common';
import FindingEditDialog, { FIELDS } from './FindingEditDialog';
import MemoView from './MemoView';
import QaReportView from './QaReportView';
import ResponsePanel from './ResponsePanel';

/** 'YYYY-MM-DD HH:MM UTC', as in the report and the CSV. */
const utc = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
};

/** How the signer proved who they were. A legacy sign-off (no signature record) is never shown as re-authenticated. */
function howSigned(s: SignOff): string {
  if (s.legacy || !s.signatureId) return ' · legacy signature (before Part 11)';
  if (!s.reauth || s.reauth.method === 'none') return ' · not re-authenticated';
  return ` · re-authenticated ${s.reauth.method === 'oidc' ? 'with the identity provider' : 'by demo confirmation'}`;
}

export interface CardContext {
  engagementId: string;
  version: number | undefined;
  reload: () => Promise<void>;
  /** The engagement's finding memos and responses, and whether the report gate has closed responses. */
  engagement: Engagement;
  responsesLocked: boolean;
}

function FindingCard({ f, ctx, gate, qaThreshold }: { f: Finding; ctx: CardContext; gate: Gate | null; qaThreshold: number | null }) {
  const { user } = useSession();
  // The review is shown only while it describes the finding on screen: a gate is superseded only when the worker next runs.
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setHash(null);
    findingContentHash(f).then((h) => live && setHash(h), () => undefined);
    return () => {
      live = false;
    };
  }, [f]);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [waiting, setWaiting] = useState<AbortController | null>(null);
  const sign = (action: 'review' | 'approve' | 'reject') => async () => {
    // Open the window first, synchronously in the click, or the browser blocks it as a pop-up.
    const popup = openSigningWindow();
    const controller = new AbortController();
    setWaiting(controller);
    try {
      await signWithReauth(ctx.engagementId, f.id, action, comment, popup, { signal: controller.signal });
      setComment('');
    } finally {
      setWaiting(null);
      // Show what the server recorded, whatever happened here.
      await ctx.reload().catch(() => undefined);
    }
  };
  const role = user?.role;
  const memo = memoFor(ctx.engagement, `finding:${f.rowId}`);
  const preparedByMe = !!user && (f.preparedBy ?? []).includes(user.id);
  const reviewedByMe = !!user && f.signOffs.some((s) => s.userId === user.id);
  const canReview = role === 'audit_manager' && f.status === 'draft';
  const canApprove = role === 'cae' && f.status === 'reviewed';
  const blockedBySod = (canReview || canApprove) && (preparedByMe || (canApprove && reviewedByMe));

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
          {f.preparedBy?.length ? ` · prepared by ${f.preparedBy.join(', ')}` : ''}
        </Typography>
        {f.status === 'blocked' && (
          <Alert severity="error" sx={{ mt: 1 }}>
            Blocked by QA gate: {f.blockedReasons.join('; ')}
          </Alert>
        )}
        {gate?.qaReport && hash !== null && !reviewIsCurrent(gate, hash) && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            The finding has changed since the agent's QA review; a fresh review follows.
          </Alert>
        )}
        {gate?.qaReport && reviewIsCurrent(gate, hash) && (
          <Alert severity="info" icon={false} sx={{ mt: 1.5 }}>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              The agent drafted this finding and opened a gate on it (attempt {gate.attempt}). Its QA review, for whoever signs:
            </Typography>
            <QaReportView report={gate.qaReport} threshold={qaThreshold} />
          </Alert>
        )}
        {(f.likelihood || f.impact) && (
          <Typography variant="body2" sx={{ mt: 1 }}>
            <b>Likelihood:</b> {f.likelihood ? LIKELIHOOD_LABELS[f.likelihood] : '—'} · <b>Impact:</b> {f.impact ? IMPACT_LABELS[f.impact] : '—'}
          </Typography>
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
        {f.rootCause && (
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mt: 1.5 }}>
            <Typography variant="subtitle2">Root cause</Typography>
            <Chip size="small" variant="outlined" label={f.rootCause.category} />
            {f.rootCause.confirmed ? <Chip size="small" color="success" label="confirmed" /> : <Chip size="small" color="warning" label="unconfirmed" />}
            <Typography variant="body2" sx={{ flexBasis: '100%' }}>
              {f.rootCause.analysis}
            </Typography>
            {!f.rootCause.confirmed && (
              <Typography variant="caption" color="warning.main" sx={{ flexBasis: '100%' }}>
                Not yet confirmed with the process owner; confirm it before the exit meeting.
              </Typography>
            )}
          </Stack>
        )}
        {memo && (
          <Accordion disableGutters variant="outlined" sx={{ mt: 1.5 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="body2">Why this rating (judgment memo)</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <MemoView memo={memo} />
            </AccordionDetails>
          </Accordion>
        )}
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
              <Typography key={i} component="div" variant="body2" color="text.secondary">
                ✍ {s.meaning} by {s.userName} ({s.role}) at {utc(s.at)}
                {howSigned(s)}
                {s.signatureId && ` · ${s.signatureId}`}
                {s.comment && ` — "${s.comment}"`}
                {s.broken && <Chip size="small" color="error" label="Signature broken: does not match its signature record" sx={{ ml: 1 }} />}
              </Typography>
            ))}
          </Stack>
        )}
        {!!f.signatureIssues?.length && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            Signature records disagree with this finding: {f.signatureIssues.join('; ')}
          </Alert>
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
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          {canPrepare(role) && f.status !== 'approved' && (
            <Button size="small" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {(canReview || canApprove) && !blockedBySod && (
            <>
              <TextField size="small" placeholder="Sign-off comment" value={comment} onChange={(e) => setComment(e.target.value)} sx={{ minWidth: 280 }} />
              <Typography variant="caption" color="text.secondary">
                Signing opens a window where you confirm your identity again.
              </Typography>
              {canReview && (
                <ActionButton size="small" disabled={!!waiting} action={sign('review')}>
                  Sign as reviewed
                </ActionButton>
              )}
              {canApprove && (
                <>
                  <ActionButton size="small" color="success" disabled={!!waiting} action={sign('approve')}>
                    Approve
                  </ActionButton>
                  <ActionButton size="small" color="warning" variant="outlined" disabled={!!waiting} action={sign('reject')}>
                    Reject
                  </ActionButton>
                </>
              )}
            </>
          )}
          {blockedBySod && (
            <Typography variant="caption" color="text.secondary">
              You {preparedByMe ? 'prepared' : 'reviewed'} this finding, so another person must sign it.
            </Typography>
          )}
          {f.status === 'draft' && role !== 'audit_manager' && <Typography variant="caption" color="text.secondary">Awaiting review by an audit manager.</Typography>}
          {f.status === 'reviewed' && role !== 'cae' && <Typography variant="caption" color="text.secondary">Awaiting approval by the Chief Audit Executive.</Typography>}
        </Stack>
        {f.status === 'approved' && (
          <ResponsePanel
            engagementId={ctx.engagementId}
            findingId={f.id}
            version={ctx.version}
            canRecord={canPrepare(role)}
            locked={ctx.responsesLocked}
            current={ctx.engagement.responses?.[f.id]}
            reload={ctx.reload}
          />
        )}
      </CardContent>
      {editing && <FindingEditDialog finding={f} ctx={ctx} onClose={() => setEditing(false)} />}
    </Card>
  );
}

export default function FindingsTab({ engagement: e, setEngagement, run, gates, qaThreshold }: TabProps) {
  const ctx: CardContext = {
    engagementId: e.id,
    version: e.version,
    reload: async () => setEngagement(await api<Engagement>(`/engagements/${e.id}`)),
    engagement: e,
    responsesLocked: responsesLocked(gates),
  };
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <ActionButton startIcon={<PlayArrowIcon />} action={() => run('gaps')}>
          Run Gap Writer
        </ActionButton>
        <Typography color="text.secondary">
          Drafts a finding for each failed control. Approved findings are locked; others are redrafted. Whoever runs it prepares the drafts and cannot sign them.
        </Typography>
      </Stack>
      {e.findings.map((f) => (
        <FindingCard key={f.id} f={f} ctx={ctx} gate={openFindingGate(gates, f.id)} qaThreshold={qaThreshold} />
      ))}
      {!e.findings.length && <Typography color="text.secondary">No findings yet.</Typography>}
    </Stack>
  );
}
