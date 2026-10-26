import { useId } from "react";
import { validatePeriod } from "../analysisSetup";
import type { AnalysisConfig, IndexName, Method, Partition } from "../types";
import "../setup.css";

const labels: Record<string, string> = {
  conus: "Conterminous U.S. (CONUS)",
  ecoregion_l2: "Level II ecoregion",
  ecoregion_l3: "Level III ecoregion",
  huc02: "HUC02 watershed",
  nlcd: "Annual NLCD class",
  band_linear: "Band-level · linear",
  band_cubic: "Band-level · third-order polynomial (P3)",
  index_linear: "Index-level · linear",
  index_cubic: "Index-level · third-order polynomial (P3)",
};

interface Props {
  value: AnalysisConfig;
  onChange: (value: AnalysisConfig) => void;
  onSubmit: () => void;
  loading: boolean;
  locked?: boolean;
  embedded?: boolean;
  hasMap?: boolean;
  showSubmit?: boolean;
}

export function TrendControls({
  value, onChange, onSubmit, loading, locked = false, embedded = false, hasMap = false, showSubmit = true,
}: Props) {
  const id = useId();
  const periodError = validatePeriod(value.start_year, value.end_year);
  const set = <K extends keyof AnalysisConfig>(key: K, next: AnalysisConfig[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <section className={`control-card ${embedded ? "embedded" : ""}`} aria-label="Trend analysis controls">
      <div className="control-grid">
        {!locked && <label>
          Coefficient region type
          <select value={value.partition} onChange={(event) => set("partition", event.target.value as Partition)}>
            {(["conus", "ecoregion_l2", "ecoregion_l3", "huc02", "nlcd"] as Partition[]).map((item) => (
              <option key={item} value={item}>{labels[item]}</option>
            ))}
          </select>
        </label>}
        {!locked && <label>
          Harmonization approach
          <select value={value.method} onChange={(event) => set("method", event.target.value as Method)}>
            {(["band_linear", "band_cubic", "index_linear", "index_cubic"] as Method[]).map((item) => (
              <option key={item} value={item}>{labels[item]}</option>
            ))}
          </select>
        </label>}
        {!locked && <label>
          Vegetation index
          <select value={value.index} onChange={(event) => set("index", event.target.value as IndexName)}>
            {(["NDVI", "EVI", "MSAVI"] as IndexName[]).map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>}
        <label>
          Start year
          <input type="number" min={1985} max={2025} step={1} value={Number.isFinite(value.start_year) ? value.start_year : ""}
            aria-invalid={Boolean(periodError)} aria-describedby={periodError ? `${id}-period-error` : undefined}
            onChange={(event) => set("start_year", event.target.valueAsNumber)} />
        </label>
        <label>
          End year
          <input type="number" min={1985} max={2025} step={1} value={Number.isFinite(value.end_year) ? value.end_year : ""}
            aria-invalid={Boolean(periodError)} aria-describedby={periodError ? `${id}-period-error` : undefined}
            onChange={(event) => set("end_year", event.target.valueAsNumber)} />
        </label>
        <label className="check-control">
          <input type="checkbox" checked={value.significant_only}
            aria-describedby={`${id}-filter-help`}
            onChange={(event) => set("significant_only", event.target.checked)} />
          Show only significant trends (p ≤ 0.05)
        </label>
      </div>
      {periodError && <p id={`${id}-period-error`} className="period-validation" role="alert">{periodError}</p>}
      <p id={`${id}-filter-help`} className="trend-filter-guidance">The significance filter affects maps only. The difference map retains pixels significant in both maps. Time series and summaries for your area of interest include all valid pixels.</p>
      {showSubmit && <button className="primary-button" type="button" onClick={onSubmit} disabled={loading || Boolean(periodError)}>
        {loading ? "Building trend maps…" : hasMap ? "Rebuild trend map" : "Build trend map"}
      </button>}
    </section>
  );
}
