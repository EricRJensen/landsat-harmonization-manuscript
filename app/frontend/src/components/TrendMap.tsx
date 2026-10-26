import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { baseStyle, LABEL_LAYER_ID } from "../mapStyle";
import { installSketch } from "../mapSketch";
import { installEvaluationOverlay, type EvaluationOverlay } from "../evaluationOverlay";
import { regionGuideApi } from "../regionGuideApi";
import { validatePolygon } from "../analysisSetup";
import { DifferenceMapModal, type DifferenceMapView } from "./DifferenceMapModal";
import type { BasemapMode, HarmonizationDirection, MapBounds, MapCamera, MapTiles, Partition, PolygonDraft, TileDescriptor } from "../types";

interface Props {
  tiles: MapTiles | null;
  onPolygonSubmit: (coordinates: number[][]) => void;
  onBoundsChange: (bounds: MapBounds, camera: MapCamera, revision: number) => void;
  onMoving: () => void;
  locationRevision: number;
  polygon: PolygonDraft;
  onPolygonChange: (polygon: PolygonDraft) => void;
  evaluationRegion: { partition: Partition; groupId: string; name: string };
  significantOnly: boolean;
  basemap: BasemapMode;
  onBasemapChange: (mode: BasemapMode) => void;
  polygonLoading: boolean;
  trendLoading: boolean;
  initialView?: MapCamera;
  direction: HarmonizationDirection;
  locked?: boolean;
}

function installTile(map: MapLibreMap, descriptor: TileDescriptor, id: string) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  map.addSource(id, { type: "raster", tiles: [descriptor.url.startsWith("/") ? window.location.origin + descriptor.url : descriptor.url], tileSize: 256,
    minzoom: descriptor.minzoom ?? 7, maxzoom: descriptor.maxzoom ?? 13, bounds: [-125, 24, -66, 50] });
  map.addLayer(
    { id, type: "raster", source: id, minzoom: descriptor.minzoom ?? 7, paint: { "raster-opacity": 0.86 } },
    [LABEL_LAYER_ID, "evaluation-outside", "analysis-sketch-fill"].find(id => map.getLayer(id)),
  );
}

