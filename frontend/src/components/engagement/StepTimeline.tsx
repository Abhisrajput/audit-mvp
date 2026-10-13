import { Box, Chip, Link, Stack, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import { describeStep, formatUtc } from '../../agents';
import type { AgentStep } from '../../types';

const SHOWN = 50;
const POLICY_LABEL = { llm: 'model', rules: 'rules', forced: 'only option' } as const;

/** Every step of the run, oldest first: what was decided and why, who chose it, and what it cost. */
export default function StepTimeline({ steps }: { steps: AgentStep[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? steps : steps.slice(-SHOWN);
  if (!steps.length) return <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>No steps yet.</Typography>;
  return (
    <Stack sx={{ mt: 1, borderLeft: 2, borderColor: 'divider', pl: 2 }}>
      {steps.length > shown.length && (
        <Link component="button" variant="body2" onClick={() => setAll(true)} sx={{ alignSelf: 'flex-start', mb: 1 }}>
          Show all {steps.length} steps
        </Link>
      )}
      {shown.map((s) => {
        const v = describeStep(s);
        const tokens = s.tokensIn + s.tokensOut;
        return (
          <Box key={s.seq} sx={{ py: 0.75 }}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
              <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', minWidth: 36 }}>
                #{s.seq}
              </Typography>
              <Chip size="small" variant="outlined" label={s.kind.replace('_', ' ')} />
              <Typography variant="body2" fontWeight={500}>
                {v.title}
              </Typography>
              {v.policy && <Chip size="small" label={POLICY_LABEL[v.policy]} color={v.policy === 'llm' ? 'primary' : 'default'} variant={v.policy === 'forced' ? 'outlined' : 'filled'} />}
              {v.fallback && (
                <Tooltip title={`The rules decided because ${v.fallback}.`}>
                  <Chip size="small" color="warning" label="fallback to rules" />
                </Tooltip>
              )}
              {v.withoutModel && <Chip size="small" color="warning" variant="outlined" label="without model" />}
              {v.refused && <Chip size="small" color="error" label="refused" />}
            </Stack>
            {v.detail && (
              <Typography variant="body2" color="text.secondary" sx={{ ml: 5.5 }}>
                {v.detail}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ ml: 5.5, display: 'block' }}>
              {formatUtc(s.createdAt)} · {s.agent}
              {s.model ? ` · ${s.model}` : ''}
              {tokens ? ` · ${tokens.toLocaleString('en-US')} tokens, $${s.costUsd.toFixed(4)}` : ''}
              {s.durationMs ? ` · ${(s.durationMs / 1000).toFixed(1)} s` : ''}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}
