import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, changedEngagement, currentRun, loadStepsSince, pollDelayMs, type AgentSettings } from '../../agents';
import type { AgentRun, AgentStep, Gate } from '../../types';

export interface AgentRunState {
  settings: AgentSettings | null;
  runs: AgentRun[];
  /** The run the panel shows: the live one, else the latest. */
  run: AgentRun | null;
  steps: AgentStep[];
  gates: Gate[];
  /** The last error loading agent state. The panel shows it and keeps polling. */
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Keeps the engagement's agent run, its steps and its gates current by polling (there is no push channel): often while
 * the agent works, slowly while it waits for people or has ended (a colleague may start a run). A hidden tab skips its
 * turns and looks again as soon as it is shown. Only steps after the last one seen
 * are fetched. When the agent drafted something, `onEngagementChanged` reloads the engagement, so a person's next save
 * is not refused as stale. Refreshes run one at a time, so a poll and a button press never add the same steps twice.
 */
export function useAgentRun(engagementId: string, onEngagementChanged: () => void): AgentRunState {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<{ runId: string | null; lastSeq: number }>({ runId: null, lastSeq: 0 });
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Counts refreshes queued or running, so a poll can skip its turn while one is still going.
  const pending = useRef(0);
  // Changes with the engagement and on unmount, so a late answer for a page that is gone is dropped.
  const epoch = useRef(0);
  // The latest callback, so a new function from the page does not restart the polling.
  const changed = useRef(onEngagementChanged);
  changed.current = onEngagementChanged;

  // `mine` is the epoch when the refresh was asked for, so a refresh queued before an unmount or an engagement switch
  // writes nothing and reloads nothing when its turn comes.
  const load = useCallback(async (mine: number) => {
    try {
      const [rs, gs] = await Promise.all([agentApi.runs(engagementId), agentApi.gates(engagementId)]);
      if (mine !== epoch.current) return;
      setRuns(rs);
      setGates(gs);
      const run = currentRun(rs);
      if (!run) {
        seen.current = { runId: null, lastSeq: 0 };
        setSteps([]);
      } else {
        const fresh = seen.current.runId !== run.id;
        const fetched = await loadStepsSince((after) => agentApi.steps(run.id, after).then((p) => p.steps), fresh ? 0 : seen.current.lastSeq);
        const lastSeq = fetched.length ? fetched[fetched.length - 1].seq : fresh ? 0 : seen.current.lastSeq;
        if (mine !== epoch.current) return;
        seen.current = { runId: run.id, lastSeq };
        if (fresh) setSteps(fetched);
        else if (fetched.length) setSteps((prev) => [...prev, ...fetched]);
        if (!fresh && changedEngagement(fetched)) {
          // A failed reload is shown with the other agent errors; it never becomes an unhandled rejection.
          Promise.resolve(changed.current()).catch((e) => mine === epoch.current && setError(`Could not reload the engagement: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      setError(null);
    } catch (e) {
      if (mine !== epoch.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [engagementId]);

  const refresh = useCallback(() => {
    pending.current += 1;
    const mine = epoch.current;
    return (queue.current = queue.current.then(() => (mine === epoch.current ? load(mine) : undefined)).finally(() => {
      pending.current -= 1;
    }));
  }, [load]);

  useEffect(() => {
    agentApi.settings().then(setSettings, () => setSettings(null));
  }, []);

  useEffect(() => {
    // A new engagement starts empty, so the panel never shows (or acts on) the previous engagement's run.
    seen.current = { runId: null, lastSeq: 0 };
    setRuns([]);
    setSteps([]);
    setGates([]);
    setError(null);
    void refresh();
    return () => {
      epoch.current += 1;
    };
  }, [refresh]);

  const run = currentRun(runs);
  const delay = pollDelayMs(run);
  useEffect(() => {
    // A hidden tab skips its turn, and looks again the moment it is shown rather than waiting out the interval.
    const tick = () => {
      if (document.visibilityState === 'visible' && pending.current === 0) void refresh();
    };
    const timer = setInterval(tick, delay);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [delay, refresh]);

  return { settings, runs, run, steps, gates, error, refresh };
}
