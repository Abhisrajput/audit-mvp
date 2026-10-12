import { ExpandMore as ExpandMoreIcon, Verified as VerifiedIcon } from '@mui/icons-material';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Chip, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { TabProps } from '../../pages/EngagementPage';
import type { VisibleTrailBundle } from '../../types';
import { ActionButton } from '../common';

interface Verification {
  valid: boolean;
  length: number;
  brokenAt: number | null;
  reason: string | null;
}

export default function TrailTab({ engagement: e }: TabProps) {
  const [trail, setTrail] = useState<VisibleTrailBundle[]>([]);
  const [verification, setVerification] = useState<Verification | null>(null);
  useEffect(() => {
    api<VisibleTrailBundle[]>(`/engagements/${e.id}/trail`).then((t) => setTrail(t.reverse()));
  }, [e]);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <ActionButton startIcon={<VerifiedIcon />} action={async () => setVerification(await api<Verification>('/trail/verify'))}>
          Verify hash chain
        </ActionButton>
        <Typography color="text.secondary">
          Every module run and human action is sealed into a SHA-256 hash chain with its inputs, retrieval set, log, QA decisions, output and versions.
        </Typography>
      </Stack>
      {verification && (
        <Alert severity={verification.valid ? 'success' : 'error'}>
          {verification.valid ? `Chain intact: ${verification.length} bundles verified.` : `Chain broken at bundle ${verification.brokenAt}: ${verification.reason}`}
        </Alert>
      )}
      <Box>
        {trail.map((b) => {
          const fails = b.qaActions.filter((a) => a.outcome === 'fail').length;
          return (
            <Accordion key={b.id} disableGutters variant="outlined" TransitionProps={{ unmountOnExit: true }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap" sx={{ width: '100%' }}>
                  <Typography sx={{ fontFamily: 'monospace', minWidth: 40 }}>#{b.seq}</Typography>
                  <Chip size="small" color={b.moduleId.startsWith('human:') ? 'default' : 'primary'} label={b.moduleId} />
                  {b.redacted && <Chip size="small" variant="outlined" label="details restricted" />}
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    by {b.actor} · {b.provider.id}/{b.provider.model} · {new Date(b.finishedAt).toLocaleString()}
                  </Typography>
                  {b.qaActions.length > 0 && <Chip size="small" color={fails ? 'error' : 'success'} variant="outlined" label={`${b.qaActions.length} QA decisions${fails ? `, ${fails} fail` : ''}`} />}
                  <Typography variant="caption" sx={{ fontFamily: 'monospace' }} color="text.secondary">
                    {b.hash.slice(0, 12)}…
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'grey.100', borderRadius: 1, fontSize: 12, maxHeight: 420, overflow: 'auto' }}>
                  {JSON.stringify(b, null, 2)}
                </Box>
              </AccordionDetails>
            </Accordion>
          );
        })}
      </Box>
    </Stack>
  );
}
