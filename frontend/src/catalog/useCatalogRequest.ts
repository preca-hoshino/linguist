import { useEffect, useState } from "react";

type RequestState<T> = { data: T; error?: never } | { data?: never; error: unknown };

export function useCatalogRequest<T>(request: (signal: AbortSignal) => Promise<T>, version = 0) {
  const [result, setResult] = useState<{ request: typeof request; version: number; state: RequestState<T> }>();
  useEffect(() => {
    const controller = new AbortController();
    void request(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setResult({ request, version, state: { data } }); },
      (error: unknown) => { if (!controller.signal.aborted) setResult({ request, version, state: { error } }); },
    );
    return () => { controller.abort(); };
  }, [request, version]);
  return result?.request === request && result.version === version ? result.state : undefined;
}
