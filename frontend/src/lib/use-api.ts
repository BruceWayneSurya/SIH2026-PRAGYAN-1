import { useEffect, useState } from "react";

/**
 * Minimal async-data hook used by the client pages. It fetches from the Pragyan
 * backend API once (and on dependency changes) and surfaces loading/error/data.
 */
export function useApiData<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  // The state is tagged with the deps key it was produced for. While a request
  // for a *different* parameter set is in flight (e.g. the user navigated to
  // another chapter), the stale payload is treated as "loading" so callers
  // never briefly see data belonging to a previous request. No state is reset
  // synchronously inside the effect — state updates happen only in the async
  // callbacks below, avoiding cascading renders.
  const key = deps.map((d) => JSON.stringify(d)).join("|");
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: unknown;
  }>({ key: null as unknown as string, data: null, error: null });

  useEffect(() => {
    let active = true;
    fetcher()
      .then((d) => {
        if (active) setState({ key, data: d, error: null });
      })
      .catch((e) => {
        if (active) setState({ key, data: null, error: e });
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const fresh = state.key === key;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: !fresh || (fresh && !state.data && !state.error),
  };
}
