import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { HarmonizationDirection, PolygonAnalysisResponse, TimePoint, TimeseriesResponse } from "../types";

interface ChartProps {
  title: string;
  panel?: string;
  options: echarts.EChartsOption;
}

const eras = [
  { name: "Landsat 5", short: "L5", start: 1985, end: 2011 },
  { name: "Landsat 7", short: "L7", start: 1999, end: 2021 },
  { name: "Landsat 8", short: "L8", start: 2013, end: 2025 },
  { name: "Landsat 9", short: "L9", start: 2022, end: 2025 },
];

const sensorCompositionEras = [
  { label: "TM/ETM+", start: 1984, end: 2012 },
  { label: "ETM+/OLI", start: 2013, end: 2021 },
  { label: "OLI/OLI-2", start: 2022, end: 2025 },
];

const colors: Record<string, string> = {
  L5: "#1b9e77",
  L7: "#e67e22",
  L8: "#756bb1",
  L9: "#e7298a",
};

function Chart({ title, panel, options }: ChartProps) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const chart = echarts.init(container.current);
    chart.setOption(options);
    let resizeFrame: number | null = null;
    const resize = new ResizeObserver(() => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        chart.resize();
      });
    });
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      chart.dispose();
    };
  }, [options]);
  return <section className="chart-card paper-chart">
    <header>{panel && <span>{panel}</span>}<h3>{title}</h3></header>
    <div ref={container} className="chart" role="img" aria-label={title} />
  </section>;
}

function SensorEraPanel({ yearMin, yearMax }: { yearMin: number; yearMax: number }) {
  const range = Math.max(1, yearMax - yearMin);
  const position = (year: number) => 100 * (year - yearMin) / range;
  const ticks = Array.from({ length: Math.floor((yearMax - yearMin) / 5) + 1 }, (_, index) => {
    const year = Math.ceil(yearMin / 5) * 5 + index * 5;
    return year <= yearMax ? year : null;
  }).filter((year): year is number => year !== null);
  return <section className="chart-card sensor-era-panel">
    <header><span>B</span><h3>Landsat sensor eras</h3></header>
    <div className="era-timeline">
      <div className="era-mission-labels">
        {sensorCompositionEras.map((era) => {
          const visibleStart = Math.max(yearMin, era.start);
          const visibleEnd = Math.min(yearMax, era.end);
          if (visibleStart > visibleEnd) return null;
          const midpoint = (visibleStart + visibleEnd) / 2;
          return <span key={era.label} style={{ left: `${position(midpoint)}%` }}>
            {era.label}<br />{era.start}–{era.end}
          </span>;
        })}
      </div>
      <div className="era-plot">
        {[2012.5, 2021.5].map((year) => {
          const percent = position(year);
          return <i key={year} className="mission-boundary" style={{ left: `calc(${percent}% + ${110 * (1 - percent / 100)}px)` }} />;
        })}
        {eras.map((era) => {
          const start = Math.max(yearMin, era.start);
          const end = Math.min(yearMax, era.end);
          if (start > end) return null;
          return <div className="era-row" key={era.short}>
            <strong>{era.name}</strong>
            <div className="era-track"><span style={{
              left: `${position(start)}%`,
              width: `${Math.max(1, position(end) - position(start))}%`,
              background: colors[era.short],
            }}>{era.short === "L7" && <em>Scan line corrector off</em>}</span></div>
          </div>;
        })}
        <div className="era-axis">
          {ticks.map((year) => <span key={year} style={{ left: `${position(year)}%` }}>{year}</span>)}
        </div>
      </div>
    </div>
  </section>;
}

const missionLines = {
  silent: true,
  symbol: "none",
  label: { show: false },
  lineStyle: { color: "#68716d", type: "dashed" as const, width: 1 },
  data: [{ xAxis: 2012.5 }, { xAxis: 2021.5 }],
};

