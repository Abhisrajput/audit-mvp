import { Alert, Box, Button, Drawer, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { documentText, type DocumentText } from '../../evidence';

interface Props { documentId: string | null; filename: string; onClose: () => void }

export default function TextDrawer({ documentId, filename, onClose }: Props) {
  const [page, setPage] = useState<number | undefined>(undefined);
  const [data, setData] = useState<DocumentText | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setPage(undefined); setData(null); setError(null); }, [documentId]);
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    setError(null);
    documentText(documentId, page).then((d) => live && setData(d), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [documentId, page]);

  const current = data?.page ?? page ?? 1;
  return (
    <Drawer anchor="right" open={!!documentId} onClose={onClose}>
      <Box sx={{ width: { xs: '100vw', sm: 480 }, p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6" noWrap title={filename}>{filename}</Typography>
          <Button onClick={onClose}>Close</Button>
        </Stack>
        {data?.pages != null && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ my: 1 }}>
            <Button size="small" disabled={current <= 1} onClick={() => setPage(current - 1)}>Prev</Button>
            <Typography variant="body2">p. {current} of {data.pages}</Typography>
            <Button size="small" disabled={current >= data.pages} onClick={() => setPage(current + 1)}>Next</Button>
          </Stack>
        )}
        {error && <Alert severity="error" sx={{ my: 1 }}>{error}</Alert>}
        {data && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 14 }}>{data.text}</pre>}
      </Box>
    </Drawer>
  );
}
