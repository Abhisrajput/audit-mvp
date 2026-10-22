import { Add as AddIcon } from '@mui/icons-material';
import { Alert, Autocomplete, Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { linkLabel, listAllDocuments, statusLabel, toggleLink } from '../../evidence';
import type { DocumentRecord, EvidenceLink } from '../../evidence';

/** Pick documents (and optionally a page) to cite. Existing links to hidden or expired documents still show as chips. */
export default function EvidencePicker({ engagementId, value, onChange, disabled }: { engagementId: string; value: EvidenceLink[]; onChange: (links: EvidenceLink[]) => void; disabled?: boolean }) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<DocumentRecord | null>(null);
  const [page, setPage] = useState('');
  const [input, setInput] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    listAllDocuments(engagementId).then(
      (d) => live && (setDocuments(d), setError(null), setLoading(false)),
      (e) => live && (setError(e instanceof Error ? e.message : String(e)), setLoading(false)),
    );
    return () => {
      live = false;
    };
  }, [engagementId]);

  const options = useMemo(() => documents.filter((d) => !d.retentionExpired), [documents]);
  const pages = chosen?.extraction?.pages ?? null;
  const pageNum = page === '' ? undefined : Number(page);
  const pageOk = pageNum === undefined || (Number.isInteger(pageNum) && pageNum >= 1 && (pages === null || pageNum <= pages));

  const add = () => {
    if (!chosen || !pageOk) return;
    onChange(toggleLink(value, pageNum ? { documentId: chosen.id, page: pageNum } : { documentId: chosen.id }));
    setChosen(null);
    setInput('');
    setPage('');
  };

  return (
    <Stack spacing={1}>
      {error && <Alert severity="warning">Could not load documents: {error}</Alert>}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <Autocomplete
          fullWidth
          size="small"
          options={options}
          value={chosen}
          inputValue={input}
          onInputChange={(_, v) => setInput(v)}
          onChange={(_, v) => {
            setChosen(v);
            setPage('');
          }}
          loading={loading}
          disabled={disabled || loading}
          getOptionLabel={(d) => d.filename}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          renderOption={(props, d) => (
            <li {...props} key={d.id}>
              <Box>
                <Typography variant="body2">{d.filename}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {d.kind} · {d.classification} · {statusLabel(d.extraction).label}
                </Typography>
              </Box>
            </li>
          )}
          renderInput={(params) => <TextField {...params} label="Cite a document" />}
        />
        <TextField
          size="small"
          type="number"
          label="Page"
          sx={{ width: 100 }}
          value={page}
          onChange={(e) => setPage(e.target.value)}
          disabled={disabled || !chosen}
          error={!pageOk}
          inputProps={{ min: 1, ...(pages ? { max: pages } : {}) }}
        />
        <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={add} disabled={disabled || !chosen || !pageOk} sx={{ mt: 0.5 }}>
          Add
        </Button>
      </Stack>
      {value.length > 0 && (
        <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
          {value.map((l) => (
            <Chip key={`${l.documentId}:${l.page ?? ''}`} size="small" label={linkLabel(l, documents)} onDelete={disabled ? undefined : () => onChange(value.filter((x) => x !== l))} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
