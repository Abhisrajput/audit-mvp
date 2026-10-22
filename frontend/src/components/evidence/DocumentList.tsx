import { Button, Chip, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { formatSize, statusLabel, type DocumentRecord } from '../../evidence';

interface Props {
  documents: DocumentRecord[];
  selectedId: string | null;
  /** Preparers only: viewers never see Retry. */
  canRetry: boolean;
  retrying: string | null;
  onRetry: (id: string) => void;
  onText: (doc: DocumentRecord) => void;
}

export default function DocumentList({ documents, selectedId, canRetry, retrying, onRetry, onText }: Props) {
  if (!documents.length) return <Typography color="text.secondary">No documents yet.</Typography>;
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>File</TableCell><TableCell>Kind</TableCell><TableCell>Classification</TableCell><TableCell>Size</TableCell>
          <TableCell>Uploaded by</TableCell><TableCell>Date</TableCell><TableCell>Text</TableCell><TableCell />
        </TableRow>
      </TableHead>
      <TableBody>
        {documents.map((d) => {
          const s = statusLabel(d.extraction);
          const expired = d.retentionExpired;
          return (
            <TableRow key={d.id} selected={d.id === selectedId} sx={expired ? { opacity: 0.5 } : undefined}>
              <TableCell sx={{ wordBreak: 'break-all' }}>
                {expired ? d.filename : <a href={`/api/documents/${d.id}/content`} target="_blank" rel="noopener noreferrer">{d.filename}</a>}
              </TableCell>
              <TableCell>{d.kind}</TableCell>
              <TableCell>{d.classification}</TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatSize(d.size)}</TableCell>
              <TableCell>{d.uploadedBy}</TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{d.uploadedAt.slice(0, 10)}</TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                {expired ? <Chip size="small" label="expired" /> : <Chip size="small" color={s.color} label={s.label} title={d.extraction?.error ?? undefined} />}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                {!expired && d.extraction && ['ok', 'client'].includes(d.extraction.status) && <Button size="small" onClick={() => onText(d)}>Text</Button>}
                {!expired && canRetry && s.retry && <Button size="small" disabled={retrying === d.id} onClick={() => onRetry(d.id)}>Retry</Button>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
