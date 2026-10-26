import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { regionGuideApi } from "./regionGuideApi";
import driLogo from "./assets/dri-logo.png";
import siteIcon from "./assets/landsat-favicon.png";
import { AboutStudyModal } from "./components/AboutStudyModal";
import { ExploreWorkflow } from "./components/ExploreWorkflow";
import { LocationSearch } from "./components/LocationSearch";
import { TrendControls } from "./components/TrendControls";
import { ResultsSummary } from "./components/ResultsSummary";
import { readAnalysisSetupUrl, validatePeriod, validatePolygon, type SavedAnalysisSetup } from "./analysisSetup";
import { boundsError, mapIdentity, polygonIdentity, scientificIdentity, RequestGeneration } from "./analysisIdentity";
import { focusSection, useVisibleStep } from "./useVisibleStep";
import "./workflowImprovements.css";
import type {
  AnalysisConfig,
  BasemapMode,
  HarmonizationChoice,
  LocationSearchResult,
  MapBounds,
  MapCamera,
  PolygonDraft,
  MapTiles,
  Method,
  PolygonAnalysisResponse,
} from "./types";

const researchWebsiteUrl = "https://landsat-harmonization.earth/";
const TrendMap = lazy(() => import("./components/TrendMap").then((module) => ({ default: module.TrendMap })));
const TimeseriesCharts = lazy(() => import("./components/Charts").then((module) => ({ default: module.TimeseriesCharts })));
const PolygonTrendCharts = lazy(() => import("./components/Charts").then((module) => ({ default: module.PolygonTrendCharts })));

function methodLabel(method: Method | null) {
  if (!method) return "";
  const [family, degree] = method.split("_");
  return `${family === "band" ? "Band-level" : "Index-level"} · ${degree === "linear" ? "linear" : "third-order polynomial (P3)"}`;
}

interface ChoiceReportProps {
  choice: HarmonizationChoice;
  children: ReactNode;
  onBuildTrendMap: () => void;
  onEditChoices: () => void;
  onRandomLocation: () => void;
  onLocationSelect: (result: LocationSearchResult) => void;
  randomizing: boolean;
  buildingMap: boolean;
  hasMap: boolean;
  setupConfirmed: boolean;
  buildBlocked: string | null;
  locationLabel: string;
  locationRegionStatus: "inside" | "outside" | "unknown" | "error";
  error: string | null;
}

