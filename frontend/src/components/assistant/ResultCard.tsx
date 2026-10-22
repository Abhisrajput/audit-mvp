import { Box, Card, Link, List, ListItem, ListItemText, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { plainSnippet } from '../../assistant';
import type { ClauseResult, CommandName, DocumentResult, EngagementCard, FindingRow, PackRow } from '../../types';
import { RiskChip, StatusChip } from '../common';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const rows = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v.filter(isRec) as unknown as T[]) : []);

const Cell = ({ children }: { children: ReactNode }) => <TableCell sx={{ py: 0.5, px: 1 }}>{children}</TableCell>;
const EngLink = ({ id, children }: { id: string; children: ReactNode }) => (
  <Link component={RouterLink} to={`/engagements/${id}`}>{children}</Link>
);

function Grid({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>{head.map((h) => <Cell key={h}><Typography variant="caption" color="text.secondary">{h}</Typography></Cell>)}</TableRow>
      </TableHead>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function body(name: CommandName, result: unknown): ReactNode {
  switch (name) {
    case 'list_engagements': {
      const list = rows<{ id: string; name: string; entity: string; stage: string; findings: unknown }>(result);
      if (!list.length) return null;
      return (
        <Grid head={['Engagement', 'Entity', 'Stage', 'Findings']}>
          {list.map((e) => (
            <TableRow key={e.id}>
              <Cell><EngLink id={e.id}>{e.name}</EngLink></Cell>
              <Cell>{e.entity}</Cell>
              <Cell>{e.stage}</Cell>
              <Cell>{String(e.findings ?? '')}</Cell>
            </TableRow>
          ))}
        </Grid>
      );
    }
    case 'show_engagement': {
      if (!isRec(result)) return null;
      const e = result as unknown as EngagementCard;
      const counts = e.counts;
      return (
        <Box sx={{ p: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}><EngLink id={e.id}>{e.name}</EngLink></Typography>
          <Typography variant="body2">{e.entity}, {e.site}</Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            Stage {e.stage} · {e.periodFrom} to {e.periodTo}
            {counts ? ` · ${counts.scopeIncluded} in scope · ${counts.rcmRows} RCM rows` : ''}
            {e.opinion ? ` · Opinion: ${e.opinion}` : ''}
            {e.openGate ? ` · Open gate: ${e.openGate}` : ''}
            {e.run ? ` · Run: ${e.run.status}` : ''}
          </Typography>
        </Box>
      );
    }
    case 'list_findings': {
      const list = rows<FindingRow>(result);
      if (!list.length) return null;
      return (
        <Grid head={['Finding', 'Rating', 'Status']}>
          {list.map((f) => (
            <TableRow key={f.id}>
              <Cell>{f.title}</Cell>
              <Cell><RiskChip rating={f.rating} /></Cell>
              <Cell><StatusChip status={f.status} /></Cell>
            </TableRow>
          ))}
        </Grid>
      );
    }
    case 'list_packs': {
      const list = rows<PackRow>(result);
      if (!list.length) return null;
      return (
        <Grid head={['Pack', 'Version', 'Vertical']}>
          {list.map((p) => (
            <TableRow key={p.id}><Cell>{p.name}</Cell><Cell>{p.version}</Cell><Cell>{p.vertical}</Cell></TableRow>
          ))}
        </Grid>
      );
    }
    case 'find_documents': {
      const list = rows<DocumentResult>(result);
      if (!list.length) return null;
      return (
        <List dense disablePadding>
          {list.map((d, i) => (
            <ListItem key={d.kind === 'document' ? d.id : `${d.conceptId}-${i}`} sx={{ py: 0.25 }}>
              <ListItemText
                primary={d.kind === 'document'
                  ? <Link href={d.href} target="_blank" rel="noopener">{d.filename}</Link>
                  : <>{d.title} <Typography component="span" variant="caption" color="text.secondary">{d.conceptId}</Typography></>}
                secondary={plainSnippet(d.snippet) || undefined}
                primaryTypographyProps={{ variant: 'body2' }}
                secondaryTypographyProps={{ variant: 'caption' }}
              />
            </ListItem>
          ))}
        </List>
      );
    }
    case 'search_standards': {
      const list = rows<ClauseResult>(result);
      if (!list.length) return null;
      return (
        <List dense disablePadding>
          {list.map((c) => (
            <ListItem key={c.id} sx={{ py: 0.25 }}>
              <ListItemText primary={`${c.ref} — ${c.title}`} secondary={c.summary} primaryTypographyProps={{ variant: 'body2' }} secondaryTypographyProps={{ variant: 'caption' }} />
            </ListItem>
          ))}
        </List>
      );
    }
    default:
      return null;
  }
}

export default function ResultCard({ name, result }: { name: CommandName; result: unknown }) {
  const content = body(name, result);
  if (!content) return null;
  return <Card variant="outlined" sx={{ mt: 1, overflowX: 'auto' }}>{content}</Card>;
}
