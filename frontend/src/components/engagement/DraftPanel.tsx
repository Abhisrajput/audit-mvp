import { Alert, Box, Button, Chip, Link, Stack, Typography } from '@mui/material';
import { useState } from 'react';
import { notifyChanged } from '../../assistant';
import { acceptable, confidenceColor, discardDraft } from '../../drafting';
import { linkLabel } from '../../evidence';
import type { DocumentRecord, Engagement, TestDraft } from '../../types';
import { ActionButton } from '../common';
import TextDrawer from '../evidence/TextDrawer';

interface Props {
  draft: TestDraft;
  documents: DocumentRecord[];
  canEdit: boolean;
  engagementId: string;
  version?: number;
  onAccept: () => void;
  onDiscarded: (e: Engagement) => void;
}

const designLabel = (v: boolean | null) => (v === null ? 'Not assessed' : v ? 'Yes' : 'No');

export default function DraftPanel({ draft, documents, canEdit, engagementId, version, onAccept, onDiscarded }: Props) {
  const [reading, setReading] = useState<{ documentId: string; page?: number } | null>(null);
  const p = draft.proposal;
  const filename = (id: string) => documents.find((d) => d.id === id)?.filename ?? id;
  return (
    <Alert severity="info" icon={false} sx={{ mb: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography fontWeight={600}>Agent draft</Typography>
          <Chip size="small" color={confidenceColor(draft.confidence)} label={`${draft.confidence} confidence`} />
          {draft.qa.blocking.map((f) => <Chip key={`b-${f}`} size="small" color="error" variant="outlined" label={f} />)}
          {draft.qa.advisory.map((f) => <Chip key={`a-${f}`} size="small" color="warning" variant="outlined" label={f} />)}
        </Stack>
        {p ? (
          <Box>
            <Typography variant="body2">
              Design adequate: <b>{designLabel(p.designAdequate)}</b> · sample <b>{p.sampleTested}</b> · exceptions <b>{p.exceptions}</b>
            </Typography>
            {p.observation && <Typography variant="body2">{p.observation}</Typography>}
          </Box>
        ) : (
          <Typography variant="body2">Found only: the agent located evidence but proposed no result.</Typography>
        )}
        {draft.evidence.length > 0 && (
          <Stack spacing={0.5}>
            {draft.evidence.map((e, i) => (
              <Box key={`${e.documentId}-${e.page ?? ''}-${i}`}>
                <Link component="button" type="button" variant="body2" onClick={() => setReading({ documentId: e.documentId, page: e.page })}>
                  {linkLabel(e, documents)}
                </Link>
                <Typography variant="body2" component="blockquote" color="text.secondary" sx={{ m: 0, pl: 1.5, borderLeft: 2, borderColor: 'divider' }}>
                  {e.quote}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
        {draft.couldNotVerify.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary">Could not verify:</Typography>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {draft.couldNotVerify.map((c, i) => <li key={i}><Typography variant="caption" color="text.secondary">{c}</Typography></li>)}
            </ul>
          </Box>
        )}
        {canEdit && (
          <Stack direction="row" spacing={1}>
            {acceptable(draft) && <Button size="small" variant="contained" onClick={onAccept}>Accept</Button>}
            <ActionButton
              size="small"
              variant="outlined"
              action={async () => {
                const e = await discardDraft(engagementId, draft.rowId, version);
                onDiscarded(e);
                notifyChanged(engagementId);
              }}
            >
              Discard
            </ActionButton>
          </Stack>
        )}
      </Stack>
      <TextDrawer documentId={reading?.documentId ?? null} filename={reading ? filename(reading.documentId) : ''} initialPage={reading?.page} onClose={() => setReading(null)} />
    </Alert>
  );
}
