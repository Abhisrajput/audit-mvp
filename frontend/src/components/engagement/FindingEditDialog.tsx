import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { api } from '../../api';
import { IMPACT_LABELS, IMPACTS, impactOfRating, LIKELIHOOD_LABELS, LIKELIHOODS, ratingOf } from '../../judgment';
import type { EvidenceLink, Finding, Impact, Likelihood } from '../../types';
import { ActionButton, RiskChip } from '../common';
import EvidencePicker from '../evidence/EvidencePicker';
import type { CardContext } from './FindingsTab';

export const FIELDS = ['condition', 'criteria', 'cause', 'effect', 'recommendation'] as const;

/** Edit a finding: people change likelihood and impact, and the rating follows from the matrix. */
export default function FindingEditDialog({ finding, ctx, onClose }: { finding: Finding; ctx: CardContext; onClose: () => void }) {
  // Findings saved before likelihood and impact existed start from 'possible' and the impact their stored rating implies.
  const legacy = !finding.likelihood || !finding.impact;
  const [f, setF] = useState({
    ...finding,
    refs: finding.evidenceRefs.join(', '),
    evidence: (finding.evidence ?? []) as EvidenceLink[],
    likelihood: (finding.likelihood ?? 'possible') as Likelihood,
    impact: (finding.impact ?? impactOfRating(finding.rating)) as Impact,
  });
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Edit finding {finding.id}</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          Saving resets sign-offs to draft and re-runs the triple-citation gate. Editing makes you a preparer of this finding, so you will not be able to sign it.
        </Alert>
        <Stack spacing={2}>
          <TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap">
            <TextField select label="Likelihood" value={f.likelihood} onChange={(e) => setF({ ...f, likelihood: e.target.value as Likelihood })} sx={{ minWidth: 160 }}>
              {LIKELIHOODS.map((l) => (
                <MenuItem key={l} value={l}>
                  {LIKELIHOOD_LABELS[l]}
                </MenuItem>
              ))}
            </TextField>
            <TextField select label="Impact" value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value as Impact })} sx={{ minWidth: 160 }}>
              {IMPACTS.map((i) => (
                <MenuItem key={i} value={i}>
                  {IMPACT_LABELS[i]}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="body2">Rating:</Typography>
            <RiskChip rating={ratingOf(f.likelihood, f.impact)} />
          </Stack>
          {legacy && (
            <Typography variant="caption" color="text.secondary">
              This finding was saved before likelihood and impact were recorded, so these are defaults taken from its stored rating ({finding.rating}). Set them to what you judge; the rating follows.
            </Typography>
          )}
          {FIELDS.map((k) => (
            <TextField key={k} label={k[0].toUpperCase() + k.slice(1)} multiline minRows={2} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          ))}
          <EvidencePicker engagementId={ctx.engagementId} value={f.evidence} onChange={(evidence) => setF({ ...f, evidence })} />
          <TextField label="Other references" value={f.refs} onChange={(e) => setF({ ...f, refs: e.target.value })} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <ActionButton
          action={async () => {
            await api(`/engagements/${ctx.engagementId}/findings/${finding.id}`, {
              method: 'PUT',
              ifMatch: ctx.version,
              body: {
                title: f.title,
                likelihood: f.likelihood,
                impact: f.impact,
                ...Object.fromEntries(FIELDS.map((k) => [k, f[k]])),
                evidence: f.evidence,
                evidenceRefs: f.refs.split(',').map((s) => s.trim()).filter(Boolean),
              },
            });
            await ctx.reload();
            onClose();
          }}
        >
          Save
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}
