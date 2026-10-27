import { useMemo } from 'react';

import { createApi, type Api } from './api';
import { useAuth } from './auth-context';

/** The API for the paired server, or null while this phone is not paired. */
export function useApi(): Api | null {
  const { state, revoked } = useAuth();
  const server = state.status === 'paired' ? state.server : null;
  const token = state.status === 'paired' ? state.token : null;
  return useMemo(() => (server && token ? createApi({ server, token }, { onRevoked: revoked }) : null), [server, token, revoked]);
}