function ChoiceReport({
  choice, children, onBuildTrendMap, onEditChoices, onRandomLocation, onLocationSelect,
  randomizing, buildingMap, hasMap, setupConfirmed, buildBlocked, locationLabel, locationRegionStatus, error,
}: ChoiceReportProps) {
  const forward = choice.direction === "L7_to_L8";
  const source = forward ? "ETM+" : "OLI";
  const target = forward ? "OLI" : "ETM+";
  return <section className={`workflow-step step-one map-choice-report ${setupConfirmed ? "context-summary-mode" : ""}`}
    title={setupConfirmed ? "Click 'Edit choices' in the top-right to modify these selections" : undefined}>
    <header className="step-header map-setup-header">
      <div className="step-number">A</div>
      <div><p className="eyebrow">Set up the map analysis</p><h2>Choose a location and analysis period</h2>
        <p>Use your selected {source} → {target} approach to evaluate how harmonization affects vegetation trends.</p></div>
      {setupConfirmed && <div className="map-step-actions">
        <button className="secondary-button edit-choices-button" type="button" onClick={onEditChoices}>Edit choices</button>
      </div>}
    </header>
    <div className="coefficient-facts" aria-label="Chosen coefficient summary">
      <div><span>Method</span><strong>{methodLabel(choice.alternative.method)}</strong></div>
      <div><span>Adjustment</span><strong>{source} → {target}</strong></div>
      <div><span>Evaluation region</span><strong>{choice.groupName}</strong></div>
      <div><span>Index</span><strong>{choice.index}</strong></div>
      <div><span>Held-out RMSE</span><strong>{choice.alternative.metrics?.rmse.toFixed(4)}</strong></div>
      <div><span>Mean bias</span><strong>{choice.alternative.metrics?.mean_difference.toFixed(4)}</strong></div>
    </div>
    <div className="coefficient-detail-row">
      <p>{forward
        ? "The selected coefficients transform Landsat 5 TM and Landsat 7 ETM+ observations based on empirical relationships with Landsat 8/9 OLI; Landsat 8/9 OLI remain unchanged."
        : "The selected coefficients transform Landsat 8/9 OLI observations using ETM+ as the reference sensor; Landsat 5/7 observations remain unchanged."} They are applied uniformly to every visible pixel{choice.alternative.source !== "regional" ? "." : `, including locations outside ${choice.groupName}.`}</p>
    </div>
    <fieldset className="map-setup-fields" disabled={setupConfirmed}>
      <div className="map-setup-grid">
        <section className="map-setup-panel location-setup-panel">
          <header className="map-setup-panel-heading">
            <span className="location-icon" aria-hidden="true">⌖</span>
            <div><strong>Choose the map location</strong><p>The map starts at a randomly selected sample location in {choice.groupName}. Search for a location or choose another sample location.</p></div>
          </header>
          <div className="location-setup-controls">
            <LocationSearch partition={choice.partition} groupId={choice.groupId} onSelect={onLocationSelect} />
            <div className="location-picker-random"><span>or</span>
              <button className="secondary-button" type="button" onClick={onRandomLocation} disabled={randomizing}>
                {randomizing ? "Choosing a location…" : "New sample location"}
              </button>
            </div>
          </div>
          <p className="current-location"><strong>Selected location:</strong> {locationLabel}</p>
          {locationRegionStatus === "outside" && <p className="location-region-notice" role="status"><strong>Outside {choice.groupName}.</strong> The evaluation metrics above do not describe performance at this location.</p>}
          {locationRegionStatus === "error" && <p className="location-region-notice" role="status">Unable to verify whether this location is within {choice.groupName}.</p>}
        </section>
        <section className="map-setup-panel analysis-setup-panel">
          <header className="map-setup-panel-heading">
            <span className="analysis-period-icon" aria-hidden="true">▥</span>
            <div><strong>Choose the analysis period</strong><p>Use at least eight years. Each annual value is the median of April–September observations.</p></div>
          </header>
          {children}
        </section>
      </div>
      <div className="map-build-action">
        <div><strong>Compare trends on the map</strong><span>Build the map, then draw an area of interest to compare time series and trends within it.</span></div>
        <button className="primary-button" type="button" onClick={onBuildTrendMap} disabled={buildingMap || Boolean(buildBlocked)} aria-describedby="map-build-feedback">
          {buildingMap ? <><span className="button-spinner" aria-hidden="true" />Building trend maps…</> : hasMap ? "Rebuild trend map" : "Build trend map"}
        </button>
      </div>
      <p id="map-build-feedback" className={error ? "error-banner" : "setup-feedback"} role={error ? "alert" : "status"}>{error ?? buildBlocked}</p>
    </fieldset>
  </section>;
}

interface MapRecord { tiles: MapTiles; config: AnalysisConfig }
interface AnalysisRecord { data: PolygonAnalysisResponse; config: AnalysisConfig; identity: string }

