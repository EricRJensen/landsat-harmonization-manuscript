import { useId, type ReactNode } from "react";
import type * as echarts from "echarts";
import { ChartCanvas } from "./ChartCanvas";
import type { HarmonizationDirection, PolygonAnalysisResponse, TimePoint, TimeseriesResponse } from "../types";
import { areaMeanSlopePerDecade, formatResultValue } from "../results";
import "../results.css";

interface LegendItem { name: string; color: string; dashed?: boolean }
interface ChartProps {
  title: string;
  description: string;
  options: echarts.EChartsOption;
  legend?: LegendItem[];
  legendClassName?: string;
  table: ReactNode;
  empty?: boolean;
}

const eras = [
  { name: "Landsat 5", short: "L5", start: 1985, end: 2011 },
  { name: "Landsat 7", short: "L7", start: 1999, end: 2021 },
  { name: "Landsat 8", short: "L8", start: 2013, end: 2025 },
  { name: "Landsat 9", short: "L9", start: 2022, end: 2025 },
];
const colors: Record<string, string> = { L5: "#1b9e77", L7: "#e67e22", L8: "#756bb1", L9: "#e7298a" };
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const sensorName = (name: string) => name.replace(/^L(\d+)$/, "Landsat $1");

function Chart({ title, description, options, legend, legendClassName = "", table, empty = false }: ChartProps) {
  const id = useId();
  return <section className="chart-card paper-chart accessible-chart" aria-labelledby={`${id}-title`}>
    <header><h3 id={`${id}-title`}>{title}</h3></header>
    <p id={`${id}-description`} className="chart-description">{description}</p>
    {legend && <ul className={`chart-visible-legend ${legendClassName}`} aria-label="Chart legend">{legend.map((item) => <li key={item.name}>
      <span aria-hidden="true" className={item.dashed ? "legend-line dashed" : "legend-line"} style={{ borderColor: item.color }} />{item.name}
    </li>)}</ul>}
    {empty ? <p className="chart-empty">No valid observations are available for this chart.</p>
      : <ChartCanvas option={options} className="chart" ariaLabel={`${title}. ${description} Numerical values are available in the table below.`} describedBy={`${id}-description`} />}
    <details className="chart-data"><summary>View values as a table</summary>
      <div className="chart-table-scroll" role="region" aria-label={`${title} values`} tabIndex={0}>{table}</div>
    </details>
  </section>;
}

export function SensorEraPanel({ yearMin, yearMax }: { yearMin: number; yearMax: number }) {
  const visible = eras.filter((era) => era.start <= yearMax && era.end >= yearMin);
  // Center each annual value in its year so even a single included year has
  // a visible interval, with transitions aligned to the time-series charts.
  const range = Math.max(1, yearMax - yearMin + 1);
  const position = (year: number) => 100 * (year - yearMin + 0.5) / range;
  const ticks = [yearMin];
  for (let year = Math.ceil((yearMin + 1) / 5) * 5; year < yearMax - 1; year += 5) ticks.push(year);
  if (yearMax > yearMin) ticks.push(yearMax);
  const transitions = [2012.5, 2021.5].filter((year) => year > yearMin - 0.5 && year < yearMax + 0.5);
  const description = visible.map((era) => `${era.name}: ${Math.max(yearMin, era.start)}–${Math.min(yearMax, era.end)}`).join("; ");
  return <details className="chart-card sensor-era-details">
    <summary>Landsat sensor coverage in this analysis</summary>
    <p>The merged record combines observations from the available sensors. The dashed lines mark the transitions into 2013 and 2022, as in the time-series charts; they do not indicate a measured change.</p>
    <div className="sensor-coverage-chart" role="img" aria-label={`Sensor coverage by year. ${description}. Bars show years included by the app, not local observation completeness.`}>
      {visible.map((era) => {
        const start = Math.max(yearMin, era.start);
        const end = Math.min(yearMax, era.end);
        return <div className="sensor-coverage-row" key={era.short}>
          <div className="sensor-coverage-label"><strong>{era.name}</strong><span>{start}–{end}</span></div>
          <div className="sensor-coverage-track">
            {ticks.map((year) => <i key={year} className="sensor-coverage-gridline" style={{ left: `${position(year)}%` }} />)}
            <span className="sensor-coverage-bar" style={{ left: `${position(start - 0.5)}%`, width: `${100 * (end - start + 1) / range}%`, background: colors[era.short] }} />
            {transitions.map((year) => <i key={year} className="sensor-coverage-transition" style={{ left: `${position(year)}%` }} />)}
          </div>
        </div>;
      })}
      <div className="sensor-coverage-axis">
        {ticks.map((year, i) => <span key={year} className={ticks.length > 5 && i % 2 === 1 && i !== ticks.length - 1 ? "sensor-coverage-minor-tick" : undefined} style={{ left: `${position(year)}%` }}>{year}</span>)}
      </div>
      <div className="sensor-coverage-axis-title">Year</div>
    </div>
    <p className="results-note">These are the years included by the app within the displayed period. Cloud masking and local observation availability can leave gaps. Landsat 5 is included through 2011 and Landsat 7 through 2021.</p>
  </details>;
}