export function TrendMap({
  tiles, onPolygonSubmit, onBoundsChange, basemap, onBasemapChange,
  polygonLoading, trendLoading, initialView, direction, locked = false,
  polygon, onPolygonChange, onMoving, locationRevision, evaluationRegion, significantOnly,
}: Props) {
  const rawContainer = useRef<HTMLDivElement>(null);
  const harmContainer = useRef<HTMLDivElement>(null);
  const compareContainer = useRef<HTMLDivElement>(null);
  const rawMap = useRef<MapLibreMap | null>(null);
  const harmMap = useRef<MapLibreMap | null>(null);
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const previousBasemap = useRef(basemap);
  const boundsRef = useRef(onBoundsChange);
  boundsRef.current = onBoundsChange;
  const movingRef = useRef(onMoving); movingRef.current = onMoving;
  const revisionRef = useRef(locationRevision); revisionRef.current = locationRevision;
  const changeRef = useRef(onPolygonChange); changeRef.current = onPolygonChange;
  const lockedRef = useRef(locked); lockedRef.current = locked;
  const [zoom, setZoom] = useState(initialView?.zoom ?? 3.25);
  const [overlay, setOverlay] = useState<EvaluationOverlay | null>(null);
  const overlayRef = useRef(overlay); overlayRef.current = overlay;
  const [overlayError, setOverlayError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setOverlay(null); setOverlayError(false);
    regionGuideApi.overlay(evaluationRegion.partition, evaluationRegion.groupId, controller.signal)
      .then(data => { if (!controller.signal.aborted) setOverlay(data); })
      .catch(() => { if (!controller.signal.aborted) setOverlayError(true); });
    return () => controller.abort();
  }, [evaluationRegion.partition, evaluationRegion.groupId]);
  useEffect(() => {
    for (const map of [rawMap.current, harmMap.current]) {
      if (map?.getSource("analysis-sketch")) installEvaluationOverlay(map, overlay);
    }
  }, [overlay]);
  const [rasterLoading, setRasterLoading] = useState(false);
  const [tileError, setTileError] = useState<string | null>(null);
  const [drawingError, setDrawingError] = useState<string | null>(null);
  const [divider, setDivider] = useState(50);
  const [draggingDivider, setDraggingDivider] = useState(false);
  const [differenceView, setDifferenceView] = useState<DifferenceMapView | null>(null);
  const coordinatesRef = useRef<number[][]>(polygon.vertices);
  const cursorRef = useRef<number[] | null>(null);
  const sketchClosed = useRef(polygon.closed);
  const drawCoordinates = polygon.vertices;
  const polygonClosed = polygon.closed;

  const updateSketch = () => {
    for (const map of [rawMap.current, harmMap.current]) {
      // A loaded style can still be fetching raster tiles; update the existing source immediately.
      if (map?.getSource("analysis-sketch")) installSketch(map, coordinatesRef.current, cursorRef.current, sketchClosed.current);
    }
  };
  const changeCoordinates = (coordinates: number[][]) => {
    coordinatesRef.current = coordinates;
    sketchClosed.current = false;

    if (!coordinates.length) cursorRef.current = null;
    changeRef.current({ vertices: coordinates, closed: false });
    setDrawingError(null);
    if (rawMap.current) rawMap.current.getCanvas().style.cursor = "crosshair";
    updateSketch();
  };

  const closePolygon = () => {
    cursorRef.current = null;
    sketchClosed.current = true;
    changeRef.current({ vertices: coordinatesRef.current, closed: true });
    if (rawMap.current) rawMap.current.getCanvas().style.cursor = "grab";
    updateSketch();
  };

  useEffect(() => {
    if (!rawContainer.current || !harmContainer.current) return;
    const raw = new maplibregl.Map({
      container: rawContainer.current, style: baseStyle(basemap), attributionControl: { compact: true },
      center: initialView ? [initialView.longitude, initialView.latitude] : [-100, 39],
      zoom: initialView?.zoom ?? 3.25, bearing: initialView?.bearing ?? 0, pitch: initialView?.pitch ?? 0, maxZoom: 13,
    });
    const harm = new maplibregl.Map({
      container: harmContainer.current, style: baseStyle(basemap), attributionControl: false,
      center: initialView ? [initialView.longitude, initialView.latitude] : [-100, 39],
      zoom: initialView?.zoom ?? 3.25, bearing: initialView?.bearing ?? 0, pitch: initialView?.pitch ?? 0, maxZoom: 13, interactive: false,
    });
    for (const [map, layer] of [[raw, "raw"], [harm, "harmonized"]] as const) {
      map.on("style.load", () => {
        if (tilesRef.current) installTile(map, tilesRef.current[layer], "analysis");
        installEvaluationOverlay(map, overlayRef.current);
        installSketch(map, coordinatesRef.current, cursorRef.current, sketchClosed.current);
      });
    }
    for (const map of [raw, harm]) {
      map.on("sourcedataloading", event => { if (event.sourceId === "analysis") setRasterLoading(true); });
      const updateLoading = () => {
        if ([raw, harm].every(view => Boolean(view.getSource("analysis")) && view.isSourceLoaded("analysis"))) {
          setRasterLoading(false);
        }
      };
      map.on("sourcedata", event => { if (event.sourceId === "analysis") updateLoading(); });
      map.on("idle", updateLoading);
      map.on("error", event => { if ((event as { sourceId?: string }).sourceId === "analysis") { setRasterLoading(false); setTileError("Some trend tiles could not be loaded. Pan or zoom to try loading them again."); } });
    }
    raw.doubleClickZoom.disable();
    raw.addControl(new maplibregl.NavigationControl(), "top-right");
    raw.on("move", () => {
      harm.jumpTo({ center: raw.getCenter(), zoom: raw.getZoom(), bearing: raw.getBearing(), pitch: raw.getPitch() });
    });
    const reportBounds = () => {
      const bounds = raw.getBounds();
      const clipped = {
        west: Math.max(-125, bounds.getWest()), south: Math.max(24, bounds.getSouth()),
        east: Math.min(-66, bounds.getEast()), north: Math.min(50, bounds.getNorth()),
      };
      const center = raw.getCenter();
      setZoom(raw.getZoom());
      setTileError(null);
      boundsRef.current(clipped, { longitude: center.lng, latitude: center.lat, zoom: raw.getZoom(), bearing: raw.getBearing(), pitch: raw.getPitch() }, revisionRef.current);
    };
    raw.on("movestart", () => movingRef.current());
    raw.on("load", reportBounds);
    raw.on("moveend", reportBounds);
    const nearFirstVertex = (event: MapMouseEvent) => {
      if (!coordinatesRef.current.length) return false;
      const first = raw.project(coordinatesRef.current[0] as [number, number]);
      return Math.hypot(first.x - event.point.x, first.y - event.point.y) <= 12;
    };
    raw.on("click", (event: MapMouseEvent) => {
      if (!tilesRef.current || sketchClosed.current || lockedRef.current) return;
      if (nearFirstVertex(event)) {
        if (coordinatesRef.current.length >= 3) closePolygon();
        return;
      }
      if (coordinatesRef.current.length >= 100) { setDrawingError("Use no more than 100 points for your area of interest. Undo a point or clear the boundary to start again."); return; }
      cursorRef.current = null;
      changeCoordinates([...coordinatesRef.current, [event.lngLat.lng, event.lngLat.lat]]);
    });
    raw.on("mousemove", (event: MapMouseEvent) => {
      if (!tilesRef.current || sketchClosed.current || lockedRef.current) return;
      const canClose = coordinatesRef.current.length >= 3 && nearFirstVertex(event);
      raw.getCanvas().style.cursor = canClose ? "pointer" : "crosshair";
      if (!coordinatesRef.current.length) return;
      cursorRef.current = canClose ? coordinatesRef.current[0] : [event.lngLat.lng, event.lngLat.lat];
      updateSketch();
    });
    raw.on("mouseout", () => { cursorRef.current = null; updateSketch(); });
    raw.getCanvas().style.cursor = "crosshair";
    rawMap.current = raw;
    harmMap.current = harm;
    return () => {
      raw.remove(); harm.remove(); rawMap.current = null; harmMap.current = null;
    };
  }, []);

  useEffect(() => {
    if (previousBasemap.current === basemap) return;
    previousBasemap.current = basemap;
    rawMap.current?.setStyle(baseStyle(basemap));
    harmMap.current?.setStyle(baseStyle(basemap));
  }, [basemap]);

  useEffect(() => {
    if (!initialView || !rawMap.current) return;
    movingRef.current();
    rawMap.current.jumpTo({
      center: [initialView.longitude, initialView.latitude],
      zoom: initialView.zoom,
      bearing: initialView.bearing ?? 0, pitch: initialView.pitch ?? 0,
    });
  }, [locationRevision]);

  useEffect(() => {
    setTileError(null);
    for (const [map, descriptor] of [[rawMap.current, tiles?.raw], [harmMap.current, tiles?.harmonized]] as const) {
      if (map?.getSource("analysis-sketch") && descriptor) {
        installTile(map, descriptor, "analysis");
        installEvaluationOverlay(map, overlayRef.current);
        installSketch(map, coordinatesRef.current, null, sketchClosed.current);
      }
    }
  }, [tiles]);

  useEffect(() => {
    coordinatesRef.current = polygon.vertices;
    sketchClosed.current = polygon.closed;
    cursorRef.current = null;
    updateSketch();
    if (rawMap.current) rawMap.current.getCanvas().style.cursor = polygon.closed ? "grab" : "crosshair";
  }, [polygon]);

  const updateDivider = (clientX: number) => {
    const bounds = compareContainer.current?.getBoundingClientRect();
    if (!bounds) return;
    setDivider(Math.max(4, Math.min(96, 100 * (clientX - bounds.left) / bounds.width)));
  };
  const finishPolygon = () => {
    const issue = validatePolygon(drawCoordinates);
    setDrawingError(issue);
    if (issue) return;
    closePolygon();
    onPolygonSubmit([...drawCoordinates, drawCoordinates[0]]);
  };
  const openDifference = () => {
    const map = rawMap.current;
    if (!map || !tiles) return;
    const center = map.getCenter();
    cursorRef.current = null;
    updateSketch();
    setDifferenceView({ longitude: center.lng, latitude: center.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
  };
  const legend = tiles?.raw;
  const overview = zoom < (tiles?.raw.minzoom ?? 7);
  const sourceScale = direction === "L7_to_L8" ? "TM/ETM+" : "OLI/OLI-2";
  const targetScale = direction === "L7_to_L8" ? "OLI" : "ETM+";

  return <section className={`workflow-step step-two trend-map-card ${locked ? "is-locked" : ""}`}>
    <header className="step-header">
      <div className="step-number">B</div>
      <div><p className="eyebrow">Compare trends and define an area of interest</p><h2>Harmonization effects on trend maps</h2>
        <p>Compare trends before and after adjusting {sourceScale} observations to match the {targetScale} reference sensor. Drag the divider or view the change in trend.</p></div>
    </header>
    <div className="trend-map-frame">
    {(!tiles || locked) && <div className="map-instruction locked">
      <span>!</span>
      <div><strong>Build the trend map in A first</strong>
        <small>Review the location and years in A, then build the map. You can pan and zoom here to set the area shown.</small></div>
    </div>}
    {tiles && <div className="coverage-status" role="status">
      {tileError ? <strong>{tileError}</strong> : overview ? <strong>Zoom in to see vegetation trends.</strong> : rasterLoading ? <strong>Loading trend tiles…</strong> : null}
      <span>{overlayError ? "The evaluation-region boundary could not be loaded." : !overlay ? "Loading the evaluation-region boundary…" : <>Dark gray shading marks areas outside the evaluation region: <strong>{evaluationRegion.name}</strong>.</>}</span>
      <span>{significantOnly ? "Blank areas may have no valid observations or fail the significance filter. The filter applies only to maps; summaries for your area of interest use all evaluated pixels." : "Red indicates a decrease; blue indicates an increase. Blank areas have no displayed trend values."}</span>
    </div>}
    <div ref={compareContainer} className={`compare-map ${tiles && !locked ? "is-ready" : "is-locked"}`}>
      <div ref={rawContainer} className="map-surface" />
      <div ref={harmContainer} className="map-surface map-overlay"
        style={{ clipPath: `inset(0 0 0 ${divider}%)` }} />
      <>
        <div className="map-label map-label-left">Unharmonized</div>
        <div className="map-label map-label-right" title={`${targetScale} reference sensor`}>Harmonized</div>
        <input aria-label="Drag to compare unharmonized and harmonized trends" className="swipe-control" type="range" min="4" max="96"
          value={divider} onChange={(event) => setDivider(Number(event.target.value))} />
        <div className={`swipe-divider ${draggingDivider ? "dragging" : ""}`} style={{ left: `${divider}%` }}
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDraggingDivider(true); }}
          onPointerMove={(event) => { if (draggingDivider) updateDivider(event.clientX); }}
          onPointerUp={(event) => { updateDivider(event.clientX); setDraggingDivider(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => setDraggingDivider(false)}>
          <span aria-hidden="true">↔</span>
        </div>
      </>
      {tiles && !locked && <div className="polygon-actions">
        <div className="polygon-actions-heading" aria-live="polite"><strong className="map-mode-label ready">{polygonClosed ? "Area of interest defined" : "Draw area of interest"}</strong>
          <span>{drawCoordinates.length} {drawCoordinates.length === 1 ? "point" : "points"}</span></div>
        <p className="polygon-actions-purpose"><strong>Draw an area of interest to compare results</strong></p>
        <p>{polygonClosed ? "Select Analyze area of interest, or edit its boundary." : drawCoordinates.length === 0
          ? "Click to place points along the boundary of your area of interest, then click the first point to close it. Select Analyze area of interest to compare results." : drawCoordinates.length < 3
          ? "Keep clicking to define your area of interest (at least 3 points)." : "Click the first point to complete the boundary of your area of interest."}</p>
        <div className="polygon-action-buttons">
          {polygonClosed && <button type="button" onClick={() => changeCoordinates(coordinatesRef.current)}>Edit area of interest</button>}
          <button type="button" onClick={() => changeCoordinates(coordinatesRef.current.slice(0, -1))} disabled={!drawCoordinates.length}>Undo</button>
          <button type="button" onClick={() => changeCoordinates([])} disabled={!drawCoordinates.length}>Clear</button>
          <button type="button" className="primary-button" onClick={finishPolygon} disabled={drawCoordinates.length < 3 || polygonLoading}>
            {polygonLoading ? "Analyzing area of interest…" : "Analyze area of interest"}
          </button>
        </div>
      </div>}
      {!tiles && <div className="map-lock-screen navigable-lock" role="status">
        <span>{trendLoading ? "Building maps" : "Map not yet built"}</span>
        <strong>{trendLoading ? "Building the trend map…" : "Build the trend map in A to begin"}</strong>
        <p>Trends use April–September annual median composites and are reported in index units per decade.</p>
      </div>}
      {legend && <div className="map-legend">
        <div className="legend-ramp" />
        <div><span>{legend.min}</span><span>0</span><span>{legend.max}</span></div>
        <small>{tiles?.units}</small>
      </div>}
    </div>
    <div className="map-toolbar">
      <button type="button" className="primary-button difference-map-button" disabled={!tiles || locked}
        aria-haspopup="dialog" onClick={openDifference}>View harmonized − unharmonized</button>
      <div className="map-toolbar-group basemap-map-toggle">
        <span>Basemap</span>
        <div className="segmented" aria-label="Basemap">
          <button type="button" className={basemap === "satellite" ? "active" : ""} aria-pressed={basemap === "satellite"} onClick={() => onBasemapChange("satellite")}>Satellite</button>
          <button type="button" className={basemap === "streets" ? "active" : ""} aria-pressed={basemap === "streets"} onClick={() => onBasemapChange("streets")}>Streets</button>
        </div>
      </div>
    </div>
    </div>
    {drawingError && <p className="error-banner" role="alert">{drawingError}</p>}
    {differenceView && tiles && <DifferenceMapModal tiles={tiles} basemap={basemap} view={differenceView}
      coordinates={drawCoordinates} closed={polygon.closed} overlay={overlay} regionName={evaluationRegion.name} overlayError={overlayError} onClose={() => setDifferenceView(null)} />}
  </section>;
}
