import type { AnalysisConfig, IndexName, Method, Partition } from "../types";

const labels: Record<string, string> = {
  conus: "All CONUS pixels",
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
  const set = <K extends keyof AnalysisConfig>(key: K, next: AnalysisConfig[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <section className={`control-card ${embedded ? "embedded" : ""}`} aria-label="Trend analysis controls">
      <div className="control-grid">
        {!locked && <label>
          Partition
          <select value={value.partition} onChange={(event) => set("partition", event.target.value as Partition)}>
            {(["conus", "ecoregion_l2", "ecoregion_l3", "huc02", "nlcd"] as Partition[]).map((item) => (
              <option key={item} value={item}>{labels[item]}</option>
            ))}
          </select>
        </label>}
        {!locked && <label>
          Harmonization
          <select value={value.method} onChange={(event) => set("method", event.target.value as Method)}>
            {(["band_linear", "band_cubic", "index_linear", "index_cubic"] as Method[]).map((item) => (
              <option key={item} value={item}>{labels[item]}</option>
            ))}
          </select>
        </label>}
        {!locked && <label>
          Display index
          <select value={value.index} onChange={(event) => set("index", event.target.value as IndexName)}>
            {(["NDVI", "EVI", "MSAVI"] as IndexName[]).map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>}
        <label>
          Start year
          <input type="number" min={1985} max={value.end_year - 7} value={value.start_year}
            onChange={(event) => set("start_year", Number(event.target.value))} />
        </label>
        <label>
          End year
          <input type="number" min={value.start_year + 7} max={2025} value={value.end_year}
            onChange={(event) => set("end_year", Number(event.target.value))} />
        </label>
        <label className="check-control">
          <input type="checkbox" checked={value.significant_only}
            onChange={(event) => set("significant_only", event.target.checked)} />
          Mask to p ≤ 0.05
        </label>
      </div>
      {showSubmit && <button className="primary-button" type="button" onClick={onSubmit} disabled={loading}>
        {loading ? "Building Earth Engine layers…" : hasMap ? "Update trend map" : "Build trend map"}
      </button>}
    </section>
  );
}
