import { Search as SearchIcon } from '@mui/icons-material';
import { Alert, Card, InputAdornment, List, ListItem, ListItemText, Stack, TextField, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyChanged } from '../../assistant';
import { isPreparer, listDocuments, retryExtraction, searchEvidence, type DocumentRecord, type SearchRow, type UploadResult } from '../../evidence';
import { useSession } from '../../session';
import DocumentList from './DocumentList';
import TextDrawer from './TextDrawer';
import UploadZone from './UploadZone';

/** The Evidence tab of an engagement; with no engagementId it is the Library's global documents section. */
export default function EvidenceTab({ engagementId }: { engagementId?: string }) {
  const { user } = useSession();
  const preparer = isPreparer(user?.role);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listSeq = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [reading, setReading] = useState<DocumentRecord | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchRow[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const seq = ++listSeq.current;
    return listDocuments(engagementId).then(
      (d) => { if (seq === listSeq.current) { setDocs(d); setError(null); } },
      (e: Error) => { if (seq === listSeq.current) setError(e.message); },
    );
  }, [engagementId]);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!q.trim()) { setHits([]); setSearchError(null); return; }
    let live = true;
    const t = setTimeout(() => {
      searchEvidence(engagementId, q.trim()).then((r) => { if (live) { setHits(r); setSearchError(null); } }, (e: Error) => { if (live) setSearchError(e.message); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, engagementId]);

  const uploaded = (doc: UploadResult) => { setSelected(doc.id); void refresh(); };
  const retry = async (id: string) => {
    setRetrying(id);
    setActionError(null);
    try {
      await retryExtraction(id);
      if (engagementId) notifyChanged(engagementId);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setRetrying(null);
      void refresh();
    }
  };

  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        {engagementId ? 'Evidence and documents filed on this engagement. Text is extracted on upload so it can be searched and cited.' : 'Documents available to every engagement: policies, SOPs and prior reports.'}
      </Typography>
      <Card variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <UploadZone engagementId={engagementId} onUploaded={uploaded} />
          <TextField
            size="small" fullWidth placeholder="Search the text of these documents" value={q} onChange={(e) => setQ(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
          />
          {searchError && <Alert severity="error">{searchError}</Alert>}
          {q.trim() && !searchError && hits.length === 0 && <Typography variant="body2" color="text.secondary">No matches.</Typography>}
          {hits.length > 0 && (
            <List dense disablePadding>
              {hits.map((h, i) => (
                <ListItem key={`${h.documentId}-${i}`} sx={{ py: 0.25 }}>
                  <ListItemText
                    primary={<><a href={`/api/documents/${h.documentId}/content`} target="_blank" rel="noopener noreferrer">{h.filename}</a>{h.page != null && <Typography component="span" variant="caption" color="text.secondary"> p. {h.page}</Typography>}</>}
                    secondary={h.snippet}
                    primaryTypographyProps={{ variant: 'body2' }} secondaryTypographyProps={{ variant: 'caption' }}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </Stack>
      </Card>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && <Alert severity="error" onClose={() => setActionError(null)}>{actionError}</Alert>}
      <Card variant="outlined">
        <DocumentList documents={docs} selectedId={selected} canRetry={preparer} retrying={retrying} onRetry={(id) => void retry(id)} onText={setReading} />
      </Card>
      <TextDrawer documentId={reading?.id ?? null} filename={reading?.filename ?? ''} onClose={() => setReading(null)} />
    </Stack>
  );
}
