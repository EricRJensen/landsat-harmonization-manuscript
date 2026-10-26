import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type * as echarts from "echarts";
import { ChartCanvas } from "./ChartCanvas";
import { api } from "../api";
import { SelectedCoefficients } from "./SelectedCoefficients";
import { RegionGuide } from "./RegionGuide";
import { useWorkflowNavigation } from "../useWorkflowNavigation";
import "../exploreGuidance.css";
import type {
  EvaluationAlternative,
  EvaluationResponse,
  HarmonizationChoice,
  HarmonizationDirection,
  IndexName,
  NestedEcoregion,
  Partition,
  RegionSummary,
} from "../types";

const REGION_TYPES: Array<{ id: Partition; label: string; detail: string }> = [
  { id: "conus", label: "CONUS", detail: "Coefficients fitted across the conterminous U.S." },
  { id: "ecoregion_l1", label: "Level I", detail: "10 broad ecological regions" },
  { id: "ecoregion_l2", label: "Level II", detail: "20 ecological regions" },
  { id: "ecoregion_l3", label: "Level III", detail: "85 detailed ecological regions" },
  { id: "huc02", label: "HUC02", detail: "18 major watershed regions" },
];

const DIRECTIONS: Array<{
  id: HarmonizationDirection;
  label: string;
  notation: string;
  detail: string;
}> = [
  {
    id: "L7_to_L8",
    label: "Use OLI as reference",
    notation: "L7 → L8",
    detail: "Adjust Landsat 5/7 observations to match OLI, the reference sensor on Landsat 8/9.",
  },
  {
    id: "L8_to_L7",
    label: "Use ETM+ as reference",
    notation: "L8 → L7",
    detail: "Adjust Landsat 8/9 observations to match ETM+, the reference sensor on Landsat 7.",
  },
];

const METHOD_DETAILS: Record<string, { title: string; fit: string }> = {
  band_linear: { title: "Band-level", fit: "Linear" },
  band_cubic: { title: "Band-level", fit: "Third-order polynomial (P3)" },
  index_linear: { title: "Index-level", fit: "Linear" },
  index_cubic: { title: "Index-level", fit: "Third-order polynomial (P3)" },
  unharmonized: { title: "Unharmonized", fit: "No transformation" },
};

const METHOD_LABELS = Object.fromEntries(
  Object.entries(METHOD_DETAILS).map(([key, value]) => [key, `${value.title} · ${value.fit}`]),
) as Record<string, string>;

const CHART_METHOD_LABELS: Record<string, string> = {
  band_linear: "B-Lin",
  band_cubic: "B-P3",
  index_linear: "I-Lin",
  index_cubic: "I-P3",
  unharmonized: "Unh.",
  roy_2016_band_ols: "Roy 2016",
};

const COLORS: Record<string, string> = {
  band_linear: "#756bb1",
  band_cubic: "#9e9ac8",
  index_linear: "#1b9e77",
  index_cubic: "#66c2a4",
  unharmonized: "#59636e",
  roy_2016_band_ols: "#2563b8",
};

const ROY_2016_ID = "roy_2016_band_ols";

function alternativeLabel(alternative: EvaluationAlternative) {
  return CHART_METHOD_LABELS[alternative.id]
    ?? CHART_METHOD_LABELS[alternative.method ?? "unharmonized"];
}

function alternativeColor(alternative: EvaluationAlternative) {
  return COLORS[alternative.id] ?? COLORS[alternative.method ?? "unharmonized"];
}

