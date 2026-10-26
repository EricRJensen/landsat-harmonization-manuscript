import type { PolygonAnalysisResponse } from "../types";
import { areaMeanSlopePerDecade, formatResultValue, polygonAreaSquareKm, significantPixelPercentage } from "../results";
import "../results.css";

function percentage(value: number | null) {
  return value === null ? "Not available" : `${formatResultValue(value, 1)}%`;
}

export function ResultsSummary({ data, index, period }: {
  data: PolygonAnalysisResponse;
  index: string;
  period?: { start_year: number; end_year: number };
}) {
  const years = (data.series.merged ?? []).map((point) => point.year);
  const start = period?.start_year ?? (years.length ? Math.min(...years) : null);
  const end = period?.end_year ?? (years.length ? Math.max(...years) : null);
  const rawTrend = areaMeanSlopePerDecade(data.trends.raw?.slope);
  const harmTrend = areaMeanSlopePerDecade(data.trends.harmonized?.slope);
  const change = rawTrend !== null && harmTrend !== null ? harmTrend - rawTrend : null;
  const area = polygonAreaSquareKm(data.geometry);
  const sources = ["raw", "harmonized"] as const;
  const measures = [
    { label: `Area-mean trend (${index}/decade)`, values: [formatResultValue(rawTrend), formatResultValue(harmTrend)] },
    { label: `Median pixel trend (${index}/decade)`, values: sources.map((source) => formatResultValue(data.trend_distributions[source]?.boxplot?.median)) },
    { label: "Pixels with significant decreases (p ≤ 0.05)", values: sources.map((source) => percentage(significantPixelPercentage(data.trend_distributions[source], "decrease"))) },
    { label: "Pixels with significant increases (p ≤ 0.05)", values: sources.map((source) => percentage(significantPixelPercentage(data.trend_distributions[source], "increase"))) },
    { label: "Evaluated pixels in distribution", values: sources.map((source) => formatResultValue(data.trend_distributions[source]?.pixel_count, 0)) },
  ];
  return <section className="results-summary" aria-label="Analysis summary">
    <header className="results-summary-header">
      <h3>How did harmonization affect the trends?</h3>
      <p>{start !== null && end !== null ? `${start}–${end} · ` : ""}{index}
        {area !== null && <> · Area of interest: ≈{formatResultValue(area, 2)} km²</>}</p>
    </header>
    <div className="results-summary-table-wrap" role="region" aria-label="Analysis summary values" tabIndex={0}>
      <table className="results-summary-table">
        <thead><tr><th scope="col">Measure</th><th scope="col">Unharmonized</th><th scope="col">Harmonized</th></tr></thead>
        <tbody>{measures.map((measure) => <tr key={measure.label}><th scope="row">{measure.label}</th>{measure.values.map((value, position) => <td key={position}>{value}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <dl className="results-summary-mobile">{measures.map((measure) => <div key={measure.label}>
      <dt>{measure.label}</dt>
      {measure.values.map((value, position) => <dd key={position}><span>{position === 0 ? "Unharmonized" : "Harmonized"}</span><strong>{value}</strong></dd>)}
    </div>)}</dl>
    <div className="results-summary-footer">
      {change !== null && <p className="results-change">{change === 0 ? "Area-mean trend unchanged by harmonization." : <>Area-mean trend: {formatResultValue(Math.abs(change))} {index}/decade {change > 0 ? "higher" : "lower"} after harmonization.</>}</p>}
      <details className="results-summary-details"><summary>About these summaries</summary>
        <p className="results-note">Area-mean and median pixel trends measure different quantities. The median pixel trend summarizes trends fitted independently to individual pixels.</p>
        <p className="results-note">Pixel distributions are summarized at 90 m and can include different numbers of valid pixels for the two records. Percentages describe each record separately; they do not measure how many individual pixels changed category.</p>
        <p className="results-note">These differences show sensitivity to the selected harmonization approach; they do not establish per-pixel accuracy.</p>
      </details>
    </div>
  </section>;
}
