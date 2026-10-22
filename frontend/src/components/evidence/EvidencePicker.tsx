import { Add as AddIcon } from '@mui/icons-material';
import { Alert, Autocomplete, Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { useMemo, useState } from 'react';
import { addLink, linkLabel, statusLabel } from '../../evidence';
import type { DocumentRecord, EvidenceLink } from '../../evidence';
import { useEngagementDocuments } from './useEngagementDocuments';

/** Pick documents (and optionally a page) to cite. Existing links to hidden or expired documents still show as chips. */
type PickerProps = { engagementId: string; value: EvidenceLink[]; onChange: (links: EvidenceLink[]) => void; disabled?: boolean; documents?: DocumentRecord[]; loadError?: string | null };

/** Loads its own documents unless the caller passes them (a tab with many pickers loads once). */
function OwnDocuments(props: PickerProps) {
  const { documents, error, loading } = useEngagementDocuments(props.engagementId);
  return <PickerView {...props} documents={documents} loadError={error} loading={loading} />;
}

export default function EvidencePicker(props: PickerProps) {
  return props.documents ? <PickerView {...props} documents={props.documents} loading={false} /> : <OwnDocuments {...props} />;
}

function PickerView({ value, onChange, disabled, documents, loadError, loading }: PickerProps & { documents: DocumentRecord[]; loading: boolean }) {
  const error = loadError ?? null;
  const [chosen, setChosen] = useState<DocumentRecord | null>(null);
  const [page, setPage] = useState('');
  const [input, setInput] = useState('');

  const options = useMemo(() => documents.filter((d) => !d.retentionExpired), [documents]);
  const pages = chosen?.extraction?.pages ?? null;
  const pageNum = page === '' ? undefined : Number(page);
  const pageOk = pageNum === undefined || (Number.isInteger(pageNum) && pageNum >= 1 && (pages === null || pageNum <= pages));

  const pending: EvidenceLink | null = chosen ? (pageNum ? { documentId: chosen.id, page: pageNum } : { documentId: chosen.id }) : null;
  const already = !!pending && pageOk && addLink(value, pending) === value;

  const add = () => {
    if (!pending || !pageOk || already) return;
    onChange(addLink(value, pending));
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
        <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={add} disabled={disabled || !chosen || !pageOk || already} sx={{ mt: 0.5 }}>
          Add
        </Button>
        {already && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5 }}>
            Already cited
          </Typography>
        )}
      </Stack>
      {value.length > 0 && (
        <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
          {value.map((l) => (
            <Chip key={`${l.documentId}:${l.page ?? ''}`} size="small" label={linkLabel(l, documents)} aria-label={`Remove ${linkLabel(l, documents)}`} onDelete={disabled ? undefined : () => onChange(value.filter((x) => x !== l))} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