function format(value: number | null | undefined, digits = 4) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function signedPercent(value: number | null) {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function coefficientScopeLabel(source: EvaluationAlternative["source"]) {
  if (source === "CONUS") return "CONUS coefficients";
  if (source === "regional") return "Regional coefficients";
  if (source === "published") return "Published coefficients";
  return "Unharmonized baseline";
}

function percentBiasImprovement(rawBias: number | null | undefined, bias: number | null | undefined) {
  if (typeof rawBias !== "number" || typeof bias !== "number" || Math.abs(rawBias) < Number.EPSILON) return null;
  return 100 * (Math.abs(rawBias) - Math.abs(bias)) / Math.abs(rawBias);
}

function equation(metric: string, coefficients: number[], direction: HarmonizationDirection) {
  const source = direction === "L7_to_L8" ? "ETM+" : "OLI";
  const target = direction === "L7_to_L8" ? "OLI" : "ETM+";
  return `${metric}: ${target} = ${coefficients.map((value, power) => {
    const magnitude = Math.abs(value).toPrecision(5);
    if (power === 0) return value.toPrecision(5);
    return `${value < 0 ? "−" : "+"} ${magnitude}·${source}${power > 1 ? `^${power}` : ""}`;
  }).join(" ")}`;
}

function MiniChart({ option, ariaLabel }: { option: echarts.EChartsOption; ariaLabel: string }) {
  return <ChartCanvas option={option} className="metric-chart" ariaLabel={ariaLabel} />;
}

function ComparisonPanel({ evaluation, selectedId, source, title, children, pending, subtitle }: {
  evaluation: EvaluationResponse; selectedId: string; source: "CONUS" | "regional";
  title: string; children?: ReactNode; pending?: ReactNode; subtitle?: ReactNode;
}) {
  const raw = evaluation.alternatives.find((item) => item.id === "unharmonized");
  const roy = evaluation.alternatives.find((item) => item.id === ROY_2016_ID && item.available);
  const sourceLabel = evaluation.source_sensor === "L7" ? "ETM+" : "OLI";
  const models = evaluation.alternatives.filter((item) => item.source === source && item.available);
  const alternatives = [...(raw ? [raw] : []), ...(roy ? [roy] : []), ...models];
  const categoryLabels = alternatives.map(alternativeLabel);
  const barData = (metric: "rmse" | "mean_difference") => alternatives.map((item) => ({
    value: item.metrics?.[metric],
    itemStyle: { color: alternativeColor(item), borderColor: "#292535", borderWidth: item.id === selectedId ? 2 : 0 },
  }));
  const maxAbsoluteBias = Math.max(
    ...alternatives.map((item) => Math.abs(item.metrics?.mean_difference ?? 0)),
    0.001,
  );
  const biasPadding = maxAbsoluteBias * 1.12;
  const biasStep = 10 ** (Math.floor(Math.log10(biasPadding)) - 1);
  const biasLimit = Math.ceil(biasPadding / biasStep) * biasStep;
  const rmseOption: echarts.EChartsOption = {
    animation: false,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 52, right: 12, top: 12, bottom: 72 },
    xAxis: { type: "category", data: categoryLabels, axisLabel: { rotate: 35 } },
    yAxis: { type: "value", name: "RMSE", min: 0 },
    series: [{ type: "bar", data: barData("rmse") }],
  };
  const biasOption: echarts.EChartsOption = {
    animation: false,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 60, right: 12, top: 12, bottom: 72 },
    xAxis: { type: "category", data: categoryLabels, axisLabel: { rotate: 35 } },
    yAxis: {
      type: "value", name: "Mean bias", min: -biasLimit, max: biasLimit,
      axisLine: { show: true },
      axisLabel: { formatter: (value: number) => Number(value.toPrecision(3)).toString() },
    },
    series: [{ type: "bar", data: barData("mean_difference") }],
  };
  const binLabels = Array.from({ length: 10 }, (_, i) => `(${(i / 10).toFixed(1)},${((i + 1) / 10).toFixed(1)}]`);
  const binOption: echarts.EChartsOption = {
    animation: false,
    tooltip: { trigger: "axis" },
    legend: { show: false },
    grid: { left: 56, right: 12, top: 28, bottom: 100 },
    xAxis: {
      type: "category", data: binLabels, name: `Unharmonized ${sourceLabel} ${evaluation.index} bin`,
      nameLocation: "middle", nameGap: 72,
      axisLine: { onZero: false }, axisLabel: { rotate: 45 },
    },
    yAxis: { type: "value", name: "Mean bias", scale: true },
    series: alternatives.map((item) => ({
      name: item.id === "unharmonized" ? "Unharmonized" : item.id === ROY_2016_ID ? "Roy et al. (2016)" : METHOD_LABELS[item.method!],
      type: "line", symbolSize: item.id === selectedId ? 7 : 5, connectNulls: false,
      lineStyle: { width: item.id === selectedId ? 4 : 2 },
      color: alternativeColor(item),
      data: item.metrics?.bins.map((bin) => bin.mean_difference) ?? [],
    })),
  };
  return <section className="comparison-panel">
    <header className="comparison-panel-header"><h3>{title}</h3>{children}</header>
    {subtitle && <p className="comparison-panel-subtitle" role="status">{subtitle}</p>}
    {pending || <>
    <ul className="comparison-chart-key" aria-label="Chart method key">{alternatives.map((item) => <li key={item.id} className={item.id === selectedId ? "selected" : ""}>
      <span style={{ background: alternativeColor(item) }} aria-hidden="true" />
      <span><strong>{alternativeLabel(item)}</strong> = {item.id === "unharmonized" ? "Unharmonized" : item.id === ROY_2016_ID ? "Roy et al. (2016)" : METHOD_LABELS[item.method!]}{item.id === selectedId && " · selected"}</span>
    </li>)}</ul>
    <div className="metric-chart-grid">
      <div><h4>Held-out RMSE</h4><MiniChart option={rmseOption} ariaLabel={`${source} RMSE comparison`} /></div>
      <div><h4>Held-out mean bias</h4><MiniChart option={biasOption} ariaLabel={`${source} mean bias comparison`} /></div>
      <div><h4>Mean bias across the index range</h4><MiniChart option={binOption} ariaLabel={`${source} binned mean bias`} /></div>
    </div>
    <details className="chart-data-details"><summary>Read chart values as tables</summary>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={`${source} overall evaluation values`}><table>
        <caption>Held-out evaluation in {evaluation.group_name}</caption>
        <thead><tr><th>Approach</th><th>Paired observations</th><th>RMSE</th><th>Mean bias</th></tr></thead>
        <tbody>{alternatives.map((item) => <tr key={item.id}><th scope="row">{item.id === "unharmonized" ? "Unharmonized" : item.id === ROY_2016_ID ? "Roy et al. (2016)" : METHOD_LABELS[item.method!]}{item.id === selectedId && " (selected)"}</th><td>{item.metrics?.n.toLocaleString()}</td><td>{format(item.metrics?.rmse, 6)}</td><td>{format(item.metrics?.mean_difference, 6)}</td></tr>)}</tbody>
      </table></div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={`${source} mean bias by index range`}><table>
        <caption>Mean bias by unharmonized {sourceLabel} {evaluation.index} range</caption>
        <thead><tr><th>Index range</th>{alternatives.map((item) => <th key={item.id}>{alternativeLabel(item)}</th>)}</tr></thead>
        <tbody>{binLabels.map((label, i) => <tr key={label}><th scope="row">{label}</th>{alternatives.map((item) => <td key={item.id}>{format(item.metrics?.bins[i]?.mean_difference, 6)}</td>)}</tr>)}</tbody>
      </table></div>
    </details>
    </>}
  </section>;
}

