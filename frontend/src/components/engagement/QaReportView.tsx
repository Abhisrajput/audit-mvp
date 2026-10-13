import { Alert, Box, Chip, Collapse, Link, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useState } from 'react';
import { belowThreshold } from '../../agents';
import type { QaReport } from '../../types';

/** A QA review as its signer sees it (REQ-30): the score, every issue (blocking first), and the rubric when a model scored one. */
export default function QaReportView({ report, threshold }: { report: QaReport; threshold: number | null }) {
  const [rubric, setRubric] = useState(false);
  const blocking = report.issues.filter((i) => i.severity === 'blocking');
  const advisory = report.issues.filter((i) => i.severity === 'advisory');
  const low = threshold !== null && belowThreshold(report, threshold);
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography variant="subtitle2">QA {report.mode === 'challenge' ? 'challenge' : 'review'}</Typography>
        <Chip size="small" color={blocking.length ? 'error' : low ? 'warning' : 'success'} label={`${report.score}/100`} />
        <Typography variant="caption" color="text.secondary">
          by {report.reviewer}
          {threshold !== null ? ` · threshold ${threshold}` : ''}
        </Typography>
        {report.withoutModel && <Chip size="small" variant="outlined" color="warning" label="automatic checks only: the model was unavailable" />}
      </Stack>
      {low && !blocking.length && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          QA scored this below the threshold of {threshold}. The gate opened because no issue is blocking. Read the issues before you sign.
        </Alert>
      )}
      {report.issues.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          No issues found.
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {[...blocking, ...advisory].map((i, n) => (
            <li key={n}>
              <Typography variant="body2">
                <Chip size="small" variant="outlined" color={i.severity === 'blocking' ? 'error' : 'default'} label={i.severity} sx={{ mr: 1 }} />
                <b>{i.criterion}</b>: {i.detail}
              </Typography>
            </li>
          ))}
        </Box>
      )}
      {!!report.criteria?.length && (
        <>
          <Link component="button" variant="body2" onClick={() => setRubric(!rubric)} sx={{ mt: 0.5 }}>
            {rubric ? 'Hide' : 'Show'} the rubric ({report.criteria.length} criteria)
          </Link>
          <Collapse in={rubric} unmountOnExit>
            <Table size="small" sx={{ mt: 0.5 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Criterion</TableCell>
                  <TableCell width={80}>Score</TableCell>
                  <TableCell>Note</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {report.criteria.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{c.id}</TableCell>
                    <TableCell>{c.score} / 4</TableCell>
                    <TableCell>{c.note}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Collapse>
        </>
      )}
    </Box>
  );
}