const missionLines = {
  silent: true, symbol: "none", label: { show: false },
  lineStyle: { color: "#68716d", type: "dashed" as const, width: 1 },
  data: [{ xAxis: 2012.5 }, { xAxis: 2021.5 }],
};

function trendCell(value: number | null | undefined) {
  if (!valid(value)) return "Not available";
  return value >= 0 && value < 0.0001 ? "< 0.0001" : formatResultValue(value);
}

export function TimeseriesCharts({ data, index, direction, period }: {
  data: TimeseriesResponse | PolygonAnalysisResponse;
  index: string;
  direction: HarmonizationDirection;
  period?: { start_year: number; end_year: number };
}) {
  const forward = direction === "L7_to_L8";
  const targetLabel = forward ? "OLI" : "ETM+";
  const transformedSensors = forward ? ["L5", "L7"] : ["L8", "L9"];
  const merged = data.series.merged ?? [];
  const years = Object.values(data.series).flatMap((values) => values.map((item) => item.year));
  const yearMin = period?.start_year ?? (years.length ? Math.min(...years) : 1985);
  const yearMax = period?.end_year ?? (years.length ? Math.max(...years) : 2025);
  const common = {
    animation: false,
    tooltip: { trigger: "axis" },
    grid: { left: 54, right: 18, top: 32, bottom: 48 },
    xAxis: {
      type: "value", name: "Year", nameLocation: "middle", nameGap: 28, min: yearMin, max: yearMax, minInterval: 1,
      boundaryGap: [0, 0], axisLabel: { hideOverlap: true, formatter: (value: number) => String(Math.round(value)) },
      axisPointer: { label: { formatter: ({ value }) => String(Math.round(Number(value))) } },
    },
    yAxis: { type: "value", name: index, scale: true, axisLabel: { formatter: (value: number) => formatResultValue(value, 3) } },
  } satisfies echarts.EChartsOption;
  const mergedLegend = [
    { name: `Harmonized · ${targetLabel} reference`, color: "#24394d" },
    { name: "Unharmonized", color: "#c93425", dashed: true },
  ];
  const mergedOptions: echarts.EChartsOption = {
    ...common,
    series: [
      { name: mergedLegend[0].name, type: "line", symbolSize: 6, color: mergedLegend[0].color,
        connectNulls: false, data: merged.map((item) => [item.year, item.harm ?? null]), markLine: missionLines },
      { name: mergedLegend[1].name, type: "line", symbolSize: 6, color: mergedLegend[1].color,
        connectNulls: false, lineStyle: { type: "dashed" }, data: merged.map((item) => [item.year, item.raw ?? null]) },
    ],
  };
  const sensorEntries = Object.entries(data.series).filter(([name]) => name !== "merged");
  const sensorLegend: LegendItem[] = [];
  const sensorSeries = sensorEntries.flatMap(([name, values], indexPosition) => {
    const points = values as TimePoint[];
    const raw = {
      name: sensorName(name), type: "line" as const, connectNulls: false, symbolSize: 6,
      itemStyle: { color: colors[name] }, lineStyle: { color: colors[name], width: 2 },
      data: points.map((item) => [item.year, item.raw ?? null]),
      ...(indexPosition === 0 ? { markLine: missionLines } : {}),
    };
    sensorLegend.push({ name: raw.name, color: colors[name] ?? "#475569" });
    if (points.some((item) => valid(item.harm)) && transformedSensors.includes(name)) {
      const nameHarm = `${sensorName(name)} · ${targetLabel}-equivalent`;
      sensorLegend.push({ name: nameHarm, color: colors[name] ?? "#475569", dashed: true });
      return [raw, { ...raw, name: nameHarm, symbol: "none", lineStyle: { color: colors[name], type: "dashed" as const, width: 2 }, data: points.map((item) => [item.year, item.harm ?? null]) }];
    }
    return [raw];
  });
  const sensorOptions: echarts.EChartsOption = { ...common, series: sensorSeries };
  const hasHarmonizedSensors = sensorEntries.some(([name, values]) => transformedSensors.includes(name) && values.some((point) => valid(point.harm)));
  const mergedTable = <>
    <table><caption>Merged Landsat annual values · {index}.</caption>
      <thead><tr><th scope="col">Year</th><th scope="col">Unharmonized</th><th scope="col">Harmonized</th><th scope="col">Scenes</th></tr></thead>
      <tbody>{merged.map((point) => <tr key={point.year}><th scope="row">{point.year}</th><td>{formatResultValue(point.raw, 6)}</td><td>{formatResultValue(point.harm, 6)}</td><td>{formatResultValue(point.scene_count, 0)}</td></tr>)}</tbody>
    </table>
    <table><caption>Trends fitted to the area-mean annual record. At least eight valid years are required.</caption>
      <thead><tr><th scope="col">Record</th><th scope="col">Trend ({index}/decade)</th><th scope="col">p-value</th><th scope="col">Kendall’s tau</th><th scope="col">Valid years</th></tr></thead>
      <tbody>{(["raw", "harmonized"] as const).map((source) => <tr key={source}><th scope="row">{source === "raw" ? "Unharmonized" : "Harmonized"}</th><td>{formatResultValue(areaMeanSlopePerDecade(data.trends[source]?.slope), 6)}</td><td>{trendCell(data.trends[source]?.p_value)}</td><td>{formatResultValue(data.trends[source]?.tau)}</td><td>{formatResultValue(data.trends[source]?.n, 0)}</td></tr>)}</tbody>
    </table>
  </>;
  const sensorTable = <table><caption>Individual-sensor annual values. Missing values are not interpolated.</caption>
    <thead><tr><th scope="col">Sensor</th><th scope="col">Year</th><th scope="col">Unharmonized {index}</th>{hasHarmonizedSensors && <th scope="col">Harmonized {index}</th>}<th scope="col">Scenes</th></tr></thead>
    <tbody>{sensorEntries.flatMap(([name, points]) => points.map((point) => <tr key={`${name}-${point.year}`}><th scope="row">{sensorName(name)}</th><td>{point.year}</td><td>{formatResultValue(point.raw, 6)}</td>{hasHarmonizedSensors && <td>{transformedSensors.includes(name) ? formatResultValue(point.harm, 6) : "Reference sensor"}</td>}<td>{formatResultValue(point.scene_count, 0)}</td></tr>))}</tbody>
  </table>;
  return <div className="paper-figure-stack">
    <Chart title={`Merged Landsat record · ${index}`} description="Gaps indicate missing annual values." options={mergedOptions} legend={mergedLegend} table={mergedTable} empty={!merged.some((point) => valid(point.raw) || valid(point.harm))} />
    <Chart title={`Individual Landsat sensors · ${index}`} description="Differences between years can also reflect observation availability and environmental variation." options={sensorOptions} legend={sensorLegend} table={sensorTable} empty={!sensorEntries.some(([, points]) => points.some((point) => valid(point.raw)))} />
    <SensorEraPanel yearMin={yearMin} yearMax={yearMax} />
  </div>;
}

