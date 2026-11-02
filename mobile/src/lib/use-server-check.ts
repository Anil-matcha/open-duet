import { useEffect, useState } from 'react';

import { checkServer, type ServerCheck } from './pairing-api';

const PAUSE_MS = 600;

/**
 * Checks an address once the person has stopped typing it. `idle`: no address to check yet; `checking`: the answer
 * for this address has not arrived. An answer for an address that has since been changed is never shown.
 */
export function useServerCheck(server: string | null): 'idle' | 'checking' | ServerCheck {
  const [answer, setAnswer] = useState<{ server: string; result: ServerCheck } | null>(null);

  useEffect(() => {
    if (!server) return;
    let current = true;
    const timer = setTimeout(() => {
      void checkServer(server).then((result) => {
        if (current) setAnswer({ server, result });
      });
    }, PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [server]);

  if (!server) return 'idle';
  return answer && answer.server === server ? answer.result : 'checking';
}
