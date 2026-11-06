import { createContext, useContext } from 'react';

/**
 * How the screens tell the hosted workspace's gate that a call found it unavailable (a 503: it went to sleep while
 * the app was open). A self-hosted phone has no gate, so the default does nothing. This only reports; it never
 * wakes anything.
 */
export type WorkspaceSignals = { unavailable: () => void };

const NONE: WorkspaceSignals = { unavailable: () => {} };

export const WorkspaceContext = createContext<WorkspaceSignals>(NONE);

export function useWorkspace(): WorkspaceSignals {
  return useContext(WorkspaceContext);
}