const classDefinitions = [
  { key: "-3", name: "Significant Decrease (p ≤ 0.01)", color: "#a50f15" },
  { key: "-2", name: "Significant Decrease (p ≤ 0.05)", color: "#ef6548" },
  { key: "-1", name: "Non-Significant Decrease", color: "#fdd49e" },
  { key: "3", name: "Significant Increase (p ≤ 0.01)", color: "#08519c" },
  { key: "2", name: "Significant Increase (p ≤ 0.05)", color: "#6baed6" },
  { key: "1", name: "Non-Significant Increase", color: "#deebf7" },
] as const;
// Legend/table read from the outer, non-significant segments toward zero.
// Keep series order intact: ECharts stacks each sign outward from zero.
const classLegend = [
  ...classDefinitions.slice(0, 3).reverse(),
  ...classDefinitions.slice(3).reverse(),
];

export function PolygonTrendCharts({ data, index }: { data: PolygonAnalysisResponse; index: string }) {
  const sources = ["raw", "harmonized"] as const;
  const boxData = sources.map((source) => {
    const box = data.trend_distributions[source]?.boxplot;
    const values = box ? [box.low, box.q1, box.median, box.q3, box.high] : [];
    return values.length === 5 && values.every(valid) ? values : [NaN, NaN, NaN, NaN, NaN];
  });
  const boxOptions: echarts.EChartsOption = {
    animation: false,
    tooltip: { trigger: "item" },
    grid: { left: 64, right: 18, top: 32, bottom: 48 },
    xAxis: { type: "category", data: ["Unharmonized", "Harmonized"], axisLabel: { fontSize: 11, interval: 0 } },
    yAxis: { type: "value", name: `${index} / decade` },
    series: [{ name: "Pixel trend distribution", type: "boxplot", data: boxData,
      itemStyle: { color: "#d9e4ea", borderColor: "#24394d", borderWidth: 2 } }],
  };
  const classOptions: echarts.EChartsOption = {
    animation: false,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (value) => `${Math.abs(Number(value)).toFixed(1)}%` },
    grid: { left: 48, right: 18, top: 32, bottom: 48 },
    xAxis: { type: "category", data: ["Unharmonized", "Harmonized"], axisLabel: { fontSize: 11, interval: 0 } },
    yAxis: { type: "value", name: "% of evaluated pixels", axisLabel: { formatter: (value: number) => `${Math.abs(value)}` } },
    series: classDefinitions.map((definition) => ({ name: definition.name, type: "bar" as const, stack: "trend", color: definition.color,
      data: sources.map((source) => {
        const distribution = data.trend_distributions[source];
        const value = distribution?.pixel_count > 0 ? distribution.class_percentages[definition.key] : undefined;
        return valid(value) ? (definition.key.startsWith("-") ? -value : value) : null;
      }) })),
  };
  const boxTable = <table><caption>Pixel trends in {index}/decade, summarized at 90 m.</caption>
    <thead><tr><th scope="col">Record</th><th scope="col">5th percentile</th><th scope="col">25th percentile</th><th scope="col">Median</th><th scope="col">75th percentile</th><th scope="col">95th percentile</th></tr></thead>
    <tbody>{sources.map((source) => <tr key={source}><th scope="row">{source === "raw" ? "Unharmonized" : "Harmonized"}</th>{(["low", "q1", "median", "q3", "high"] as const).map((key) => <td key={key}>{formatResultValue(data.trend_distributions[source]?.boxplot?.[key], 6)}</td>)}</tr>)}</tbody>
  </table>;
  const classTable = <table><caption>Percent of each record’s evaluated pixels. Categories are mutually exclusive.</caption>
    <thead><tr><th scope="col">Trend category</th><th scope="col">Unharmonized</th><th scope="col">Harmonized</th></tr></thead>
    <tbody>{classLegend.map((definition) => <tr key={definition.key}><th scope="row">{definition.name}</th>{sources.map((source) => {
      const distribution = data.trend_distributions[source];
      const value = distribution?.pixel_count > 0 ? distribution.class_percentages[definition.key] : undefined;
      return <td key={source}>{valid(value) ? `${formatResultValue(value, 2)}%` : "Not available"}</td>;
    })}</tr>)}</tbody>
  </table>;
  return <div className="polygon-figure-grid">
    <Chart title="Distribution of pixel trends" description={`Pixel trends are Theil–Sen slopes in ${index} units per decade. Boxes span the central 50% (25th–75th percentiles), the line is the median, and whiskers show the 5th and 95th percentiles. These are not confidence intervals. The map significance filter does not restrict this distribution.`} options={boxOptions} table={boxTable} empty={!boxData.some((values) => values.every(valid))} />
    <Chart title="Trend direction and statistical significance" description="Decreases are plotted below zero and increases above zero. All values are percentages of evaluated pixels in that record. Non-significant classes have p > 0.05; zero slopes are grouped with increases. The p ≤ 0.05 classes contain only 0.01 < p ≤ 0.05; pixels with p ≤ 0.01 are shown separately. The map significance filter does not filter these summaries." options={classOptions} legend={classLegend} legendClassName="trend-class-legend" table={classTable} empty={!sources.some((source) => data.trend_distributions[source]?.pixel_count > 0)} />
  </div>;
}
