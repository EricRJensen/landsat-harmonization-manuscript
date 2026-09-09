import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { api } from "../api";
import type {
  EvaluationAlternative,
  EvaluationResponse,
  HarmonizationChoice,
  HarmonizationDirection,
  IndexName,
  Partition,
  RegionSummary,
} from "../types";

const REGION_TYPES: Array<{ id: Partition; label: string; detail: string }> = [
  { id: "conus", label: "CONUS", detail: "One model fitted across all contiguous U.S. samples" },
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
    detail: "Transform Landsat 5/7; leave Landsat 8/9 unchanged.",
  },
  {
    id: "L8_to_L7",
    label: "Use ETM+ as reference",
    notation: "L8 → L7",
    detail: "Transform Landsat 8/9; leave Landsat 5/7 unchanged.",
  },
];

const METHOD_DETAILS: Record<string, { title: string; fit: string }> = {
  band_linear: { title: "Band-level", fit: "Linear fit" },
  band_cubic: { title: "Band-level", fit: "Third-order polynomial (P3)" },
  index_linear: { title: "Index-level", fit: "Linear fit" },
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
  unharmonized: "#d95f02",
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
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    chart.setOption(option);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [option]);
  return <div ref={element} className="metric-chart" role="img" aria-label={ariaLabel} />;
}

