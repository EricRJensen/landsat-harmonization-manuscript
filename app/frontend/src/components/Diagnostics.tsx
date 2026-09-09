import { useEffect, useState } from "react";
import { api } from "../api";
import type { AnalysisConfig } from "../types";

export function Diagnostics({ config, groupId }: { config: AnalysisConfig; groupId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.coefficients(config.partition, config.method, config.index, config.direction, groupId ?? undefined)
      .then(setData)
      .catch((reason: Error) => setError(reason.message));
    return () => controller.abort();
  }, [config.partition, config.method, config.index, config.direction, groupId]);
  const forward = config.direction === "L7_to_L8";
  return <aside className={`diagnostics ${open ? "open" : ""}`}>
    <button className="diagnostics-toggle" onClick={() => setOpen(!open)}>
      {open ? "Close diagnostics" : "Coefficient diagnostics"}
    </button>
    {open && <div className="diagnostics-body">
      <h2>Active model</h2>
      <p>{forward
        ? "Coefficients transform Landsat 5/7 observations onto the Landsat 8/9 OLI-equivalent reference scale."
        : "Coefficients transform Landsat 8/9 observations onto the Landsat 7 ETM+-equivalent reference scale."}</p>
      {error && <p className="error-message">{error}</p>}
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
    </div>}
  </aside>;
}
