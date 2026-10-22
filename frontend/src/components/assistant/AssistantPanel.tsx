import { Close as CloseIcon, Send as SendIcon } from '@mui/icons-material';
import { Alert, Box, Drawer, IconButton, Stack, TextField, Typography, useMediaQuery, useTheme } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api';
import {
  assistantApi, engagementIdOf, notifyChanged, OFFLINE_HINT, shownFrom, trimHistory,
  type AssistantSettings, type Turn,
} from '../../assistant';
import type { CommandName } from '../../types';
import ProposalCard from './ProposalCard';
import ResultCard from './ResultCard';

export const ASSISTANT_WIDTH = 380;

export default function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('md'));
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const engagementId = /^\/engagements\/([^/]+)/.exec(pathname)?.[1];

  const [turns, setTurns] = useState<Turn[]>([]);
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    assistantApi.settings().then(setSettings).catch((e) => setSettingsError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns]);

  const patch = (id: number, p: Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));

  const submit = async () => {
    const message = composer.trim();
    if (!message || busy) return;
    const last = [...turns].reverse().find((t) => t.response?.command && t.response.result !== undefined);
    const shown = last?.response?.command ? shownFrom(last.response.command.name, last.response.result) : [];
    const history = trimHistory(turns);
    const id = nextId.current++;
    setTurns((ts) => [...ts, { id, message, response: null, error: null, done: null, cancelled: false }]);
    setComposer('');
    setBusy(true);
    try {
      const response = await assistantApi.turn({ message, context: { engagementId, ...(shown.length ? { shown } : {}) }, history });
      patch(id, { response });
    } catch (e) {
      patch(id, { error: e instanceof ApiError || e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onDone = (id: number) => (summary: string, name: CommandName, args: unknown, result: unknown) => {
    patch(id, { done: { summary } });
    if (name === 'create_engagement') navigate(`/engagements/${(result as { id: string }).id}`);
    const changed = engagementIdOf(name, args);
    if (changed) notifyChanged(changed);
  };

  return (
    <Drawer
      anchor="right"
      variant={wide ? 'persistent' : 'temporary'}
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: wide ? ASSISTANT_WIDTH : '100%', maxWidth: '100%', boxSizing: 'border-box', ...(wide ? { top: 64, height: 'calc(100% - 64px)' } : {}) } }}
    >
      <Stack direction="row" alignItems="center" sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>Assistant</Typography>
        <IconButton size="small" aria-label="Close assistant" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </Stack>

      <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
        {settingsError && <Alert severity="error" sx={{ mb: 1 }}>{settingsError}</Alert>}
        {turns.length === 0 && (
          <Typography variant="body2" color="text.secondary">Ask about engagements, findings, documents or standards, or ask me to make a change.</Typography>
        )}
        {turns.map((t) => (
          <Box key={t.id} sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'pre-wrap' }}>{t.message}</Typography>
            {!t.response && !t.error && <Typography variant="caption" color="text.secondary">Thinking…</Typography>}
            {t.error && <Alert severity="error" sx={{ mt: 0.5 }}>{t.error}</Alert>}
            {t.response && (
              <>
                <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>{t.response.say}</Typography>
                {t.response.command && <ResultCard name={t.response.command.name} result={t.response.result} />}
                {t.response.proposal && (
                  <ProposalCard
                    proposal={t.response.proposal}
                    onDone={onDone(t.id)}
                    onCancel={() => patch(t.id, { cancelled: true })}
                  />
                )}
              </>
            )}
          </Box>
        ))}
        <div ref={endRef} />
      </Box>

      <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
        {settings && !settings.enabled ? (
          <Typography variant="body2" color="text.secondary">The assistant is switched off.</Typography>
        ) : (
          <>
            <TextField
              fullWidth multiline maxRows={5} size="small" placeholder="Ask the assistant" value={composer} disabled={busy}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              InputProps={{ endAdornment: <IconButton size="small" aria-label="Send" disabled={busy || !composer.trim()} onClick={() => void submit()}><SendIcon fontSize="small" /></IconButton> }}
            />
            {settings?.planner === 'rules' && <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>{OFFLINE_HINT}</Typography>}
          </>
        )}
      </Box>
    </Drawer>
  );
}
