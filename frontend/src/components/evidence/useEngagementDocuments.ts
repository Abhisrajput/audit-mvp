import { useEffect, useState } from 'react';
import { listAllDocuments } from '../../evidence';
import type { DocumentRecord } from '../../evidence';

/** The engagement's and the library's documents, loaded once per engagement. */
export function useEngagementDocuments(engagementId: string): { documents: DocumentRecord[]; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ documents: DocumentRecord[]; error: string | null; loading: boolean }>({ documents: [], error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, error: null, loading: true }));
    listAllDocuments(engagementId).then(
      (documents) => live && setState({ documents, error: null, loading: false }),
      (e) => live && setState({ documents: [], error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [engagementId]);
  return state;
}