export default function App() {
  const initial = useRef(readAnalysisSetupUrl(window.location.search)).current;
  const appHeader = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<"explore" | "map">(initial.setup.tab);
  const [aboutOpen, setAboutOpen] = useState(true);
  const [basemap, setBasemap] = useState<BasemapMode>("satellite");
  const [choice, setChoice] = useState<HarmonizationChoice | null>(null);
  const [pendingChoice, setPendingChoice] = useState<HarmonizationChoice | null>(null);
  const pendingRef = useRef(pendingChoice);
  const [exploreInitial, setExploreInitial] = useState(initial.setup);
  const [exploreKey, setExploreKey] = useState(0);
  const [restoringChoice, setRestoringChoice] = useState(initial.setup.hasChoice);
  const [restoreNotice, setRestoreNotice] = useState(initial.warnings.join(" "));
  const [mapView, setMapView] = useState<MapCamera | undefined>(initial.setup.view);
  const [locationRevision, setLocationRevision] = useState(0);
  const revisionRef = useRef(0);
  const [viewReady, setViewReady] = useState(false);
  const readyRef = useRef(false);
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
  const boundsRef = useRef<MapBounds | null>(null);
  const [locationLabel, setLocationLabel] = useState(initial.setup.locationLabel ?? "Sample location");
  const [locationMembership, setLocationMembership] = useState<{ key: string; status: "inside" | "outside" | "error" } | null>(null);
  const [draft, setDraft] = useState<AnalysisConfig>(initial.setup.config);
  const draftRef = useRef(draft); draftRef.current = draft;
  const [mapRecord, setMapRecord] = useState<MapRecord | null>(null);
  const [polygon, setPolygon] = useState<PolygonDraft>(initial.setup.polygon);
  const polygonRef = useRef(polygon); polygonRef.current = polygon;
  const [analysisRecord, setAnalysisRecord] = useState<AnalysisRecord | null>(null);
  const [figureView, setFigureView] = useState<"annual" | "distribution">("annual");
  const [loadingMap, setLoadingMap] = useState(false);
  const [loadingPolygon, setLoadingPolygon] = useState(false);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [openingMap, setOpeningMap] = useState(false);
  const [setupConfirmed, setSetupConfirmed] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [polygonError, setPolygonError] = useState<string | null>(null);
  const [navigationMessage, setNavigationMessage] = useState("");
  const mapAbort = useRef<AbortController | null>(null);
  const polygonAbort = useRef<AbortController | null>(null);
  const mapGeneration = useRef(new RequestGeneration());
  const polygonGeneration = useRef(new RequestGeneration());
  const locationGeneration = useRef(new RequestGeneration());
  const restoreGeneration = useRef(new RequestGeneration());
  const mapSetupStep = useRef<HTMLDivElement>(null);
  const trendMapStep = useRef<HTMLDivElement>(null);
  const analysisStep = useRef<HTMLElement>(null);
  const appFooter = useRef<HTMLElement>(null);
  const currentStep = useVisibleStep([mapSetupStep, trendMapStep, analysisStep], tab === "map");
  const tiles = mapRecord?.tiles ?? null;
  const mapCurrent = Boolean(mapRecord && mapIdentity(mapRecord.config) === mapIdentity(draft));
  const mapSetupConfirmed = setupConfirmed && mapCurrent;
  const resultCurrent = Boolean(analysisRecord && analysisRecord.identity === polygonIdentity(polygon, draft));
  const analysisAvailable = loadingPolygon || Boolean(analysisRecord) || Boolean(polygonError);
  const buildBlocked = validatePeriod(draft.start_year, draft.end_year)
    ?? (!viewReady || loadingLocation ? "Moving to the selected location…" : boundsError(mapBounds));
  const locationMembershipKey = choice && mapView
    ? JSON.stringify([choice.partition, choice.groupId, mapView.longitude, mapView.latitude]) : "";
  const locationRegionStatus = locationMembership?.key === locationMembershipKey ? locationMembership.status : "unknown";

  useEffect(() => {
    if (!choice || !mapView || tab !== "map") return;
    const key = locationMembershipKey;
    if (choice.partition === "conus") {
      setLocationMembership({ key, status: "inside" });
      return;
    }
    const controller = new AbortController();
    void regionGuideApi.lookup(choice.partition, mapView.longitude, mapView.latitude, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setLocationMembership({ key,
          status: result.regions.some(region => region.id === choice.groupId) ? "inside" : "outside" });
      })
      .catch(() => { if (!controller.signal.aborted) setLocationMembership({ key, status: "error" }); });
    return () => controller.abort();
  }, [locationMembershipKey, tab]);

  useLayoutEffect(() => {
    const header = appHeader.current;
    if (!header) return;
    const update = () => document.documentElement.style.setProperty("--app-header-height", `${header.offsetHeight}px`);
    update(); const observer = new ResizeObserver(update); observer.observe(header);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--app-header-height"); };
  }, []);
  useLayoutEffect(() => {
    const footer = appFooter.current;
    if (!footer) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Keep both workflow navigators above the footer as it enters the viewport.
      const overlap = Math.max(0, window.innerHeight - footer.getBoundingClientRect().top);
      document.documentElement.style.setProperty("--footer-clearance", `${overlap}px`);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(footer);
    if (footer.previousElementSibling) observer.observe(footer.previousElementSibling);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.cancelAnimationFrame(frame);
      document.documentElement.style.removeProperty("--footer-clearance");
    };
  }, []);
  useEffect(() => () => { mapAbort.current?.abort(); polygonAbort.current?.abort(); restoreGeneration.current.next(); }, []);

  const cancelMap = () => { mapGeneration.current.next(); mapAbort.current?.abort(); setLoadingMap(false); };
  const cancelPolygon = () => { polygonGeneration.current.next(); polygonAbort.current?.abort(); setLoadingPolygon(false); };
  const moveTo = (view: MapCamera, label: string) => {
    readyRef.current = false; boundsRef.current = null; setViewReady(false); setMapBounds(null);
    revisionRef.current += 1; setLocationRevision(revisionRef.current);
    setMapView(view); setLocationLabel(label);
  };
  const receiveBounds = useCallback((bounds: MapBounds, camera: MapCamera, revision: number) => {
    if (revision !== revisionRef.current) return;
    boundsRef.current = bounds; readyRef.current = true;
    setMapBounds(bounds); setMapView(camera); setViewReady(true);
  }, []);
  const onMoving = useCallback(() => { readyRef.current = false; setViewReady(false); }, []);
  const changePolygon = useCallback((next: PolygonDraft) => {
    polygonGeneration.current.next(); polygonAbort.current?.abort(); setLoadingPolygon(false);
    polygonRef.current = next; setPolygon(next); setPolygonError(null);
    if (!next.vertices.length) setAnalysisRecord(null);
  }, []);
  const changeDraft = (next: AnalysisConfig) => {
    cancelMap();
    if (scientificIdentity(next) !== scientificIdentity(draftRef.current)) cancelPolygon();
    draftRef.current = next; setDraft(next); setSetupConfirmed(false); setMapError(null);
  };

  const restoreSetup = async (setup: SavedAnalysisSetup) => {
    const generation = restoreGeneration.current.next();
    locationGeneration.current.next(); cancelMap(); cancelPolygon(); setOpeningMap(false); setLoadingLocation(false);
    setRestoringChoice(setup.hasChoice); setMapError(null); setPolygonError(null);
    setMapRecord(null); setAnalysisRecord(null); setSetupConfirmed(false); setChoice(null); setPendingChoice(null); pendingRef.current = null;
    setExploreInitial(setup); setExploreKey(key => key + 1);
    setTab(setup.tab); setDraft(setup.config); draftRef.current = setup.config;
    setPolygon(setup.polygon); polygonRef.current = setup.polygon;
    readyRef.current = false; boundsRef.current = null; setViewReady(false); setMapBounds(null);
    setMapView(setup.view); setLocationLabel(setup.locationLabel ?? "Sample location");
    setRestoreNotice("Setup restored. Build the trend map and analyze your area of interest to calculate results.");
    try {
      if (!setup.hasChoice) { setTab("explore"); return; }
      const { partition, groupId, index, direction } = setup.evaluation;
      const evaluation = await api.evaluation(partition, groupId, index, direction);
      if (!restoreGeneration.current.isCurrent(generation)) return;
      const alternative = evaluation.alternatives.find(item => item.available && item.method === setup.config.method
        && item.coefficient_partition === setup.config.coefficient_partition
        && (!setup.config.coefficient_group_id || item.coefficient_group_id === setup.config.coefficient_group_id));
      if (!alternative) throw new Error("The saved approach is unavailable. Select an approach in Explore & Choose.");
      const restored = { partition, groupId, index, direction, groupName: evaluation.group_name, alternative };
      setChoice(restored); setPendingChoice(restored); pendingRef.current = restored;
      const config = { ...setup.config, coefficient_group_id: alternative.coefficient_group_id };
      setDraft(config); draftRef.current = config;
      if (setup.view) moveTo(setup.view, setup.locationLabel ?? "Saved map location");
      else {
        const point = await api.randomPoint(partition, groupId);
        if (!restoreGeneration.current.isCurrent(generation)) return;
        moveTo({ ...point.point, zoom: point.zoom }, `Sample location in ${evaluation.group_name}`);
      }
    } catch (reason) {
      if (restoreGeneration.current.isCurrent(generation)) { setRestoreNotice((reason as Error).message); setTab("explore"); throw reason; }
    } finally { if (restoreGeneration.current.isCurrent(generation)) setRestoringChoice(false); }
  };
  useEffect(() => { if (initial.setup.hasChoice) void restoreSetup(initial.setup).catch(() => { /* The restoration notice explains the failure. */ }); }, []);

  const sameChoice = (left: HarmonizationChoice | null, right: HarmonizationChoice) => left
    && left.alternative.id === right.alternative.id && left.partition === right.partition
    && left.groupId === right.groupId && left.direction === right.direction && left.index === right.index;
  const receiveSelection = useCallback((next: HarmonizationChoice | null) => {
    pendingRef.current = next; setPendingChoice(next);
  }, []);
  const useChoice = async (next: HarmonizationChoice) => {
    if (sameChoice(choice, next) && mapView) { setTab("map"); window.requestAnimationFrame(() => focusSection(mapSetupStep.current)); return; }
    const generation = locationGeneration.current.next(); setOpeningMap(true);
    try {
      // Keep an existing study location when comparing a different method.
      const point = mapView ? null : await api.randomPoint(next.partition, next.groupId);
      if (!locationGeneration.current.isCurrent(generation) || !sameChoice(pendingRef.current, next)) return;
      cancelMap(); cancelPolygon(); setMapRecord(null); setAnalysisRecord(null); setMapError(null); setPolygonError(null);
      const config = { ...draftRef.current, partition: next.partition, method: next.alternative.method!, index: next.index,
        direction: next.direction, coefficient_partition: next.alternative.coefficient_partition, coefficient_group_id: next.alternative.coefficient_group_id };
      setChoice(next); setPendingChoice(next); pendingRef.current = next; setDraft(config); draftRef.current = config; setSetupConfirmed(false); setRestoreNotice("");
      if (point) moveTo({ ...point.point, zoom: point.zoom }, `Sample location in ${next.groupName}`);
      else if (mapView) moveTo(mapView, locationLabel);
      setTab("map"); window.requestAnimationFrame(() => focusSection(mapSetupStep.current));
    } finally { if (locationGeneration.current.isCurrent(generation)) setOpeningMap(false); }
  };

  const updateMap = async () => {
    const bounds = boundsRef.current;
    const issue = validatePeriod(draftRef.current.start_year, draftRef.current.end_year)
      ?? (!readyRef.current ? "Wait for the selected location to finish moving, then build the map." : boundsError(bounds));
    if (issue || !bounds) { setMapError(issue); return; }
    mapAbort.current?.abort(); const controller = new AbortController(); mapAbort.current = controller;
    const generation = mapGeneration.current.next(); const config = { ...draftRef.current };
    setLoadingMap(true); setMapError(null);
    try {
      const response = await api.maps(config, controller.signal);
      if (!mapGeneration.current.isCurrent(generation) || mapIdentity(config) !== mapIdentity(draftRef.current)) return;
      setMapRecord({ tiles: response, config });
      setSetupConfirmed(true); setRestoreNotice("");
      window.requestAnimationFrame(() => focusSection(trendMapStep.current));
    } catch (reason) {
      if ((reason as Error).name !== "AbortError" && mapGeneration.current.isCurrent(generation)) setMapError((reason as Error).message);
    } finally { if (mapGeneration.current.isCurrent(generation)) setLoadingMap(false); }
  };
  const analyzePolygon = async (coordinates: number[][]) => {
    const issue = validatePolygon(coordinates);
    if (issue) { setPolygonError(issue); return; }
    if (!mapRecord || !mapCurrent) { setPolygonError("Build the map for the current settings before analyzing this area of interest."); return; }
    polygonAbort.current?.abort(); const controller = new AbortController(); polygonAbort.current = controller;
    const generation = polygonGeneration.current.next();
    const config = { ...mapRecord.config };
    const identity = polygonIdentity(polygonRef.current, config);
    setLoadingPolygon(true); setPolygonError(null); setFigureView("annual");
    window.requestAnimationFrame(() => focusSection(analysisStep.current));
    try {
      const data = await api.polygonAnalysis(config, coordinates, controller.signal);
      if (!polygonGeneration.current.isCurrent(generation) || identity !== polygonIdentity(polygonRef.current, draftRef.current)) return;
      setAnalysisRecord({ data, config, identity });
    } catch (reason) {
      if ((reason as Error).name !== "AbortError" && polygonGeneration.current.isCurrent(generation)) setPolygonError((reason as Error).message);
    } finally { if (polygonGeneration.current.isCurrent(generation)) setLoadingPolygon(false); }
  };
  const chooseRandomLocation = async () => {
    if (!choice) return;
    const generation = locationGeneration.current.next(); setLoadingLocation(true); setMapError(null);
    cancelMap();
    try {
      const point = await api.randomPoint(choice.partition, choice.groupId);
      if (!locationGeneration.current.isCurrent(generation)) return;
      setSetupConfirmed(false);
      moveTo({ ...point.point, zoom: point.zoom }, `Sample location in ${choice.groupName}`);
    } catch (reason) { if (locationGeneration.current.isCurrent(generation)) setMapError((reason as Error).message); }
    finally { if (locationGeneration.current.isCurrent(generation)) setLoadingLocation(false); }
  };
  const chooseSearchedLocation = (result: LocationSearchResult) => {
    locationGeneration.current.next(); setLoadingLocation(false); cancelMap(); setSetupConfirmed(false); setMapError(null);
    moveTo({ longitude: result.longitude, latitude: result.latitude, zoom: 10 }, result.label);
  };
  const chooseTab = (next: "explore" | "map") => {
    if (next === "map" && tab === "explore") {
      if (pendingChoice) void useChoice(pendingChoice).catch(reason => setRestoreNotice((reason as Error).message));
      return;
    }
    setTab(next); setNavigationMessage(""); window.requestAnimationFrame(() => window.scrollTo({ top: 0 }));
  };
  const visitStep = (step: number) => {
    if (step === 1 && !mapSetupConfirmed) { setNavigationMessage("Build the trend map in A to define and analyze your area of interest in B."); return; }
    if (step === 2 && !analysisAvailable) { setNavigationMessage("Draw an area of interest in B and select Analyze area of interest to review results in C."); return; }
    setNavigationMessage(""); focusSection([mapSetupStep, trendMapStep, analysisStep][step].current);
  };

  return <div className="app-shell">
    <header ref={appHeader} className="app-header">
      <div className="site-header">
        <a className="site-brand" href={researchWebsiteUrl} aria-label="Landsat Vegetation Harmonization home">
          <img src={siteIcon} alt="" width="54" height="54" />
          <span className="site-brand-wordmark"><strong className="site-brand-name">Landsat</strong><span className="site-brand-vegetation">VEGETATION</span><span className="site-brand-descriptor">HARMONIZATION</span></span>
        </a>
        <nav aria-label="Main navigation">
          <a href={`${researchWebsiteUrl}#sensor-story`}>Sensor differences</a>
          <a href={`${researchWebsiteUrl}#coefficients`}>Coefficients</a>
          <a href={`${researchWebsiteUrl}#apply`}>Apply harmonization</a>
          <a href={`${researchWebsiteUrl}#research`}>Publication &amp; data</a>
        </nav>
        <span className="site-explorer-current" aria-current="page">Explorer</span>
      </div>
      <div className="explorer-banner">
        <h1>Landsat Harmonization Explorer</h1>
        <div className="header-actions">
          <button className="about-study-button" type="button" aria-label="About the research" onClick={() => setAboutOpen(true)}>
            <span className="about-label-full">About the research</span><span className="about-label-short">About</span>
          </button>
          <nav className="tabs" aria-label="Scientific workflow">
            <button className={tab === "explore" ? "active" : ""} aria-current={tab === "explore" ? "page" : undefined} onClick={() => chooseTab("explore")}>1 · Explore &amp; Choose</button>
            <button className={tab === "map" ? "active" : ""} aria-current={tab === "map" ? "page" : undefined} onClick={() => chooseTab("map")}
              disabled={openingMap || (tab === "explore" ? !pendingChoice : !choice)}
              title={(tab === "explore" ? pendingChoice : choice) ? "Open the selected approach on the map" : "Select a harmonization approach in panel B to unlock this section"}>
              {openingMap ? "Opening map…" : "2 · Map & Analyze"}
            </button>
          </nav>
        </div>
      </div>
    </header>
    <main>
      {restoreNotice && <p className="setup-notice" role="status">{restoreNotice}</p>}
      {restoringChoice ? <section className="guided-empty" role="status"><h2>Restoring your approach…</h2><p>Loading coefficients for the saved setup.</p></section> : tab === "explore" ? <ExploreWorkflow key={exploreKey}
        initial={choice ? { partition: choice.partition, groupId: choice.groupId, index: choice.index, direction: choice.direction, selectedId: choice.alternative.id }
          : { partition: exploreInitial.evaluation.partition, groupId: exploreInitial.evaluation.groupId, index: exploreInitial.evaluation.index, direction: exploreInitial.evaluation.direction }}
        onSelectionChange={receiveSelection} onUse={useChoice} /> : choice ? <div className="map-tab-workflow">
        <div ref={mapSetupStep} className="map-step-anchor"><ChoiceReport choice={choice}
          onBuildTrendMap={() => void updateMap()}
          onEditChoices={() => { setSetupConfirmed(false); setMapError(null); focusSection(mapSetupStep.current); }}
          onRandomLocation={() => void chooseRandomLocation()} onLocationSelect={chooseSearchedLocation}
          randomizing={loadingLocation} buildingMap={loadingMap}
          hasMap={Boolean(tiles)} setupConfirmed={mapSetupConfirmed} buildBlocked={buildBlocked} error={mapError}
          locationRegionStatus={locationRegionStatus}
          locationLabel={`${locationLabel}${mapView ? ` · Map center: ${mapView.latitude.toFixed(4)}°, ${mapView.longitude.toFixed(4)}°` : ""}`}>
          <TrendControls value={draft} onChange={changeDraft} onSubmit={updateMap} loading={loadingMap} locked embedded hasMap={Boolean(tiles)} showSubmit={false} />
        </ChoiceReport></div>
        <nav className="map-workflow-progress" aria-label="Map analysis steps">
          {[{letter:"A",label:"Build trend map",detail:mapSetupConfirmed ? "Map built · edit settings in A" : "Location, years, map filter",available:true},
            {letter:"B",label:"Define an area of interest",detail:mapSetupConfirmed ? "Draw your area of interest on the map" : "First build the map in A",available:mapSetupConfirmed},
            {letter:"C",label:"Review results",detail:analysisAvailable ? resultCurrent ? "Results match this area of interest" : "Analysis needs updating" : "First analyze an area of interest in B",available:analysisAvailable}].map((step,i) =>
            <button key={step.letter} type="button" data-step={["one","two","three"][i]} className={!step.available ? "locked" : currentStep === i ? "active" : "complete"}
              aria-current={currentStep === i ? "step" : undefined} aria-describedby={navigationMessage ? "map-navigation-message" : undefined}
              onClick={() => visitStep(i)}><span>{step.letter}</span><strong>{step.label}</strong><small>{step.detail}</small></button>)}
        </nav>
        {navigationMessage && <p id="map-navigation-message" className="navigation-message" role="status">{navigationMessage}</p>}
        <div ref={trendMapStep} className="map-step-anchor"><Suspense fallback={<div className="loading-panel" role="status">Loading the map…</div>}><TrendMap basemap={basemap} direction={choice.direction}
          onBasemapChange={setBasemap} initialView={mapView} tiles={tiles} locationRevision={locationRevision}
          polygon={polygon} onPolygonChange={changePolygon} onMoving={onMoving} onBoundsChange={receiveBounds}
          evaluationRegion={{ partition: choice.partition, groupId: choice.groupId, name: choice.groupName }} significantOnly={mapRecord?.config.significant_only ?? false}
          onPolygonSubmit={coordinates => void analyzePolygon(coordinates)} polygonLoading={loadingPolygon} trendLoading={loadingMap}
          locked={!mapSetupConfirmed} /></Suspense></div>
        <section ref={analysisStep} className={`workflow-step step-three aoi-analysis-step ${analysisAvailable ? "" : "is-locked"}`} aria-disabled={!analysisAvailable} inert={!analysisAvailable}>
          <header className="step-header series-heading"><div className="step-number">C</div>
            <div><p className="eyebrow">Review the effect of harmonization</p><h2>Harmonization effects within your area of interest</h2>
              <p>{loadingPolygon ? "Calculating time series and pixel-level trends within your area of interest." : resultCurrent ? "Compare the merged record and pixel-level trends before and after harmonization. Annual values are spatial means of April–September median composites within the analyzed area of interest. Individual-sensor values are shown separately from the merged record." : "Analyze your area of interest in B to compare time series and pixel-level trends."}</p></div>
            {resultCurrent && <div className="segmented figure-view-toggle" aria-label="Area analysis views">
              <button className={figureView === "annual" ? "active" : ""} aria-pressed={figureView === "annual"} onClick={() => setFigureView("annual")}>Time series</button>
              <button className={figureView === "distribution" ? "active" : ""} aria-pressed={figureView === "distribution"} onClick={() => setFigureView("distribution")}>Pixel trends</button>
            </div>}
          </header>
          {analysisRecord && !resultCurrent && !loadingPolygon && <div className="stale-results" role="status"><strong>These results need updating.</strong><p>The area of interest or analysis settings have changed. Build the map if needed, then analyze the current area of interest. Previous charts are hidden until the results are updated.</p><button className="secondary-button" onClick={() => focusSection(trendMapStep.current)}>Return to the area of interest</button></div>}
          {polygonError && <div className="error-banner" role="alert">{polygonError}<button type="button" className="text-button" onClick={() => focusSection(trendMapStep.current)}>Return to the area of interest</button></div>}
          {loadingPolygon && <div className="analysis-loading-panel" role="status"><span className="analysis-loading-spinner" aria-hidden="true" /><div><strong>Calculating results for your area of interest…</strong><p>Computing annual composites, area-mean time series, and pixel-level trends.</p></div></div>}
          {resultCurrent && analysisRecord && <>
            <ResultsSummary data={analysisRecord.data} index={analysisRecord.config.index} period={analysisRecord.config} />
            <Suspense fallback={<div className="loading-panel" role="status">Loading charts…</div>}>
              {figureView === "annual" ? <TimeseriesCharts data={analysisRecord.data} index={analysisRecord.config.index} direction={analysisRecord.config.direction} period={analysisRecord.config} /> : <PolygonTrendCharts data={analysisRecord.data} index={analysisRecord.config.index} />}
            </Suspense>
          </>}
        </section>
      </div> : <section className="guided-empty"><h2>Choose a harmonization approach first</h2><p>Confirm inputs and select an approach in Explore &amp; Choose.</p><button className="primary-button" onClick={() => chooseTab("explore")}>Go to Explore &amp; Choose</button></section>}
    </main>
    <footer ref={appFooter} className="app-footer">
      <div className="app-footer-inner">
        <div className="footer-main">
          <a className="footer-brand" href="https://www.dri.edu/" target="_blank" rel="noopener noreferrer" aria-label="DRI — Desert Research Institute">
            <span className="footer-logo-frame"><img src={driLogo} alt="DRI" width="512" height="513" /></span>
          </a>
          <nav className="footer-links" aria-label="Research and data resources">
            <span className="footer-placeholder" aria-disabled="true" title="Manuscript link forthcoming">Manuscript <span>(forthcoming)</span></span>
            <a href="https://github.com/EricRJensen/landsat-harmonization-manuscript" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="https://zenodo.org/records/22033662" target="_blank" rel="noopener noreferrer">Zenodo</a>
            <a href="https://www.usgs.gov/landsat-missions/landsat-collection-2-level-2-science-products" target="_blank" rel="noopener noreferrer">Landsat Collection 2 Level-2</a>
          </nav>
        </div>
      </div>
    </footer>
    <AboutStudyModal open={aboutOpen} basemap={basemap} initialIndex={choice?.index ?? initial.setup.evaluation.index} onClose={() => setAboutOpen(false)} />
  </div>;
}
