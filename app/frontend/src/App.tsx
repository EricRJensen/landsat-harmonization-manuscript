import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { AboutStudyModal } from "./components/AboutStudyModal";
import { PolygonTrendCharts, TimeseriesCharts } from "./components/Charts";
import { ExploreWorkflow } from "./components/ExploreWorkflow";
import { LocationSearch } from "./components/LocationSearch";
import { TrendControls } from "./components/TrendControls";
import { TrendMap } from "./components/TrendMap";
import type {
  AnalysisConfig,
  BasemapMode,
  HarmonizationChoice,
  HarmonizationDirection,
  IndexName,
  LocationSearchResult,
  MapBounds,
  MapTiles,
  Method,
  Partition,
  PolygonAnalysisResponse,
} from "./types";

const defaults: AnalysisConfig = {
  partition: "conus", method: "band_linear", index: "NDVI",
  direction: "L7_to_L8",
  start_year: 1985, end_year: 2025, significant_only: false,
};

function initialUrlState() {
  const params = new URLSearchParams(window.location.search);
  const direction = params.get("direction");
  return {
    tab: params.get("tab") === "map" ? "map" as const : "explore" as const,
    partition: (params.get("region") as Partition | null) ?? "conus",
    groupId: params.get("group") ?? "CONUS",
    index: (params.get("index") as IndexName | null) ?? "NDVI",
    direction: (direction === "L8_to_L7" ? direction : "L7_to_L8") as HarmonizationDirection,
    method: params.get("method") as Method | null,
    coefficientPartition: params.get("coefficients") as Partition | null,
    longitude: Number(params.get("lon")),
    latitude: Number(params.get("lat")),
  };
}

function methodLabel(method: Method | null) {
  if (!method) return "";
  const [family, degree] = method.split("_");
  return `${family === "band" ? "Band-level" : "Index-level"} · ${degree === "linear" ? "linear" : "third-order polynomial (P3)"}`;
}

function coefficientScopeLabel(source: HarmonizationChoice["alternative"]["source"]) {
  if (source === "CONUS") return "CONUS coefficients";
  if (source === "regional") return "Regional coefficients";
  return "Unharmonized baseline";
}

interface ChoiceReportProps {
  choice: HarmonizationChoice;
  children: ReactNode;
  onChangeApproach: () => void;
  onBuildTrendMap: () => void;
  onEditChoices: () => void;
  onRandomLocation: () => void;
  onLocationSelect: (result: LocationSearchResult) => void;
  locationWarning: string | null;
  randomizing: boolean;
  buildingMap: boolean;
  hasMap: boolean;
  setupConfirmed: boolean;
}

