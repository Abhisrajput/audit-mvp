import { Alert, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { agentApi, formatUtc } from '../../agents';
import type { FindingResponse, ResponseKind } from '../../types';
import { ActionButton } from '../common';

const KINDS: Record<ResponseKind, string> = { agree: 'Agree', partially_agree: 'Partially agree', disagree: 'Disagree' };

/** Management's response to an approved finding: recorded outside the signed finding, history kept below. */
export default function ResponsePanel({ engagementId, findingId, version, canRecord, locked, current, reload }: {
  engagementId: string;
  findingId: string;
  version: number | undefined;
  canRecord: boolean;
  locked: boolean;
  /** The latest response, from the engagement; a change to it reloads the history. */
  current?: FindingResponse;
  reload: () => Promise<void>;
}) {
  const [history, setHistory] = useState<FindingResponse[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<ResponseKind>('agree');
  const [owner, setOwner] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [plan, setPlan] = useState('');
  useEffect(() => {
    let live = true;
    agentApi.responses(engagementId, findingId).then(
      (r) => live && (setHistory(r), setLoadError(null)),
      (err) => live && setLoadError(err instanceof Error ? err.message : 'Could not load the response history'),
    );
    return () => {
      live = false;
    };
  }, [engagementId, findingId, current?.id]);

  const disabled = locked || !canRecord;
  return (
    <Stack spacing={1.5} sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2">Management response</Typography>
      {locked && <Alert severity="info">The report is approved, so management responses are closed.</Alert>}
      {!locked && !canRecord && <Typography variant="caption" color="text.secondary">Your role cannot record a management response.</Typography>}
      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
        <TextField select size="small" label="Response" value={kind} onChange={(e) => setKind(e.target.value as ResponseKind)} disabled={disabled} sx={{ minWidth: 180 }}>
          {Object.entries(KINDS).map(([k, label]) => (
            <MenuItem key={k} value={k}>
              {label}
            </MenuItem>
          ))}
        </TextField>
        <TextField size="small" label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={disabled} />
        <TextField size="small" type="date" label="Due date" InputLabelProps={{ shrink: true }} value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={disabled} />
      </Stack>
      <TextField size="small" multiline minRows={2} label="Action plan" value={plan} onChange={(e) => setPlan(e.target.value)} disabled={disabled} inputProps={{ maxLength: 4000 }} />
      <div>
        <ActionButton
          size="small"
          disabled={disabled || !owner.trim()}
          action={async () => {
            await agentApi.recordResponse(engagementId, findingId, { response: kind, owner: owner.trim(), dueDate: dueDate || null, actionPlan: plan }, version);
            setOwner('');
            setDueDate('');
            setPlan('');
            await reload();
          }}
        >
          Record response
        </ActionButton>
      </div>
      {loadError && <Typography variant="caption" color="warning.main">{loadError}</Typography>}
      {history.length > 0 && (
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">History, oldest first (the last is current)</Typography>
          {history.map((r) => (
            <Typography key={r.id} variant="body2">
              {formatUtc(r.recordedAt)} · {KINDS[r.response]} · owner {r.owner}
              {r.dueDate ? ` · due ${r.dueDate}` : ''} · recorded by {r.recordedBy}
              {r.actionPlan ? ` — ${r.actionPlan}` : ''}
            </Typography>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
