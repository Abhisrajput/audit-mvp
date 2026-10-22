import { Alert, Box, Button, Drawer, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { documentText, type DocumentText } from '../../evidence';

interface Props { documentId: string | null; filename: string; onClose: () => void; /** Page to open first, e.g. the page a quote was cited from. */ initialPage?: number }

export default function TextDrawer({ documentId, filename, onClose, initialPage }: Props) {
  const [page, setPage] = useState<number | undefined>(initialPage);
  const [data, setData] = useState<DocumentText | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setPage(initialPage); setData(null); setPages(null); setError(null); }, [documentId, initialPage]);
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    setError(null);
    setData(null);
    documentText(documentId, page ?? initialPage).then((d) => live && (setData(d), setPages(d.pages)), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [documentId, page, initialPage]);

  const loading = !!documentId && !data && !error;
  const current = page ?? data?.page ?? 1;
  return (
    <Drawer anchor="right" open={!!documentId} onClose={onClose}>
      <Box sx={{ width: { xs: '100vw', sm: 480 }, p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6" noWrap title={filename}>{filename}</Typography>
          <Button onClick={onClose}>Close</Button>
        </Stack>
        {pages != null && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ my: 1 }}>
            <Button size="small" disabled={loading || current <= 1} onClick={() => setPage(current - 1)}>Prev</Button>
            <Typography variant="body2">p. {current} of {pages}</Typography>
            <Button size="small" disabled={loading || current >= pages} onClick={() => setPage(current + 1)}>Next</Button>
          </Stack>
        )}
        {error && <Alert severity="error" sx={{ my: 1 }}>{error}</Alert>}
        {data && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 14 }}>{data.text}</pre>}
      </Box>
    </Drawer>
  );
}
