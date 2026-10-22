import { Alert, Stack, Typography } from '@mui/material';
import type { JudgmentMemo } from '../../types';

/** The judgment memo behind a gate: what to verify first, then each call with its reasoning and standards. */
export default function MemoView({ memo }: { memo: JudgmentMemo }) {
  return (
    <Stack spacing={1.5}>
      {memo.forTheReviewer.length > 0 && (
        <Alert severity="info">
          <Typography variant="body2" fontWeight={600}>
            For the reviewer
          </Typography>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {memo.forTheReviewer.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {memo.calls.map((c, i) => (
        <Stack key={i} spacing={0.25}>
          <Typography variant="body2" color="text.secondary">
            {c.question}
          </Typography>
          <Typography variant="body2" fontWeight={700}>
            {c.decision}
          </Typography>
          <Typography variant="body2">{c.rationale}</Typography>
          {c.basis.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {c.basis.map((b, j) => (
                <li key={j}>
                  <Typography variant="caption">{b}</Typography>
                </li>
              ))}
            </ul>
          )}
          {/* Who made the call: the rules, or the model (accepted within its bounds). */}
          <Typography variant="caption" color="text.secondary">
            {[...c.standard.map((s) => s.replace('-', ' ')), c.source].join(' · ')}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}
