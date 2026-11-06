import { useCallback } from 'react';

import { useAuth } from './auth-context';
import { useWorkspace } from './workspace-context';

/**
 * What to do when the workspace refuses this phone's token. The auth layer renews it; a hosted phone also has the gate
 * read the workspace's state, because the refusal can mean the plan ended or the hours ran out, and the person should
 * be told. That read starts nothing.
 */
export function useRevoked(): () => void {
  const { state, revoked } = useAuth();
  const { unavailable } = useWorkspace();
  const hosted = state.status === 'paired' && Boolean(state.hosted);
  return useCallback(() => {
    revoked();
    if (hosted) unavailable();
  }, [revoked, unavailable, hosted]);
}