function ComparisonCharts({ evaluation }: { evaluation: EvaluationResponse }) {
  const panels = evaluation.partition === "conus" ? ["CONUS"] : ["CONUS", "regional"];
  const raw = evaluation.alternatives.find((item) => item.id === "unharmonized");
  const roy = evaluation.alternatives.find((item) => item.id === ROY_2016_ID && item.available);
  const sourceLabel = evaluation.source_sensor === "L7" ? "ETM+" : "OLI";
  return <div className="comparison-panels">
    {panels.map((source) => {
      const models = evaluation.alternatives.filter((item) => item.source === source && item.available);
      const alternatives = [...(raw ? [raw] : []), ...(roy ? [roy] : []), ...models];
      const categoryLabels = alternatives.map(alternativeLabel);
      const barData = (metric: "rmse" | "mean_difference") => alternatives.map((item) => ({
        value: item.metrics?.[metric],
        itemStyle: { color: alternativeColor(item) },
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
        legend: { top: 0, type: "scroll" },
        grid: { left: 56, right: 12, top: 48, bottom: 78 },
        xAxis: { type: "category", data: binLabels, name: `Unharmonized ${sourceLabel} ${evaluation.index} bin`, axisLabel: { rotate: 45 } },
        yAxis: { type: "value", name: "Mean bias", scale: true },
        series: alternatives.map((item) => ({
          name: alternativeLabel(item),
          type: "line", symbolSize: 5, connectNulls: false,
          color: alternativeColor(item),
          data: item.metrics?.bins.map((bin) => bin.mean_difference) ?? [],
        })),
      };
      return <section className="comparison-panel" key={source}>
        <h3>{source === "CONUS" ? "CONUS coefficients" : `${evaluation.group_name} coefficients`}</h3>
        <div className="metric-chart-grid">
          <div><h4>Held-out RMSE</h4><MiniChart option={rmseOption} ariaLabel={`${source} RMSE comparison`} /></div>
          <div><h4>Held-out mean bias</h4><MiniChart option={biasOption} ariaLabel={`${source} mean bias comparison`} /></div>
          <div><h4>Mean bias by source-index bin</h4><MiniChart option={binOption} ariaLabel={`${source} binned mean bias`} /></div>
        </div>
      </section>;
    })}
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
}

export function ExploreWorkflow({ initial, onUse }: Props) {
  const [partition, setPartition] = useState<Partition>(initial?.partition ?? "conus");
  const [regions, setRegions] = useState<RegionSummary[]>([]);
  const [groupId, setGroupId] = useState(initial?.groupId ?? "CONUS");
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

  useEffect(() => {
    let active = true;
    setLoadingRegions(true);
    api.regions(partition).then(({ regions: next }) => {
      if (!active) return;
      setRegions(next);
      setGroupId((current) => {
        const requested = partition === "conus" ? "CONUS" : current;
        return next.some((item) => item.id === requested) ? requested : (next[0]?.id ?? "");
      });
    }).catch((reason: Error) => {
      if (active) setError(reason.message);
    }).finally(() => {
      if (active) setLoadingRegions(false);
    });
    return () => { active = false; };
  }, [partition]);

  useEffect(() => {
    if (!groupId) return;
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
  const choice = selected && selected.method && evaluation ? {
    partition,
    groupId,
    groupName: evaluation.group_name,
    index,
    direction,
    alternative: selected,
  } satisfies HarmonizationChoice : null;
  const searchableRegions = useMemo(() => regions, [regions]);
  const tableGroups = evaluation ? [
    {
      id: "raw", title: "Unharmonized baseline", detail: "No coefficients applied",
      alternatives: evaluation.alternatives.filter((item) => item.source === "raw"),
    },
    {
      id: "conus", title: "CONUS coefficients", detail: "Fitted across all CONUS training samples",
      alternatives: evaluation.alternatives.filter((item) => item.source === "CONUS"),
    },
    ...(evaluation.partition === "conus" ? [] : [{
      id: "regional", title: `${evaluation.group_name} coefficients`, detail: "Fitted only within the selected region",
      alternatives: evaluation.alternatives.filter((item) => item.source === "regional"),
    }]),
  ] : [];
  const sourceName = direction === "L7_to_L8" ? "ETM+" : "OLI";
  const targetName = direction === "L7_to_L8" ? "OLI" : "ETM+";
  const comparisonLoading = loadingRegions || loadingEvaluation || !evaluationIsCurrent;

  const changeContext = (change: () => void) => {
    setSelectedId("");
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
    window.requestAnimationFrame(() => comparisonSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const editContext = () => {
    setContextConfirmed(false);
    window.requestAnimationFrame(() => contextSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return <div className="explore-workflow">
    <nav className="workflow-progress" aria-label="Analysis workflow progress">
      <button type="button" className={contextConfirmed ? "summary" : "active"}
        aria-current={!contextConfirmed ? "step" : undefined}
        onClick={() => contextSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
        <span>A</span><strong>Define context</strong><small>Direction, region, index</small>
      </button>
      <button type="button" className={!contextConfirmed ? "locked" : choice ? "complete" : "active"}
        aria-current={contextConfirmed && !choice ? "step" : undefined}
        onClick={() => comparisonSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
        <span>B</span><strong>Compare &amp; choose</strong><small>Select one validated approach</small>
      </button>
      <button type="button" className={contextConfirmed ? "ready" : "locked"}
        aria-current={contextConfirmed && Boolean(choice) ? "step" : undefined}
        onClick={() => diagnosticsSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
        <span>C</span><strong>Inspect performance</strong><small>Bias and error diagnostics</small>
      </button>
    </nav>

    <section ref={contextSection} className={`workflow-step step-one ${contextConfirmed ? "context-summary-mode" : ""}`}>
      <header className="step-header">
        <div className="step-number">A</div>
        <div><p className="eyebrow">Define the application context</p><h2>Choose a reference scale, region, and index</h2>
          <p>Each choice updates every approach against the same held-out paired observations, so the comparison remains fair and application-specific.</p></div>
        {contextConfirmed ? <div className="context-step-actions">
          <span className="step-status">Choices confirmed</span>
          <button type="button" className="secondary-button edit-choices-button" onClick={editContext}>Edit choices</button>
        </div> : evaluationIsCurrent && !loadingEvaluation && <span className="step-status">Context ready</span>}
      </header>

      <fieldset className="context-fields" disabled={contextConfirmed}>
        <section className="direction-stage" aria-labelledby="direction-heading">
          <div className="selection-prompt"><span>1</span><div><strong id="direction-heading">Which sensor scale should the merged record use?</strong><p>Direction determines which sensor family is transformed and which remains the reference.</p></div></div>
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
          <div className="selection-prompt"><span>2</span><div><strong>Choose a geographic framework</strong><p>Compare CONUS coefficients with models fitted within an ecological or watershed region.</p></div></div>
          <section className="region-picker" aria-label="Region hierarchy">
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
            <div className="selection-prompt"><span>3</span><div><strong>Choose the evaluation region</strong><p>{partition === "conus" ? "CONUS uses every eligible paired ETM+/OLI sample." : "All approaches use the same held-out pairs from this region."}</p></div></div>
            {partition !== "conus" ? <label>Named region
              <select className="region-search" value={groupId} disabled={loadingRegions || !groupId}
                onChange={(event) => changeContext(() => setGroupId(event.target.value))} aria-label="Search or choose a region">
                {searchableRegions.map((region) =>
                  <option key={region.id} value={region.id}>{region.name} · {region.sample_count.toLocaleString()} samples</option>)}
              </select>
            </label> : <div className="locked-selection"><span>Selected region</span><strong>All CONUS pixels</strong></div>}
          </section>

          <section className="guided-field">
            <div className="selection-prompt"><span>4</span><div><strong>Choose the vegetation index</strong><p>Residual bias and the best correction can vary by index and across its value range.</p></div></div>
            <div className="index-picker" aria-label="Vegetation index">
              {([
                ["NDVI", "Greenness · saturates at high values"], ["EVI", "Greenness · resists saturation"], ["MSAVI", "Greenness · reduces soil influence"],
              ] as Array<[IndexName, string]>).map(([name, detail]) => <button key={name}
                className={index === name ? "active" : ""} aria-pressed={index === name}
                onClick={() => changeContext(() => setIndex(name))}><strong>{name}</strong><span>{detail}</span></button>)}
            </div>
          </section>
        </div>
      </fieldset>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {(loadingRegions || (loadingEvaluation && !evaluation)) && <div className="loading-panel compact" role="status">Preparing the held-out comparison…</div>}
      {!contextConfirmed && <div className="context-confirmation">
        <div><strong>Ready to compare approaches?</strong><span>Confirm these choices to unlock the coefficient comparison and diagnostic plots.</span></div>
        <button type="button" className="primary-button" onClick={confirmContext}
          disabled={!evaluationIsCurrent || comparisonLoading || !groupId}>
          {comparisonLoading ? "Preparing comparison…" : "Confirm choices"}
        </button>
      </div>}
    </section>

    {evaluation && <>
      <section ref={comparisonSection} className={`workflow-step step-two ${contextConfirmed ? "" : "is-locked"}`}
        aria-busy={comparisonLoading} aria-disabled={!contextConfirmed} inert={!contextConfirmed}>
        <header className="step-header">
          <div className="step-number">B</div>
          <div><p className="eyebrow">Select one validated approach</p><h2>Compare harmonization strategies</h2>
            <p>Choose directly from the method tables. Lower RMSE means less total paired-sample error; mean bias closest to zero means less systematic sensor offset.</p></div>
          {choice ? <span className="step-status">Method selected</span> : <span className="step-status action-status">Selection needed</span>}
        </header>

        <div className="comparison-content">
          {comparisonLoading && <div className="comparison-updating" role="status"><span className="loading-spinner" />Updating this comparison…</div>}
          <div className="baseline-benchmark">
            <div><span>Unharmonized benchmark</span><strong>{sourceName} observations compared with {targetName}</strong><small>{rawAlternative?.metrics?.n.toLocaleString() ?? "—"} held-out pairs in {evaluation.group_name}</small></div>
            <dl><div><dt>RMSE</dt><dd>{format(rawRmse)}</dd></div><div><dt>Mean bias</dt><dd>{format(rawBias)}</dd></div></dl>
          </div>

          <div className="strategy-scope-grid" role="radiogroup" aria-label="Harmonization approaches">
            {tableGroups.filter((group) => group.id !== "raw").map((group) => {
              const alternatives = [...(royAlternative ? [royAlternative] : []), ...group.alternatives];
              return <section className="strategy-scope" key={group.id}>
              <header><div><span>{group.id === "conus" ? "Broad model" : "Local model"}</span><h3>{group.title}</h3><p>{group.detail}</p></div></header>
              <div className="method-choice-table-wrap"><table className="method-choice-table" aria-label={`${group.title} harmonization approaches`}>
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
                    <td>{format(alternative.metrics?.rmse)}</td>
                    <td>{format(alternative.metrics?.mean_difference)}</td>
                    <td className="metric-improvement">{signedPercent(rmseImprovement)}</td>
                    <td className="metric-improvement">{signedPercent(biasImprovement)}</td>
                    <td>{isPublished ? <span className="published-reference-label">Published reference</span> : <label className="method-choice-action">
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

          <details className="evidence-details">
            <summary>Inspect equations and the complete metrics table</summary>
            <p>These details support reproducibility; method selection is made with the comparison tables above.</p>
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
                    <td>{format(alternative.metrics?.rmse)}</td>
                    <td>{format(alternative.metrics?.mean_difference)}</td>
                    <td className="metric-improvement">{signedPercent(rmseImprovement)}</td>
                    <td className="metric-improvement">{signedPercent(biasImprovement)}</td>
                  </tr>;
                })}
              </Fragment>)}</tbody>
            </table></div>
          </details>

        </div>
      </section>

      <section ref={diagnosticsSection} className={`workflow-step step-three ${contextConfirmed ? "" : "is-locked"}`}
        aria-busy={loadingEvaluation} aria-disabled={!contextConfirmed} inert={!contextConfirmed}>
        <header className="step-header">
          <div className="step-number">C</div>
          <div><p className="eyebrow">Optional deeper review</p><h2>Inspect performance across the index range</h2>
            <p>Use these plots to identify tail behavior and tradeoffs that a single average metric can hide. You can return to the method tables at any time.</p></div>
        </header>
        <p className="metric-definition">Mean bias is transformed {sourceName} minus observed {targetName}; bins use the unharmonized {sourceName} index. Bias improvement measures reduction in absolute systematic bias relative to the unharmonized baseline.</p>
        <ComparisonCharts evaluation={evaluation} />
      </section>

      <section className={`choice-summary ${choice ? "ready" : ""} ${contextConfirmed ? "" : "is-locked"}`}
        aria-live="polite" aria-disabled={!contextConfirmed} inert={!contextConfirmed}>
        {choice ? <>
          <div><p className="eyebrow">Ready for Earth Engine analysis</p><h2>{coefficientScopeLabel(choice.alternative.source)} · {METHOD_LABELS[choice.alternative.method!]}</h2>
            <p>{choice.groupName} · {choice.index} · {sourceName}→{targetName} · RMSE {format(choice.alternative.metrics?.rmse)} · mean bias {format(choice.alternative.metrics?.mean_difference)}</p></div>
          <button className="primary-button continue-button" onClick={() => void apply()} disabled={applying || !contextConfirmed}>{applying ? "Choosing a regional map point…" : "Continue to maps & time series →"}</button>
        </> : <><div><p className="eyebrow">Next action</p><h2>Select one approach in the tables above</h2><p>Your selection carries the exact direction, coefficient scope, method, region, and index into Tab 2.</p></div><span className="choice-arrow" aria-hidden="true">↑</span></>}
      </section>
    </>}
  </div>;
}
