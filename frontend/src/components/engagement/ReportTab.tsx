import { Download as DownloadIcon, ExpandMore as ExpandMoreIcon, PlayArrow as PlayArrowIcon } from '@mui/icons-material';
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Card, Chip, Stack, Typography } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TabProps } from '../../pages/EngagementPage';
import { memoFor, OPINION_LABELS, opinionColor, responsesRecorded } from '../../judgment';
import { ActionButton } from '../common';
import MemoView from './MemoView';

export default function ReportTab({ engagement: e, run }: TabProps) {
  const opinion = e.report?.opinion;
  const memo = memoFor(e, 'report');
  const { recorded, approved } = responsesRecorded(e);
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap">
        <ActionButton startIcon={<PlayArrowIcon />} action={() => run('report')}>
          {e.report ? 'Regenerate' : 'Generate'} report
        </ActionButton>
        {e.report && (
          <Button variant="outlined" startIcon={<DownloadIcon />} href={`/api/engagements/${e.id}/report.md`}>
            Report (.md)
          </Button>
        )}
        <Button variant="outlined" startIcon={<DownloadIcon />} href={`/api/engagements/${e.id}/findings.csv`}>
          Findings for QMS/GRC (.csv)
        </Button>
        <Typography color="text.secondary">Only approved findings are included.</Typography>
      </Stack>
      {e.report && (
        <Typography color="text.secondary">
          {recorded} of {approved} approved finding(s) have a management response; the CAE signs the report gate once the auditor has recorded them all.
        </Typography>
      )}
      {opinion && (
        <Card variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6">Overall opinion</Typography>
              <Chip size="small" color={opinionColor(opinion.rating)} label={OPINION_LABELS[opinion.rating]} />
            </Stack>
            {/* The basis is markdown: the fixed paragraph, then the AI narrative with its italic marker, or the CAE sentence. */}
            <Box sx={{ '& p': { my: 0.5 } }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{opinion.basis}</ReactMarkdown>
            </Box>
            {opinion.setBy && (
              <Typography variant="caption" color="text.secondary">
                Set by the Chief Audit Executive on rejecting the report gate (signature {opinion.setBy})
              </Typography>
            )}
            <Accordion disableGutters variant="outlined">
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>Why this opinion (judgment memo)</AccordionSummary>
              <AccordionDetails>
                {memo ? <MemoView memo={memo} /> : <Typography color="text.secondary">No judgment memo recorded.</Typography>}
              </AccordionDetails>
            </Accordion>
          </Stack>
        </Card>
      )}
      {e.report && (
        <Card variant="outlined" sx={{ p: { xs: 2, md: 4 } }}>
          <Box sx={{ '& table': { borderCollapse: 'collapse', my: 1 }, '& td, & th': { border: '1px solid #ddd', px: 1, py: 0.5, fontSize: 14 }, '& h1': { fontSize: 26 }, '& h2': { fontSize: 20, mt: 3 }, '& h3': { fontSize: 17 } }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{e.report.markdown}</ReactMarkdown>
          </Box>
        </Card>
      )}
    </Stack>
  );
}