function ComparisonCharts({ evaluation, selectedId }: { evaluation: EvaluationResponse; selectedId: string }) {
  const canExploreChildren = evaluation.partition === "ecoregion_l1" || evaluation.partition === "ecoregion_l2";
  const [regions, setRegions] = useState<NestedEcoregion[]>([]);
  const [regionsError, setRegionsError] = useState("");
  const [regionKey, setRegionKey] = useState("");
  const [result, setResult] = useState<{ key: string; data: EvaluationResponse } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const selectedRegion = regions.find(region => `${region.partition}:${region.id}` === regionKey);

  useEffect(() => {
    if (!canExploreChildren) return;
    const controller = new AbortController();
    setRegionsError("");
    void api.childEcoregions(evaluation.partition, evaluation.group_id, controller.signal)
      .then(response => { if (!controller.signal.aborted) setRegions(response.regions); })
      .catch(reason => { if (!controller.signal.aborted) setRegionsError((reason as Error).message); });
    return () => controller.abort();
  }, [evaluation.partition, evaluation.group_id, canExploreChildren, retry]);

  useEffect(() => {
    if (!selectedRegion) return;
    const controller = new AbortController();
    setError("");
    void api.nestedEvaluation(evaluation, selectedRegion, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult({ key: regionKey, data }); })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    return () => controller.abort();
  }, [evaluation, selectedRegion, regionKey, retry]);

  const nested = regionKey && result?.key === regionKey ? result.data : null;
  const pairs = nested?.alternatives.find(item => item.id === "unharmonized")?.metrics?.n ?? 0;
  const displayedPairs = regionKey ? nested && !error ? pairs : null
    : evaluation.alternatives.find(item => item.id === "unharmonized")?.metrics?.n;
  const pending = regionKey && (error
    ? <p className="nested-evaluation-feedback" role="alert">{error} <button type="button" className="text-button" onClick={() => { setError(""); setRetry(value => value + 1); }}>Retry</button></p>
    : !nested ? <p className="nested-evaluation-feedback" role="status">Evaluating {evaluation.group_name} coefficients in {selectedRegion?.name}…</p>
    : !pairs ? <p className="nested-evaluation-feedback" role="status">No comparable held-out observations are available in this ecoregion for {evaluation.index}. Choose another ecoregion.</p> : null);

  return <div className="comparison-panels">
    <ComparisonPanel evaluation={evaluation} selectedId={selectedId} source="CONUS" title="CONUS coefficients" />
    {evaluation.partition !== "conus" && <ComparisonPanel evaluation={nested ?? evaluation} selectedId={selectedId}
      source="regional" title={`${evaluation.group_name} coefficients`} pending={pending}
      subtitle={canExploreChildren && <>Coefficients fitted in {evaluation.group_name}{displayedPairs != null && <> · {displayedPairs.toLocaleString()} held-out pairs</>}</>}>
      {canExploreChildren && <div className="nested-evaluation-control">
        <label><span>Evaluate within</span>
          <select value={regionKey} disabled={!regions.length} onChange={event => { setResult(null); setError(""); setRegionKey(event.target.value); }}>
            <option value="">Entire {evaluation.group_name}</option>
            {(["ecoregion_l2", "ecoregion_l3"] as const).map(level => regions.some(region => region.partition === level) &&
              <optgroup key={level} label={level === "ecoregion_l2" ? "Level II ecoregions" : "Level III ecoregions"}>
                {regions.filter(region => region.partition === level).map(region => <option key={region.id} value={`${region.partition}:${region.id}`}>Level {level === "ecoregion_l2" ? "II" : "III"} · {region.name}</option>)}
              </optgroup>)}
          </select>
        </label>
        {regionsError && <p role="alert">{regionsError} <button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      </div>}
    </ComparisonPanel>}
  </div>;
}

