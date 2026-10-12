import { Search as SearchIcon } from '@mui/icons-material';
import { Alert, Card, Chip, InputAdornment, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { RiskChip } from '../components/common';
import type { Clause, ConceptTrust, ContentPack } from '../types';

function TrustCell({ trust }: { trust?: ConceptTrust }) {
  if (!trust) return <TableCell>—</TableCell>;
  const today = new Date().toISOString().slice(0, 10);
  const stale = !!trust.staleAfter && trust.staleAfter <= today;
  return (
    <TableCell sx={{ whiteSpace: 'nowrap' }}>
      {trust.verifiedBy
        ? <Chip size="small" color="success" label={`Verified by ${trust.verifiedBy}`} title={`${trust.verifiedRole ?? ''}, ${trust.verifiedAt}`} />
        : <Chip size="small" color="warning" label="Unverified" />}
      <Typography variant="caption" display="block" color={stale ? 'error' : 'text.secondary'}>
        {trust.staleAfter ? `${stale ? 'Re-review overdue since' : 'Re-review by'} ${trust.staleAfter}` : 'No re-review date'}
      </Typography>
      <Typography variant="caption" display="block" sx={{ fontFamily: 'monospace' }} color="text.secondary">{trust.sourcePath}</Typography>
    </TableCell>
  );
}

export default function LibraryPage() {
  const [packs, setPacks] = useState<ContentPack[]>([]);
  const [packId, setPackId] = useState('food');
  const [view, setView] = useState(0);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ clauseId: string; score: number; clause: Clause }[]>([]);

  useEffect(() => {
    api<{ id: string }[]>('/packs').then((list) => Promise.all(list.map((p) => api<ContentPack>(`/packs/${p.id}`))).then(setPacks));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => (q.trim() ? api<typeof hits>(`/search?q=${encodeURIComponent(q)}`).then(setHits) : setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);

  const pack = packs.find((p) => p.id === packId);
  return (
    <Stack spacing={2}>
      <Typography variant="h5" fontWeight={600}>
        Content library
      </Typography>
      <Typography color="text.secondary">
        Content packs hold the regulatory corpus (clause-level), the control library and the evaluation set. Adding a sector or regulation means adding a pack, not changing the engine.
      </Typography>

      <Card variant="outlined" sx={{ p: 2 }}>
        <TextField
          fullWidth
          placeholder='Test the grounding index, e.g. "audit trail not reviewed" or "mock recall"'
          value={q}
          onChange={(e) => setQ(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
        />
        {hits.length > 0 && (
          <Table size="small" sx={{ mt: 1 }}>
            <TableBody>
              {hits.map((h) => (
                <TableRow key={h.clauseId}>
                  <TableCell sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{h.score.toFixed(2)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <b>{h.clause.ref}</b> <Typography variant="caption" display="block">{h.clause.regulation}</Typography>
                  </TableCell>
                  <TableCell>
                    <b>{h.clause.title}.</b> {h.clause.summary}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Tabs value={packId} onChange={(_, v) => setPackId(v)}>
        {packs.map((p) => (
          <Tab key={p.id} value={p.id} label={`${p.name} v${p.version}`} />
        ))}
      </Tabs>
      {pack && (
        <>
          <Alert severity="warning">{pack.disclaimer}</Alert>
          <Alert severity="info">
            Only knowledge a reviewer has verified, and that is not past its re-review date, may be cited in released findings. Unverified sources are blocked in production.
          </Alert>
          <Tabs value={view} onChange={(_, v) => setView(v)}>
            <Tab label={`Controls (${pack.controls.length})`} />
            <Tab label={`Clauses (${pack.clauses.length})`} />
            <Tab label={`Evaluation cases (${pack.evalCases.length})`} />
          </Tabs>
          <Card variant="outlined">
            {view === 0 && (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>ID</TableCell>
                    <TableCell>Control</TableCell>
                    <TableCell>Process area</TableCell>
                    <TableCell>Risk</TableCell>
                    <TableCell>Frequency</TableCell>
                    <TableCell>Cites</TableCell>
                    <TableCell>Verification</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pack.controls.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{c.id}</TableCell>
                      <TableCell>
                        <b>{c.title}</b>
                        <Typography variant="body2" color="text.secondary">{c.risk}</Typography>
                      </TableCell>
                      <TableCell>{c.processArea}</TableCell>
                      <TableCell><RiskChip rating={c.riskRating} /></TableCell>
                      <TableCell>{c.frequency}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{c.clauseRefs.join(', ')}</TableCell>
                      <TrustCell trust={c.trust} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {view === 1 && (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Clause</TableCell>
                    <TableCell>Regulation / standard</TableCell>
                    <TableCell>Summary (paraphrased)</TableCell>
                    <TableCell>Verification</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pack.clauses.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}><b>{c.ref}</b><Typography variant="caption" display="block" sx={{ fontFamily: 'monospace' }}>{c.id}</Typography></TableCell>
                      <TableCell>{c.regulation}</TableCell>
                      <TableCell><b>{c.title}.</b> {c.summary}</TableCell>
                      <TrustCell trust={c.trust} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {view === 2 && (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Case</TableCell>
                    <TableCell>Kind</TableCell>
                    <TableCell>Description</TableCell>
                    <TableCell>Expected</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pack.evalCases.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{c.id}</TableCell>
                      <TableCell>{c.kind}</TableCell>
                      <TableCell>{c.description}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{JSON.stringify(c.expected)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </Stack>
  );
}
