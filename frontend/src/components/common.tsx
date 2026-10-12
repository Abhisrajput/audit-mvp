import { Alert, Button, Chip, CircularProgress, Snackbar, Stack, Tooltip, type ButtonProps } from '@mui/material';
import { useState, type ReactNode } from 'react';
import type { Citation, FindingStatus, RiskRating, TestConclusion } from '../types';

export function RiskChip({ rating }: { rating: RiskRating }) {
  const color = rating === 'High' ? 'error' : rating === 'Medium' ? 'warning' : 'success';
  return <Chip size="small" color={color} label={rating} />;
}

export function ConclusionChip({ conclusion }: { conclusion?: TestConclusion }) {
  if (!conclusion) return <Chip size="small" label="Not concluded" variant="outlined" />;
  const color = conclusion === 'Effective' ? 'success' : conclusion === 'Not tested' ? 'default' : 'error';
  return <Chip size="small" color={color} label={conclusion} />;
}

export function StatusChip({ status }: { status: FindingStatus }) {
  const color = { draft: 'default', blocked: 'error', reviewed: 'info', approved: 'success', rejected: 'warning' }[status] as 'default';
  return <Chip size="small" color={color} label={status.toUpperCase()} />;
}

export function Citations({ citations }: { citations: Citation[] }) {
  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
      {citations.map((c) => (
        <Tooltip key={c.clauseId} title={c.regulation}>
          <Chip size="small" variant="outlined" color="primary" label={c.label} sx={{ fontFamily: 'monospace' }} />
        </Tooltip>
      ))}
    </Stack>
  );
}

/** Button that runs an async action, shows progress and surfaces API errors. */
export function ActionButton({ action, children, ...props }: { action: () => Promise<unknown>; children: ReactNode } & Omit<ButtonProps, 'onClick'>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="contained"
        {...props}
        disabled={busy || props.disabled}
        startIcon={busy ? <CircularProgress size={16} /> : props.startIcon}
        onClick={async () => {
          setBusy(true);
          try {
            await action();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </Button>
      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => setError(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}
