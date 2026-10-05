import { useEffect, useState } from "react";
import { createRunClient, EMPTY, INITIAL, type ClientState, type Conn, type Deps, type Snapshot, type TaskRow } from "./runClient.js";

export { EMPTY };
export type { Conn, Snapshot, TaskRow };

const realDeps = (): Deps => ({
  fetch: (url) => fetch(url),
  WebSocket: WebSocket as unknown as Deps["WebSocket"],
  location,
  raf: (cb) => window.requestAnimationFrame(cb),
  caf: (id) => window.cancelAnimationFrame(id),
});

export function useRun(runId: string | null): ClientState {
  const [state, setState] = useState<ClientState>(INITIAL);
  useEffect(() => {
    setState(INITIAL);
    if (!runId) return;
    return createRunClient(runId, realDeps(), setState);
  }, [runId]);
  return state;
}