function ChoiceReport({
  choice, children, onChangeApproach, onBuildTrendMap, onEditChoices, onRandomLocation, onLocationSelect,
  locationWarning, randomizing, buildingMap, hasMap, setupConfirmed,
}: ChoiceReportProps) {
  const models = choice.alternative.models ?? {};
  const forward = choice.direction === "L7_to_L8";
  const source = forward ? "ETM+" : "OLI";
  const target = forward ? "OLI" : "ETM+";
  return <section className={`workflow-step step-one map-choice-report ${setupConfirmed ? "context-summary-mode" : ""}`}>
    <header className="step-header map-setup-header">
      <div className="step-number">A</div>
      <div><p className="eyebrow">Configure the sensitivity analysis</p><h2>Place the map and set the trend period</h2>
        <p>Review the selected {source}→{target}-equivalent transformation, choose a location, and define the April–September trend period.</p></div>
      <div className="map-step-actions"><span className="step-status">{coefficientScopeLabel(choice.alternative.source)}</span>
        {setupConfirmed && <button className="secondary-button edit-choices-button" type="button" onClick={onEditChoices}>Edit choices</button>}
        <button className="text-button change-approach-button" onClick={onChangeApproach}>← Change approach</button></div>
    </header>
    <div className="coefficient-facts" aria-label="Chosen coefficient summary">
      <div><span>Method</span><strong>{methodLabel(choice.alternative.method)}</strong></div>
      <div><span>Direction</span><strong>{source} → {target}</strong></div>
      <div><span>Evaluation region</span><strong>{choice.groupName}</strong></div>
      <div><span>Index</span><strong>{choice.index}</strong></div>
      <div><span>Held-out RMSE</span><strong>{choice.alternative.metrics?.rmse.toFixed(4)}</strong></div>
      <div><span>Mean bias</span><strong>{choice.alternative.metrics?.mean_difference.toFixed(4)}</strong></div>
    </div>
    <div className="coefficient-detail-row">
      <p>{forward
        ? "The selected coefficients transform Landsat 5 TM and Landsat 7 ETM+ observations; Landsat 8/9 remain on the OLI reference scale."
        : "The selected coefficients transform Landsat 8/9 OLI observations; Landsat 5/7 remain on the ETM+ reference scale."} They are applied uniformly to every visible pixel{choice.partition === "conus" ? "." : `, including locations outside ${choice.groupName}.`}</p>
      <details><summary>View chosen equation{Object.keys(models).length === 1 ? "" : "s"}</summary><div className="chosen-equations">
      {Object.entries(models).map(([metric, model]) => <div key={metric}><strong>{metric}</strong>
        <code>{target} = {model.coefficients.map((value, power) => `${power ? (value < 0 ? " − " : " + ") : (value < 0 ? "−" : "")}${Math.abs(value).toPrecision(5)}${power ? `·${source}${power > 1 ? `^${power}` : ""}` : ""}`).join("")}</code>
      </div>)}
      </div></details>
    </div>
    <fieldset className="map-setup-fields" disabled={setupConfirmed}>
      <div className="map-setup-grid">
        <section className="map-setup-panel location-setup-panel">
          <header className="map-setup-panel-heading">
            <span className="location-icon" aria-hidden="true">⌖</span>
            <div><strong>Choose the map location</strong><p>The initial view is a random valid point in {choice.groupName}. Search anywhere in CONUS or choose another regional point.</p></div>
          </header>
          <div className="location-setup-controls">
            <LocationSearch partition={choice.partition} groupId={choice.groupId} onSelect={onLocationSelect} />
            <div className="location-picker-random"><span>or</span>
              <button className="secondary-button" type="button" onClick={onRandomLocation} disabled={randomizing}>
                {randomizing ? "Finding a point…" : "Surprise me"}
              </button>
            </div>
          </div>
        </section>
        <section className="map-setup-panel analysis-setup-panel">
          <header className="map-setup-panel-heading">
            <span className="analysis-period-icon" aria-hidden="true">▥</span>
            <div><strong>Choose the analysis period</strong><p>Build trends from annual April–September growing-season median composites.</p></div>
          </header>
          {children}
        </section>
      </div>
      {locationWarning && <div className="location-region-warning" role="alert"><strong>Outside the selected region</strong><span>{locationWarning}</span></div>}
      <div className="map-build-action">
        <div><strong>Build the trend layers</strong><span>Apply the selected coefficients using this location and analysis period.</span></div>
        <button className="primary-button" type="button" onClick={onBuildTrendMap} disabled={buildingMap}>
          {buildingMap ? <><span className="button-spinner" aria-hidden="true" />Building Earth Engine layers…</> : hasMap ? "Rebuild trend map" : "Build trend map"}
        </button>
      </div>
    </fieldset>
  </section>;
}

