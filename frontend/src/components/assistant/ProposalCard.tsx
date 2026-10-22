import { Alert, Button, Card, Stack, Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import { useState } from 'react';
import { ApiError } from '../../api';
import { argRows, assistantApi } from '../../assistant';
import type { CommandName, TurnResponse } from '../../types';
import { ActionButton } from '../common';

type Proposal = NonNullable<TurnResponse['proposal']>;
type Status = { kind: 'open' } | { kind: 'done'; summary: string } | { kind: 'cancelled' };

export default function ProposalCard({ proposal, onDone, onCancel }: {
  proposal: Proposal;
  onDone: (summary: string, name: CommandName, args: unknown, result: unknown) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'open' });
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  if (status.kind === 'done') return <Typography variant="body2" sx={{ mt: 1 }}>Done: {status.summary}</Typography>;
  if (status.kind === 'cancelled') return <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Cancelled</Typography>;

  const confirm = async () => {
    setError(null);
    try {
      const res = await assistantApi.confirm(proposal);
      setStatus({ kind: 'done', summary: res.summary });
      onDone(res.summary, proposal.name, proposal.args, res.result);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setConflict(true);
        setError('The engagement changed since this was proposed. Ask again.');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  return (
    <Card variant="outlined" sx={{ mt: 1, p: 1.5 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>{proposal.summary}</Typography>
      <Table size="small" sx={{ my: 1 }}>
        <TableBody>
          {argRows(proposal.args).map((r) => (
            <TableRow key={r.label}>
              <TableCell sx={{ py: 0.25, px: 0.5, border: 0, color: 'text.secondary', whiteSpace: 'nowrap' }}>{r.label}</TableCell>
              <TableCell sx={{ py: 0.25, px: 0.5, border: 0 }}>{r.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {error && <Alert severity={conflict ? 'warning' : 'error'} sx={{ mb: 1 }}>{error}</Alert>}
      <Stack direction="row" spacing={1}>
        <ActionButton size="small" action={confirm} disabled={conflict}>Confirm</ActionButton>
        <Button size="small" onClick={() => { setStatus({ kind: 'cancelled' }); onCancel(); }}>Cancel</Button>
      </Stack>
    </Card>
  );
}
