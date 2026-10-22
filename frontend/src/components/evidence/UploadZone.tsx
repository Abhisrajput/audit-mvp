import { CloudUpload } from '@mui/icons-material';
import { Alert, Box, Button, LinearProgress, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useRef, useState } from 'react';
import { notifyChanged } from '../../assistant';
import { CLASSIFICATIONS_BY_ROLE, DOCUMENT_KINDS, uploadEvidence, uploadGlobal, type Classification, type DocumentKind, type UploadResult } from '../../evidence';
import { ApiError } from '../../api';
import { useSession } from '../../session';

const PREPARER_ROLES = ['auditor', 'audit_manager'];

interface Props {
  /** Absent for the Library's global documents, which cannot be kind "evidence". */
  engagementId?: string;
  onUploaded: (doc: UploadResult) => void;
}

export default function UploadZone({ engagementId, onUploaded }: Props) {
  const { user } = useSession();
  const kinds: readonly DocumentKind[] = engagementId ? DOCUMENT_KINDS : DOCUMENT_KINDS.filter((k) => k !== 'evidence');
  const [kind, setKind] = useState<DocumentKind>(engagementId ? 'evidence' : 'sop');
  const [classification, setClassification] = useState<Classification>('internal');
  const [note, setNote] = useState('');
  const [retainUntil, setRetainUntil] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Viewers and admins cannot upload: no zone at all.
  if (!user || !PREPARER_ROLES.includes(user.role)) return null;
  const allowed = CLASSIFICATIONS_BY_ROLE[user.role];
  const busy = progress !== null;

  const send = async (file: File) => {
    setError(null);
    setInfo(null);
    setProgress(0);
    try {
      const fields = { kind, classification, retainUntil: retainUntil || undefined, note };
      const doc = engagementId ? await uploadEvidence(engagementId, file, fields, setProgress) : await uploadGlobal(file, fields, setProgress);
      if (doc.duplicate) setInfo('Already uploaded');
      else setNote('');
      onUploaded(doc);
      if (engagementId) notifyChanged(engagementId);
    } catch (e) {
      const err = e as ApiError;
      // DUPLICATE_DIFFERS: the server's message already names the existing document.
      setError(err.message);
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file && !busy) void send(file);
  };

  return (
    <Stack spacing={1.5}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField select size="small" label="Kind" value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)} sx={{ minWidth: 150 }}>
          {kinds.map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
        </TextField>
        <TextField select size="small" label="Classification" value={classification} onChange={(e) => setClassification(e.target.value as Classification)} sx={{ minWidth: 150 }}>
          {allowed.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
        </TextField>
        <TextField size="small" type="date" label="Retain until" InputLabelProps={{ shrink: true }} value={retainUntil} onChange={(e) => setRetainUntil(e.target.value)} />
        <TextField size="small" label="Note" value={note} onChange={(e) => setNote(e.target.value)} inputProps={{ maxLength: 500 }} fullWidth />
      </Stack>
      <Box
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
        sx={{ border: '2px dashed', borderColor: over ? 'primary.main' : 'divider', borderRadius: 1, p: 2, textAlign: 'center', bgcolor: over ? 'action.hover' : undefined }}
      >
        <Typography color="text.secondary" sx={{ mb: 1 }}>Drop a file here, or choose one</Typography>
        <Button variant="outlined" startIcon={<CloudUpload />} disabled={busy} onClick={() => input.current?.click()}>Choose file</Button>
        <input ref={input} type="file" hidden onChange={(e) => pick(e.target.files)} />
        {busy && <LinearProgress variant="determinate" value={Math.round((progress ?? 0) * 100)} sx={{ mt: 1.5 }} />}
      </Box>
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      {info && <Alert severity="info" onClose={() => setInfo(null)}>{info}</Alert>}
    </Stack>
  );
}