export function TimeseriesCharts({ data, index, direction }: {
  data: TimeseriesResponse | PolygonAnalysisResponse;
  index: string;
  direction: HarmonizationDirection;
}) {
  const forward = direction === "L7_to_L8";
  const targetLabel = forward ? "OLI" : "ETM+";
  const transformedSensors = forward ? ["L5", "L7"] : ["L8", "L9"];
  const merged = data.series.merged ?? [];
  const years = Object.values(data.series).flatMap((values) => values.map((item) => item.year));
  const yearMin = years.length ? Math.min(...years) : 1985;
  const yearMax = years.length ? Math.max(...years) : 2025;
  const common = {
    animation: false,
    tooltip: { trigger: "axis" },
    grid: { left: 70, right: 22, top: 48, bottom: 48 },
    xAxis: {
      type: "value", name: "Year", min: yearMin, max: yearMax, minInterval: 1,
      boundaryGap: [0, 0], axisLabel: { formatter: (value: number) => String(Math.round(value)) },
    },
    yAxis: { type: "value", name: `Apr–Sep ${index}`, scale: true },
  } satisfies echarts.EChartsOption;
  const mergedOptions: echarts.EChartsOption = {
    ...common,
    legend: { top: 4 },
    series: [
      {
        name: `${targetLabel}-equivalent harmonized`, type: "line", symbolSize: 6, color: "#24394d",
        data: merged.map((item) => [item.year, item.harm]), markLine: missionLines,
      },
      {
        name: "Unharmonized", type: "line", symbolSize: 6, color: "#c93425",
        data: merged.map((item) => [item.year, item.raw]),
      },
    ],
  };
  const sensorSeries = Object.entries(data.series)
    .filter(([name]) => name !== "merged")
    .flatMap(([name, values], indexPosition) => {
      const points = values as TimePoint[];
      const raw = {
        name: name.replace("L", "Landsat "),
        type: "line" as const,
        connectNulls: false,
        symbolSize: 6,
        itemStyle: { color: colors[name] },
        lineStyle: { color: colors[name], width: 2 },
        data: points.map((item) => [item.year, item.raw]),
        ...(indexPosition === 0 ? { markLine: missionLines } : {}),
      };
      return points.some((item) => item.harm !== undefined) && transformedSensors.includes(name)
        ? [raw, {
            ...raw,
            name: `${name.replace("L", "Landsat ")} · ${targetLabel}-equivalent`,
            symbol: "none",
            lineStyle: { color: colors[name], type: "dashed" as const, width: 2 },
            data: points.map((item) => [item.year, item.harm]),
          }]
        : [raw];
    });
  const sensorOptions: echarts.EChartsOption = { ...common, legend: { top: 4 }, series: sensorSeries };
  return <div className="paper-figure-stack">
    <SensorEraPanel yearMin={yearMin} yearMax={yearMax} />
    <Chart panel="C" title={`Individual Landsat sensors · growing-season ${index}`} options={sensorOptions} />
    <Chart panel="D" title={`Merged Landsat 5/7/8/9 · unharmonized vs ${targetLabel}-equivalent ${index}`} options={mergedOptions} />
  </div>;
}

const classDefinitions = [
  // ECharts stacks in series order, so each direction runs from strongest
  // significance at zero to non-significant at the outside edge.
  { key: "-3", name: "Decrease · p ≤ 0.01", color: "#a50f15" },
  { key: "-2", name: "Decrease · p ≤ 0.05", color: "#ef6548" },
  { key: "-1", name: "Decrease · not significant", color: "#fdd49e" },
  { key: "3", name: "Increase · p ≤ 0.01", color: "#08519c" },
  { key: "2", name: "Increase · p ≤ 0.05", color: "#6baed6" },
  { key: "1", name: "Increase · not significant", color: "#deebf7" },
] as const;

export function PolygonTrendCharts({ data, index }: { data: PolygonAnalysisResponse; index: string }) {
  const sources = ["raw", "harmonized"] as const;
  const boxData = sources.map((source) => {
    const box = data.trend_distributions[source]?.boxplot;
    return box ? [box.low, box.q1, box.median, box.q3, box.high] : [];
  });
  const boxOptions: echarts.EChartsOption = {
    animation: false,
    tooltip: { trigger: "item" },
    grid: { left: 72, right: 24, top: 24, bottom: 52 },
    xAxis: { type: "category", data: ["Unharmonized", "Harmonized"] },
    yAxis: { type: "value", name: `Apr–Sep ${index} trend / decade` },
    series: [{
      name: "Pixel trend distribution", type: "boxplot", data: boxData,
      itemStyle: { color: "#d9e4ea", borderColor: "#24394d", borderWidth: 2 },
    }],
  };
  const classOptions: echarts.EChartsOption = {
    animation: false,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (value) => `${Number(value).toFixed(1)}%` },
    legend: { top: 0, type: "scroll" },
    grid: { left: 64, right: 20, top: 58, bottom: 52 },
    xAxis: { type: "category", data: ["Unharmonized", "Harmonized"] },
    yAxis: { type: "value", name: "% of pixels", axisLabel: { formatter: (value: number) => `${Math.abs(value)}` } },
    series: classDefinitions.map((definition) => ({
      name: definition.name,
      type: "bar" as const,
      stack: "trend",
      color: definition.color,
      data: sources.map((source) => {
        const value = data.trend_distributions[source]?.class_percentages[definition.key] ?? 0;
        return definition.key.startsWith("-") ? -value : value;
      }),
    })),
  };
  return <div className="polygon-figure-grid">
    <Chart panel="E" title="Distribution of per-pixel growing-season trends" options={boxOptions} />
    <Chart panel="F" title="Trend direction and statistical significance" options={classOptions} />
  </div>;
}
