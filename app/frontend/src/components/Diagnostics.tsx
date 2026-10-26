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
      {open ? "Hide coefficient details" : "View coefficient details"}
    </button>
    {open && <div className="diagnostics-body">
      <h2>Selected coefficients</h2>
      <p>{forward
        ? "Coefficients adjust Landsat 5/7 observations to match OLI, the reference sensor on Landsat 8/9."
        : "Coefficients adjust Landsat 8/9 observations to match ETM+, the reference sensor on Landsat 7."}</p>
      {error && <p className="error-message">{error}</p>}
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
    </div>}
  </aside>;
}