interface Props {
  initial?: {
    partition?: Partition;
    groupId?: string;
    index?: IndexName;
    direction?: HarmonizationDirection;
    selectedId?: string;
  };
  onUse: (choice: HarmonizationChoice) => Promise<void>;
  onSelectionChange?: (choice: HarmonizationChoice | null) => void;
}

export function ExploreWorkflow({ initial, onUse, onSelectionChange }: Props) {
  const [partition, setPartition] = useState<Partition>(initial?.partition ?? "conus");
  const [regions, setRegions] = useState<RegionSummary[]>([]);
  const [groupId, setGroupId] = useState(initial?.groupId ?? (initial?.partition && initial.partition !== "conus" ? "" : "CONUS"));
  const [index, setIndex] = useState<IndexName>(initial?.index ?? "NDVI");
  const [direction, setDirection] = useState<HarmonizationDirection>(initial?.direction ?? "L7_to_L8");
  const [evaluation, setEvaluation] = useState<EvaluationResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string>(initial?.selectedId ?? "");
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [loadingEvaluation, setLoadingEvaluation] = useState(false);
  const [applying, setApplying] = useState(false);
  const [contextConfirmed, setContextConfirmed] = useState(Boolean(initial?.selectedId));
  const [error, setError] = useState<string | null>(null);
  const evaluationRequest = useRef(0);
  const contextSection = useRef<HTMLElement>(null);
  const comparisonSection = useRef<HTMLElement>(null);
  const diagnosticsSection = useRef<HTMLElement>(null);
  const workflowSections = useMemo(() => [contextSection, comparisonSection, diagnosticsSection], []);
  const { currentSection, goToSection } = useWorkflowNavigation(workflowSections);
  const [navigationMessage, setNavigationMessage] = useState("");

  useEffect(() => {
    let active = true;
    setLoadingRegions(true);
    api.regions(partition).then(({ regions: next }) => {
      if (!active) return;
      setRegions(next);
      setGroupId((current) => {
        const requested = partition === "conus" ? "CONUS" : current;
        return next.some((item) => item.id === requested) ? requested : "";
      });
    }).catch((reason: Error) => {
      if (active) setError(reason.message);
    }).finally(() => {
      if (active) setLoadingRegions(false);
    });
    return () => { active = false; };
  }, [partition]);

  useEffect(() => {
    if (!groupId) {
      ++evaluationRequest.current;
      setEvaluation(null); setLoadingEvaluation(false); setSelectedId("");
      return;
    }
    const controller = new AbortController();
    const requestId = ++evaluationRequest.current;
    setLoadingEvaluation(true);
    setError(null);
    api.evaluation(partition, groupId, index, direction, controller.signal)
      .then((result) => {
        if (requestId !== evaluationRequest.current) return;
        setEvaluation(result);
        const restoredId = partition === initial?.partition
          && groupId === initial.groupId
          && index === initial.index
          && direction === (initial.direction ?? "L7_to_L8")
          ? initial.selectedId ?? ""
          : "";
        setSelectedId((current) => {
          const candidate = current || restoredId;
          return result.alternatives.some((item) => item.id === candidate && item.available)
            ? candidate
            : "";
        });
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError" && requestId === evaluationRequest.current) {
          setError(reason.message);
        }
      })
      .finally(() => {
        if (requestId === evaluationRequest.current) setLoadingEvaluation(false);
      });
    return () => controller.abort();
  }, [partition, groupId, index, direction]);

  const evaluationIsCurrent = Boolean(
    evaluation
    && evaluation.partition === partition
    && evaluation.group_id === groupId
    && evaluation.index === index
    && evaluation.direction === direction,
  );
  const selected = evaluationIsCurrent
    ? evaluation?.alternatives.find((item) => item.id === selectedId) ?? null
    : null;
  const rawAlternative = evaluation?.alternatives.find((item) => item.id === "unharmonized");
  const royAlternative = evaluation?.alternatives.find((item) => item.id === ROY_2016_ID);
  const rawRmse = rawAlternative?.metrics?.rmse;
  const rawBias = rawAlternative?.metrics?.mean_difference;
  const choice = useMemo(() => selected && selected.method && evaluation && !loadingEvaluation ? {
    partition,
    groupId,
    groupName: evaluation.group_name,
    index,
    direction,
    alternative: selected,
  } satisfies HarmonizationChoice : null, [selected, evaluation, loadingEvaluation, partition, groupId, index, direction]);
  useEffect(() => {
    onSelectionChange?.(contextConfirmed ? choice : null);
  }, [choice, contextConfirmed, onSelectionChange]);
  const searchableRegions = useMemo(() => regions, [regions]);
  const tableGroups = evaluation ? [
    {
      id: "raw", title: "Unharmonized baseline", detail: "No coefficients applied",
      alternatives: evaluation.alternatives.filter((item) => item.source === "raw"),
    },
    {
      id: "conus", title: "CONUS coefficients",
      detail: `Fitted across all CONUS training samples; applied and evaluated on held-out observations ${evaluation.partition === "conus" ? "across CONUS" : `only within ${evaluation.group_name}`}.`,
      alternatives: evaluation.alternatives.filter((item) => item.source === "CONUS"),
    },
    ...(evaluation.partition === "conus" ? [] : [{
      id: "regional", title: `${evaluation.group_name} coefficients`,
      detail: `Fitted using training samples within ${evaluation.group_name}; applied and evaluated on held-out observations from the same region.`,
      alternatives: evaluation.alternatives.filter((item) => item.source === "regional"),
    }]),
  ] : [];
  const sourceName = direction === "L7_to_L8" ? "ETM+" : "OLI";
  const targetName = direction === "L7_to_L8" ? "OLI" : "ETM+";
  const comparisonLoading = loadingRegions || loadingEvaluation || Boolean(groupId && !evaluationIsCurrent);

  const changeContext = (change: () => void) => {
    onSelectionChange?.(null);
    setContextConfirmed(false); setSelectedId(""); setNavigationMessage("");
    change();
  };

  const apply = async () => {
    if (!choice) return;
    setApplying(true); setError(null);
    try { await onUse(choice); }
    catch (reason) { setError((reason as Error).message); }
    finally { setApplying(false); }
  };

  const confirmContext = () => {
    if (!evaluationIsCurrent || comparisonLoading) return;
    setContextConfirmed(true);
    window.requestAnimationFrame(() => goToSection(1));
  };

  const editContext = () => {
    onSelectionChange?.(null);
    setContextConfirmed(false);
    window.requestAnimationFrame(() => goToSection(0));
  };

  return <div className="explore-workflow">
    <nav className="workflow-progress" aria-label="Analysis workflow progress">
      <button type="button" data-step="one" className={`${contextConfirmed ? "summary" : "ready"} ${currentSection === 0 ? "active" : ""}`}
        aria-current={currentSection === 0 ? "step" : undefined} onClick={() => goToSection(0)}>
        <span>A</span><strong>Choose inputs</strong><small>{contextConfirmed ? "Confirmed · edit available" : "Reference sensor, region, index"}</small>
      </button>
      <button type="button" data-step="two" className={`${!contextConfirmed ? "locked" : choice ? "complete" : "ready"} ${currentSection === 1 ? "active" : ""}`}
        aria-current={currentSection === 1 ? "step" : undefined} aria-disabled={!contextConfirmed}
        onClick={() => { if (contextConfirmed) goToSection(1); else setNavigationMessage("Confirm your choices in A to compare approaches in B."); }}>
        <span>B</span><strong>Compare &amp; choose</strong><small>{!contextConfirmed ? "First confirm A" : choice ? "Approach selected" : "Select an approach"}</small>
      </button>
      <button type="button" data-step="three" className={`${contextConfirmed ? "ready" : "locked"} ${currentSection === 2 ? "active" : ""}`}
        aria-current={currentSection === 2 ? "step" : undefined} aria-disabled={!contextConfirmed}
        onClick={() => { if (contextConfirmed) goToSection(2); else setNavigationMessage("Confirm your choices in A to open the optional performance review in C."); }}>
        <span>C</span><strong>Review performance</strong><small>{contextConfirmed ? "Optional · index-range bias" : "Optional · first confirm A"}</small>
      </button>
    </nav>
    {navigationMessage && <div className="workflow-navigation-message" role="status">{navigationMessage}<button type="button" onClick={() => { setNavigationMessage(""); goToSection(0); }}>Go to choices</button></div>}

    <section ref={contextSection} tabIndex={-1} className={`workflow-step step-one ${contextConfirmed ? "context-summary-mode" : ""}`}
      title={contextConfirmed ? "Click 'Edit choices' in the top-right to modify these selections" : undefined}>
      <header className="step-header">
        <div className="step-number">A</div>
        <div><p className="eyebrow">Define harmonization details</p><h2>Choose a reference sensor, region, and index</h2>
          <p>Compare approaches using paired observations from your selected region. Evaluation uses held-out observations that were not used to fit the coefficients.</p></div>
        {contextConfirmed && <div className="context-step-actions">
          <button type="button" className="secondary-button edit-choices-button" onClick={editContext}>Edit choices</button>
        </div>}
      </header>

      <fieldset className="context-fields" disabled={contextConfirmed}>
        <section className="direction-stage" aria-labelledby="direction-heading">
          <div className="selection-prompt"><span>1</span><div><strong id="direction-heading">Choose the reference sensor</strong><p>Choose the sensor whose observations you want to retain as your reference. Harmonization adjusts the other sensor family; reference observations remain unchanged. Neither direction is universally preferable.</p></div></div>
          <div className="direction-picker" role="radiogroup" aria-label="Harmonization direction">
            {DIRECTIONS.map((item) => <button key={item.id} type="button" role="radio"
              aria-checked={direction === item.id} className={direction === item.id ? "active" : ""}
              onClick={() => changeContext(() => setDirection(item.id))}>
              <span className="direction-notation">{item.notation}</span>
              <span><strong>{item.label}</strong><small>{item.detail}</small></span>
            </button>)}
          </div>
        </section>

        <div className="selection-stage">
          <div className="selection-prompt"><span>2</span><div><strong>Choose a region type</strong><p>Start with a CONUS-wide comparison, or evaluate whether an ecological or watershed region better represents your area of interest.</p></div></div>
          <section className="region-picker" aria-label="Region type">
            {REGION_TYPES.map((item) => <button key={item.id} className={partition === item.id ? "active" : ""}
              aria-pressed={partition === item.id}
              onClick={() => changeContext(() => {
                setGroupId(item.id === "conus" ? "CONUS" : "");
                setPartition(item.id);
              })}>
              <strong>{item.label}</strong><span>{item.detail}</span>
            </button>)}
          </section>
        </div>

        <div className="guided-selection-grid">
          <section className="guided-field">
            <div className="selection-prompt"><span>3</span><div><strong>Choose the evaluation region</strong><p>{partition === "conus" ? "Evaluate approaches on held-out observations across CONUS." : "All approaches are evaluated on the same held-out observations within this region."}</p></div></div>
            {partition !== "conus" ? <label>Region
              <select className="region-search" value={groupId} disabled={loadingRegions}
                onChange={(event) => changeContext(() => setGroupId(event.target.value))} aria-label="Choose an evaluation region">
                <option value="">{loadingRegions ? "Loading regions…" : "Choose a region…"}</option>
                {searchableRegions.map((region) =>
                  <option key={region.id} value={region.id}>{region.name} · {region.sample_count.toLocaleString()} samples</option>)}
              </select>
            </label> : <div className="locked-selection"><span>Selected region</span><strong>Conterminous U.S. (CONUS)</strong></div>}
            {partition !== "conus" && <RegionGuide key={partition} partition={partition} groupId={groupId}
              groupName={regions.find((region) => region.id === groupId)?.name} />}
          </section>

          <section className="guided-field">
            <div className="selection-prompt"><span>4</span><div><strong>Choose the vegetation index</strong><p>Choose the vegetation index used in your evaluation.</p></div></div>
            <div className="index-picker" aria-label="Vegetation index">
              {([
                ["NDVI", "Normalized difference vegetation index"], ["EVI", "Enhanced vegetation index"], ["MSAVI", "Modified soil-adjusted vegetation index"],
              ] as Array<[IndexName, string]>).map(([name, detail]) => <button key={name}
                className={index === name ? "active" : ""} aria-pressed={index === name}
                onClick={() => changeContext(() => setIndex(name))}><strong>{name}</strong><span>{detail}</span></button>)}
            </div>
          </section>
        </div>
      </fieldset>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {(loadingRegions || (loadingEvaluation && !evaluation)) && <div className="loading-panel compact" role="status">Loading the held-out comparison…</div>}
      {!contextConfirmed && <div className="context-confirmation">
        <div><strong>Next: Compare harmonization approaches</strong><span>Review bias and error for your selected reference sensor, region, and vegetation index, then choose an approach in Panel B.</span></div>
        <button type="button" className="primary-button" onClick={confirmContext}
          disabled={!evaluationIsCurrent || comparisonLoading || !groupId}>
          {comparisonLoading ? "Loading comparison…" : !groupId ? "Choose a region to continue" : "Compare approaches →"}
        </button>
      </div>}
    </section>

    {evaluation && <>
      <section ref={comparisonSection} tabIndex={-1} className={`workflow-step step-two ${contextConfirmed ? "" : "is-locked"}`}
        aria-busy={comparisonLoading} aria-disabled={!contextConfirmed} inert={!contextConfirmed}>
        <header className="step-header">
          <div className="step-number">B</div>
          <div><p className="eyebrow">Select an approach</p><h2>Compare harmonization approaches</h2>
            <p>Evaluate the harmonization approaches below by comparing their bias and error on held-out observations. Select an approach for further analysis, then continue to Map & Analyze to explore its effects on vegetation trends and time series.</p></div>
        </header>

        <div className="method-decision-guide">
          <p><strong>Band-level</strong> approaches adjust surface reflectance before calculating the index. <strong>Index-level</strong> approaches adjust the chosen index directly.</p>
          <p><strong>Linear or third-order polynomial?</strong> Compare held-out error and bias for your application. A more flexible polynomial does not guarantee better performance across the index range.</p>
        </div>
        <div className="comparison-content">
          {comparisonLoading && <div className="comparison-updating" role="status"><span className="loading-spinner" />Updating this comparison…</div>}
          <div className="baseline-benchmark">
            <div><span>Unharmonized baseline</span><strong>{sourceName} observations compared with {targetName}</strong><small>{rawAlternative?.metrics?.n.toLocaleString() ?? "—"} held-out pairs in {evaluation.group_name}</small></div>
            <dl><div><dt>RMSE</dt><dd>{format(rawRmse)}</dd></div><div><dt>Mean bias</dt><dd>{format(rawBias)}</dd></div></dl>
            <p className="metric-definition">Improvements indicated in the table(s) below are relative to the unharmonized baseline provided here: positive values indicate lower RMSE or lower absolute bias; negative values indicate an increase. Roy et al. (2016) is a published benchmark for comparison.</p>
          </div>

          <div className="strategy-scope-grid" role="radiogroup" aria-label="Harmonization approaches">
            {tableGroups.filter((group) => group.id !== "raw").map((group) => {
              const alternatives = [...(royAlternative ? [royAlternative] : []), ...group.alternatives];
              return <section className="strategy-scope" key={group.id}>
              <header><div><span>{group.id === "conus" ? "CONUS fit" : "Regional fit"}</span><h3>{group.title}</h3><p>{group.detail}</p></div></header>
              <div className="method-choice-table-wrap"><table className="method-choice-table" role="table" aria-label={`${group.title} harmonization approaches`}>
                <thead><tr><th>Approach</th><th>RMSE</th><th>Mean bias</th><th>RMSE improvement</th><th>Bias improvement</th><th>Choice</th></tr></thead>
                <tbody>{alternatives.map((alternative) => {
                  const rmseImprovement = rawRmse && alternative.metrics
                    ? 100 * (rawRmse - alternative.metrics.rmse) / rawRmse
                    : null;
                  const biasImprovement = percentBiasImprovement(rawBias, alternative.metrics?.mean_difference);
                  const isPublished = alternative.id === ROY_2016_ID;
                  const method = isPublished
                    ? { title: "Roy et al. (2016)", fit: "Band-level · published OLS" }
                    : METHOD_DETAILS[alternative.method ?? "unharmonized"];
                  const isSelected = selectedId === alternative.id;
                  return <tr key={alternative.id}
                    className={`${isSelected ? "selected" : ""} ${!alternative.available ? "unavailable" : ""} ${isPublished ? "published-reference" : ""}`}
                    onClick={() => { if (!isPublished && alternative.available && !comparisonLoading) setSelectedId(alternative.id); }}>
                    <td className="method-choice-title"><div><strong>{method.title}</strong><small>{method.fit}</small></div></td>
                    <td data-label="RMSE">{format(alternative.metrics?.rmse)}</td>
                    <td data-label="Mean bias">{format(alternative.metrics?.mean_difference)}</td>
                    <td data-label="RMSE improvement" className="metric-improvement">{signedPercent(rmseImprovement)}</td>
                    <td data-label="Bias improvement" className="metric-improvement">{signedPercent(biasImprovement)}</td>
                    <td className="method-selection-cell">{isPublished ? <span className="published-reference-label">Published reference</span> : <label className="method-choice-action">
                      <input type="radio" name="harmonization-approach" value={alternative.id}
                        checked={isSelected} disabled={!alternative.available || comparisonLoading || !contextConfirmed}
                        aria-label={`${group.title}: ${method.title}, ${method.fit}`}
                        onChange={() => setSelectedId(alternative.id)} />
                      <span>{!alternative.available ? "Unavailable" : isSelected ? "Selected" : "Select this approach"}</span>
                    </label>}</td>
                  </tr>;
                })}</tbody>
              </table></div>
            </section>})}
          </div>

          <section className={`choice-summary ${choice ? "ready" : ""} ${contextConfirmed ? "" : "is-locked"}`}
        aria-disabled={!contextConfirmed} inert={!contextConfirmed}>
        {choice ? <>
          <div><p className="eyebrow">Selected approach</p><h2>{coefficientScopeLabel(choice.alternative.source)} · {METHOD_LABELS[choice.alternative.method!]}</h2>
            <p>Evaluated in {choice.groupName} · {choice.index} · {sourceName}→{targetName} · RMSE {format(choice.alternative.metrics?.rmse)} · mean bias {format(choice.alternative.metrics?.mean_difference)}</p></div>
          <button className="primary-button continue-button" onClick={() => void apply()} disabled={applying || !contextConfirmed}>{applying ? "Opening the map…" : "Continue to Map & Analyze →"}</button>
          <SelectedCoefficients choice={choice} compact />
        </> : <><div><p className="eyebrow">Choose an approach to continue</p><h2>Select one approach in the tables above</h2><p>The map will use your selected reference sensor, index, and coefficient set.</p></div><span className="choice-arrow" aria-hidden="true">↑</span></>}
      </section>

          <details className="evidence-details">
            <summary>View equations and all evaluation metrics</summary>
            <p>Band-level approaches adjust reflectance before calculating the index. Index-level approaches adjust the index directly. Equations are shown for the selected reference sensor.</p>
            <div className="table-scroll"><table className="coefficient-table">
              <thead><tr><th>Approach</th><th>Equation(s)</th><th>RMSE</th><th>Mean bias</th><th>RMSE improvement</th><th>Bias improvement</th></tr></thead>
              <tbody>{[...tableGroups, ...(royAlternative ? [{
                id: "published", title: "Published reference", detail: "Band-level OLS coefficients from Roy et al. (2016)", alternatives: [royAlternative],
              }] : [])].map((group) => <Fragment key={group.id}>
                <tr className={`coefficient-group-heading group-${group.id}`}><th colSpan={6}>
                  <strong>{group.title}</strong><span>{group.detail}</span>
                </th></tr>
                {group.alternatives.map((alternative) => {
                  const rmseImprovement = rawRmse && alternative.metrics ? 100 * (rawRmse - alternative.metrics.rmse) / rawRmse : null;
                  const biasImprovement = percentBiasImprovement(rawBias, alternative.metrics?.mean_difference);
                  return <tr key={alternative.id} className={selectedId === alternative.id ? "selected-evidence" : ""}>
                    <td>{alternative.id === ROY_2016_ID ? "Roy et al. (2016) · Band-level OLS" : alternative.method ? METHOD_LABELS[alternative.method] : "No harmonization"}{!alternative.available && <small>Unavailable</small>}</td>
                    <td className="equations">{alternative.models ? Object.entries(alternative.models).map(([metric, model]) =>
                      <div key={metric}>{equation(metric, model.coefficients, evaluation.direction)}</div>) : "—"}</td>
                    <td data-label="RMSE">{format(alternative.metrics?.rmse)}</td>
                    <td data-label="Mean bias">{format(alternative.metrics?.mean_difference)}</td>
                    <td data-label="RMSE improvement" className="metric-improvement">{signedPercent(rmseImprovement)}</td>
                    <td data-label="Bias improvement" className="metric-improvement">{signedPercent(biasImprovement)}</td>
                  </tr>;
                })}
              </Fragment>)}</tbody>
            </table></div>
          </details>

        </div>
      </section>

      <section ref={diagnosticsSection} tabIndex={-1} className={`workflow-step step-three ${contextConfirmed ? "" : "is-locked"}`}
        aria-busy={loadingEvaluation} aria-disabled={!contextConfirmed} inert={!contextConfirmed}>
        <header className="step-header">
          <div className="step-number">C</div>
          <div><p className="eyebrow">Optional review</p><h2>Review performance across the index range</h2>
            <p>Check whether an approach reduces bias across low and high index values. An average metric can hide differences within the range.</p></div>
        </header>
        <p className="metric-definition">Mean bias is the adjusted {sourceName} value minus the observed {targetName} value; the baseline uses unharmonized values. Observations are grouped by their unharmonized {sourceName} index.</p>
        <ComparisonCharts key={`${evaluation.partition}:${evaluation.group_id}:${evaluation.index}:${evaluation.direction}`} evaluation={evaluation} selectedId={selectedId} />
      </section>


    </>}
  </div>;
}