export default function App() {
  const initial = useRef(initialUrlState()).current;
  const appHeader = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<"explore" | "map">(initial.tab);
  const [aboutOpen, setAboutOpen] = useState(false);
  const openAbout = useCallback(() => setAboutOpen(true), []);
  const closeAbout = useCallback(() => setAboutOpen(false), []);
  const [basemap, setBasemap] = useState<BasemapMode>("satellite");
  const [choice, setChoice] = useState<HarmonizationChoice | null>(null);
  const [restoringChoice, setRestoringChoice] = useState(Boolean(initial.method && initial.coefficientPartition));
  const [mapView, setMapView] = useState<{ longitude: number; latitude: number; zoom: number } | undefined>(
    Number.isFinite(initial.longitude) && Number.isFinite(initial.latitude)
      ? { longitude: initial.longitude, latitude: initial.latitude, zoom: 10 } : undefined,
  );
  const [draft, setDraft] = useState(defaults);
  const [active, setActive] = useState(defaults);
  const [tiles, setTiles] = useState<MapTiles | null>(null);
  const [polygonAnalysis, setPolygonAnalysis] = useState<PolygonAnalysisResponse | null>(null);
  const [figureView, setFigureView] = useState<"annual" | "distribution">("annual");
  const [loadingMap, setLoadingMap] = useState(false);
  const [loadingPolygon, setLoadingPolygon] = useState(false);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [mapSetupConfirmed, setMapSetupConfirmed] = useState(false);
  const [locationWarning, setLocationWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapBounds, setMapBounds] = useState<MapBounds>({ west: -125, south: 24, east: -66, north: 50 });
  const mapAbort = useRef<AbortController | null>(null);
  const polygonAbort = useRef<AbortController | null>(null);
  const mapSetupStep = useRef<HTMLDivElement>(null);
  const trendMapStep = useRef<HTMLDivElement>(null);
  const analysisStep = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const header = appHeader.current;
    if (!header) return;
    const updateHeaderHeight = () => {
      document.documentElement.style.setProperty("--app-header-height", `${header.offsetHeight}px`);
    };
    updateHeaderHeight();
    const observer = new ResizeObserver(updateHeaderHeight);
    observer.observe(header);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--app-header-height");
    };
  }, []);

  useEffect(() => () => { mapAbort.current?.abort(); polygonAbort.current?.abort(); }, []);

  useEffect(() => {
    if (!initial.method || !initial.coefficientPartition) {
      setRestoringChoice(false);
      return;
    }
    api.evaluation(initial.partition, initial.groupId, initial.index, initial.direction).then((evaluation) => {
      const id = `${initial.coefficientPartition}_${initial.method}`;
      const alternative = evaluation.alternatives.find((item) => item.id === id && item.available);
      if (!alternative) return;
      const restored: HarmonizationChoice = {
        partition: initial.partition, groupId: initial.groupId, groupName: evaluation.group_name,
        index: initial.index, direction: initial.direction, alternative,
      };
      setChoice(restored);
      const restoredConfig = {
        ...defaults,
        partition: initial.partition,
        method: initial.method!,
        index: initial.index,
        direction: initial.direction,
        coefficient_partition: initial.coefficientPartition!,
        coefficient_group_id: alternative.coefficient_group_id,
      };
      setDraft(restoredConfig); setActive(restoredConfig);
    }).catch((reason: Error) => setError(reason.message)).finally(() => setRestoringChoice(false));
  }, []);

  const useChoice = async (nextChoice: HarmonizationChoice) => {
    const point = await api.randomPoint(nextChoice.partition, nextChoice.groupId);
    const nextConfig: AnalysisConfig = {
      ...defaults,
      partition: nextChoice.partition,
      method: nextChoice.alternative.method!,
      index: nextChoice.index,
      direction: nextChoice.direction,
      coefficient_partition: nextChoice.alternative.coefficient_partition,
      coefficient_group_id: nextChoice.alternative.coefficient_group_id,
    };
    setChoice(nextChoice); setDraft(nextConfig); setActive(nextConfig);
    setMapSetupConfirmed(false);
    setTiles(null); setPolygonAnalysis(null); setLocationWarning(null); setError(null);
    setMapView({ ...point.point, zoom: point.zoom }); setTab("map");
    window.requestAnimationFrame(() => window.scrollTo({ top: 0 }));
    const params = new URLSearchParams({
      tab: "map", region: nextChoice.partition, group: nextChoice.groupId,
      index: nextChoice.index, method: nextChoice.alternative.method!,
      direction: nextChoice.direction,
      coefficients: nextChoice.alternative.coefficient_partition!,
      lon: String(point.point.longitude), lat: String(point.point.latitude),
    });
    window.history.replaceState(null, "", `?${params}`);
  };

  const updateMap = async () => {
    if (mapBounds.east - mapBounds.west > 6 || mapBounds.north - mapBounds.south > 6) {
      setError("Zoom in until the visible map spans at most 6° in each direction, then update the trend map.");
      return;
    }
    mapAbort.current?.abort();
    const controller = new AbortController(); mapAbort.current = controller;
    setLoadingMap(true); setError(null); setPolygonAnalysis(null); setActive(draft);
    try {
      const nextTiles = await api.maps(draft, mapBounds, controller.signal);
      setTiles(nextTiles); setMapSetupConfirmed(true);
      window.requestAnimationFrame(() => trendMapStep.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
    catch (reason) { if ((reason as Error).name !== "AbortError") setError((reason as Error).message); }
    finally { if (mapAbort.current === controller) setLoadingMap(false); }
  };

  const analyzePolygon = useCallback(async (coordinates: number[][]) => {
    polygonAbort.current?.abort();
    const controller = new AbortController(); polygonAbort.current = controller;
    setLoadingPolygon(true); setPolygonAnalysis(null); setError(null); setFigureView("annual");
    window.requestAnimationFrame(() => analysisStep.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    try { setPolygonAnalysis(await api.polygonAnalysis(active, coordinates, controller.signal)); }
    catch (reason) { if ((reason as Error).name !== "AbortError") setError((reason as Error).message); }
    finally { if (polygonAbort.current === controller) setLoadingPolygon(false); }
  }, [active]);
  const chooseRandomLocation = async () => {
    if (!choice) return;
    setLoadingLocation(true); setError(null);
    try {
      const point = await api.randomPoint(choice.partition, choice.groupId);
      mapAbort.current?.abort(); polygonAbort.current?.abort();
      setMapSetupConfirmed(false);
      setTiles(null); setPolygonAnalysis(null); setFigureView("annual");
      setLocationWarning(null);
      setMapView({ ...point.point, zoom: point.zoom });
      const params = new URLSearchParams(window.location.search);
      params.set("lon", String(point.point.longitude)); params.set("lat", String(point.point.latitude));
      window.history.replaceState(null, "", `?${params}`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoadingLocation(false);
    }
  };
  const chooseSearchedLocation = (result: LocationSearchResult) => {
    mapAbort.current?.abort(); polygonAbort.current?.abort();
    setMapSetupConfirmed(false);
    setTiles(null); setPolygonAnalysis(null); setFigureView("annual"); setError(null);
    setMapView({ longitude: result.longitude, latitude: result.latitude, zoom: 10 });
    setLocationWarning(result.inside_selected_region ? null
      : `${result.label} is outside ${choice?.groupName}. The selected coefficients will still be applied uniformly at this location, but may be less representative.`);
    const params = new URLSearchParams(window.location.search);
    params.set("lon", String(result.longitude)); params.set("lat", String(result.latitude));
    window.history.replaceState(null, "", `?${params}`);
  };
  const editMapSetup = () => {
    polygonAbort.current?.abort();
    setLoadingPolygon(false); setPolygonAnalysis(null);
    setMapSetupConfirmed(false); setError(null);
    window.requestAnimationFrame(() => mapSetupStep.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const chooseTab = (next: "explore" | "map") => {
    if (next === "map" && !choice) return;
    setTab(next);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0 }));
    const params = new URLSearchParams(window.location.search); params.set("tab", next);
    window.history.replaceState(null, "", `?${params}`);
  };
  const analysisAvailable = mapSetupConfirmed && (loadingPolygon || Boolean(polygonAnalysis));

  return <div className="app-shell">
    <header ref={appHeader} className="app-header">
      <div><p className="eyebrow">Collection 2 vegetation-index continuity</p><h1>Landsat Cross-Sensor Harmonization Explorer</h1></div>
      <div className="header-actions">
        <button className="about-study-button" type="button" onClick={openAbout}>About the research</button>
        <nav className="tabs" aria-label="Scientific workflow">
          <button className={tab === "explore" ? "active" : ""} onClick={() => chooseTab("explore")}>1 · Explore &amp; Choose</button>
          <button className={tab === "map" ? "active" : ""} onClick={() => chooseTab("map")}
            disabled={!choice} aria-label={choice ? "Apply selected coefficients on the map" : "Apply on Map locked: select a harmonization approach in Tab 1 first"}
            title={choice ? "Apply selected coefficients on the map" : "Select a harmonization approach in Tab 1 to unlock this tab"}>
            2 · Map &amp; Analyze
          </button>
        </nav>
      </div>
    </header>
    <main>
      {tab === "explore" ? <ExploreWorkflow
        initial={choice
          ? { partition: choice.partition, groupId: choice.groupId, index: choice.index, direction: choice.direction, selectedId: choice.alternative.id }
          : {
              partition: initial.partition,
              groupId: initial.groupId,
              index: initial.index,
              direction: initial.direction,
              selectedId: initial.method && initial.coefficientPartition
                ? `${initial.coefficientPartition}_${initial.method}`
                : undefined,
            }}
        onUse={useChoice} /> :
      restoringChoice ? <section className="guided-empty" role="status">
        <p className="eyebrow">Restoring analysis</p><h2>Loading the selected coefficient strategy…</h2>
        <p>Reconnecting the saved direction, region, index, and method before initializing the map.</p>
      </section> : choice ? <div className="map-tab-workflow">
        <div ref={mapSetupStep} className="map-step-anchor"><ChoiceReport choice={choice}
          onChangeApproach={() => chooseTab("explore")} onBuildTrendMap={() => void updateMap()}
          onEditChoices={editMapSetup} onRandomLocation={() => void chooseRandomLocation()}
          onLocationSelect={chooseSearchedLocation} locationWarning={locationWarning} randomizing={loadingLocation}
          buildingMap={loadingMap} hasMap={Boolean(tiles)} setupConfirmed={mapSetupConfirmed}>
          <TrendControls value={draft} onChange={setDraft} onSubmit={updateMap} loading={loadingMap}
            locked embedded hasMap={Boolean(tiles)} showSubmit={false} />
        </ChoiceReport></div>
        <nav className="map-workflow-progress" aria-label="Map analysis steps">
          <button type="button" className={mapSetupConfirmed ? "summary" : "active"}
            aria-current={!mapSetupConfirmed ? "step" : undefined}
            onClick={() => mapSetupStep.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            <span>A</span><strong>Build trend map</strong><small>Choose location, years, and significance</small>
          </button>
          <button type="button" className={!mapSetupConfirmed ? "locked" : analysisAvailable ? "complete" : "active"}
            aria-current={mapSetupConfirmed && !analysisAvailable ? "step" : undefined}
            onClick={() => trendMapStep.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            <span>B</span><strong>Draw an analysis area</strong><small>Place at least three vertices</small>
          </button>
          <button type="button" className={analysisAvailable ? "active" : "locked"}
            aria-current={analysisAvailable ? "step" : undefined}
            onClick={() => analysisStep.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            <span>C</span><strong>Review results</strong><small>Annual series and trend bars</small>
          </button>
        </nav>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div ref={trendMapStep} className="map-step-anchor"><TrendMap basemap={basemap} direction={choice.direction}
          onBasemapChange={setBasemap} initialView={mapView} tiles={tiles}
          onPolygonSubmit={(coordinates) => void analyzePolygon(coordinates)}
          polygonLoading={loadingPolygon} trendLoading={loadingMap} onBoundsChange={setMapBounds}
          locked={!mapSetupConfirmed} /></div>
        <section ref={analysisStep} className={`workflow-step step-three aoi-analysis-step ${analysisAvailable ? "" : "is-locked"}`}
          aria-disabled={!analysisAvailable} inert={!analysisAvailable}>
        <header className="step-header series-heading">
          <div className="step-number">C</div>
          <div><p className="eyebrow">Evaluate environmental inference</p><h2>Harmonization effects on AOI analysis</h2><p>{loadingPolygon ? "Calculating annual time series and trend distributions for the selected polygon." : polygonAnalysis ? "Compare sensor-era continuity, trend magnitude, direction, and significance within the AOI." : tiles ? "Draw and analyze a polygon to test whether cross-sensor correction changes the inferred vegetation trend." : "Create the trend map before defining an area of interest."} All outputs use April–September growing-season composites.</p></div>
          {polygonAnalysis && <div className="segmented figure-view-toggle" aria-label="Polygon figure set">
            <button className={figureView === "annual" ? "active" : ""} onClick={() => setFigureView("annual")}>Annual series</button>
            <button className={figureView === "distribution" ? "active" : ""} onClick={() => setFigureView("distribution")}>Trend distribution</button>
          </div>}
        </header>
        {loadingPolygon && <div className="analysis-loading-panel" role="status" aria-live="polite">
          <span className="analysis-loading-spinner" aria-hidden="true" />
          <div><strong>Calculating the time-series analysis…</strong>
            <p>Building April–September annual median composites and pixel-level trend distributions inside the polygon.</p></div>
        </div>}
        {polygonAnalysis && figureView === "annual" && <TimeseriesCharts data={polygonAnalysis} index={active.index} direction={active.direction} />}
        {polygonAnalysis && figureView === "distribution" && <PolygonTrendCharts data={polygonAnalysis} index={active.index} />}
        </section>
      </div> : <section className="guided-empty">
        <p className="eyebrow">Tab 2 · Earth Engine</p><h2>Choose a harmonization approach first</h2>
        <p>The map applies one empirically evaluated coefficient set and direction to test how residual cross-sensor bias affects environmental inference. Select a region, index, and model in Tab 1 to continue.</p>
        <button className="primary-button" onClick={() => chooseTab("explore")}>Evaluate harmonization approaches</button>
      </section>}
    </main>
    <footer>Paired ETM+/OLI evidence: April–October 2013–2021 · Bidirectional calibration · Trend sensitivity: April–September annual median composites · L5 ends in 2011 · L7 ends in 2021</footer>
    <AboutStudyModal open={aboutOpen} basemap={basemap} initialIndex={choice?.index ?? initial.index} onClose={closeAbout} />
  </div>;
}
