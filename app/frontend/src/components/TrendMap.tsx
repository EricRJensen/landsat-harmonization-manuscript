import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { baseStyle, LABEL_LAYER_ID } from "../mapStyle";
import type { BasemapMode, HarmonizationDirection, MapBounds, MapTiles, TileDescriptor } from "../types";

interface Props {
  tiles: MapTiles | null;
  onPolygonSubmit: (coordinates: number[][]) => void;
  onBoundsChange: (bounds: MapBounds) => void;
  basemap: BasemapMode;
  onBasemapChange: (mode: BasemapMode) => void;
  polygonLoading: boolean;
  trendLoading: boolean;
  initialView?: { longitude: number; latitude: number; zoom: number };
  direction: HarmonizationDirection;
  locked?: boolean;
}

function installTile(map: MapLibreMap, descriptor: TileDescriptor, id: string) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  map.addSource(id, { type: "raster", tiles: [descriptor.url], tileSize: 256 });
  map.addLayer(
    { id, type: "raster", source: id, paint: { "raster-opacity": 0.86 } },
    map.getLayer(LABEL_LAYER_ID) ? LABEL_LAYER_ID : undefined,
  );
}

function sketchData(coordinates: number[][]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = coordinates.map((coordinate) => ({
    type: "Feature", properties: { kind: "vertex" }, geometry: { type: "Point", coordinates: coordinate },
  }));
  if (coordinates.length >= 2) features.unshift({
    type: "Feature", properties: { kind: "edge" }, geometry: { type: "LineString", coordinates },
  });
  if (coordinates.length >= 3) features.unshift({
    type: "Feature", properties: { kind: "area" },
    geometry: { type: "Polygon", coordinates: [[...coordinates, coordinates[0]]] },
  });
  return { type: "FeatureCollection", features };
}

function installSketch(map: MapLibreMap, coordinates: number[][]) {
  const layerIds = ["analysis-sketch-fill", "analysis-sketch-casing", "analysis-sketch-line", "analysis-sketch-points"];
  const data = sketchData(coordinates);
  const source = map.getSource("analysis-sketch") as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    layerIds.forEach((id) => { if (map.getLayer(id)) map.moveLayer(id); });
    return;
  }
  map.addSource("analysis-sketch", { type: "geojson", data });
  map.addLayer({
    id: "analysis-sketch-fill", type: "fill", source: "analysis-sketch",
    filter: ["==", ["get", "kind"], "area"],
    paint: { "fill-color": "#ffb000", "fill-opacity": 0.25 },
  });
  map.addLayer({
    id: "analysis-sketch-casing", type: "line", source: "analysis-sketch",
    filter: ["!=", ["get", "kind"], "vertex"],
    paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "analysis-sketch-line", type: "line", source: "analysis-sketch",
    filter: ["!=", ["get", "kind"], "vertex"],
    paint: { "line-color": "#d83b20", "line-width": 4 },
  });
  map.addLayer({
    id: "analysis-sketch-points", type: "circle", source: "analysis-sketch",
    filter: ["==", ["get", "kind"], "vertex"],
    paint: { "circle-radius": 7, "circle-color": "#ffb000", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
  });
}

export function TrendMap({
  tiles, onPolygonSubmit, onBoundsChange, basemap, onBasemapChange,
  polygonLoading, trendLoading, initialView, direction, locked = false,
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
  const [divider, setDivider] = useState(50);
  const [draggingDivider, setDraggingDivider] = useState(false);
  const [displayMode, setDisplayMode] = useState<"swipe" | "difference">("swipe");
  const [drawCoordinates, setDrawCoordinates] = useState<number[][]>([]);

  useEffect(() => {
    if (!rawContainer.current || !harmContainer.current) return;
    const raw = new maplibregl.Map({
      container: rawContainer.current, style: baseStyle(basemap),
      center: initialView ? [initialView.longitude, initialView.latitude] : [-100, 39],
      zoom: initialView?.zoom ?? 3.25, maxZoom: 13,
    });
    const harm = new maplibregl.Map({
      container: harmContainer.current, style: baseStyle(basemap),
      center: initialView ? [initialView.longitude, initialView.latitude] : [-100, 39],
      zoom: initialView?.zoom ?? 3.25, maxZoom: 13, interactive: false,
    });
    raw.addControl(new maplibregl.NavigationControl(), "top-right");
    raw.on("move", () => {
      harm.jumpTo({ center: raw.getCenter(), zoom: raw.getZoom(), bearing: raw.getBearing(), pitch: raw.getPitch() });
    });
    const reportBounds = () => {
      const bounds = raw.getBounds();
      boundsRef.current({
        west: Math.max(-125, bounds.getWest()), south: Math.max(24, bounds.getSouth()),
        east: Math.min(-66, bounds.getEast()), north: Math.min(50, bounds.getNorth()),
      });
    };
    raw.on("load", reportBounds);
    raw.on("moveend", reportBounds);
    raw.on("click", (event: MapMouseEvent) => {
      if (!tilesRef.current) return;
      setDrawCoordinates((current) => [...current, [event.lngLat.lng, event.lngLat.lat]]);
    });
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
    setDrawCoordinates([]);
    rawMap.current.easeTo({
      center: [initialView.longitude, initialView.latitude],
      zoom: initialView.zoom,
      duration: 550,
    });
  }, [initialView?.longitude, initialView?.latitude, initialView?.zoom]);

  useEffect(() => {
    if (!tiles || !rawMap.current || !harmMap.current) return;
    const raw = rawMap.current;
    const harm = harmMap.current;
    const update = () => {
      installTile(raw, displayMode === "difference" ? tiles.difference : tiles.raw, "analysis");
      installTile(harm, tiles.harmonized, "analysis");
      installSketch(raw, drawCoordinates);
      installSketch(harm, drawCoordinates);
    };
    let ready = 0;
    const onReady = () => { ready += 1; if (ready === 2) update(); };
    if (raw.isStyleLoaded()) onReady(); else raw.once("style.load", onReady);
    if (harm.isStyleLoaded()) onReady(); else harm.once("style.load", onReady);
  }, [tiles, displayMode, basemap]);

  useEffect(() => {
    for (const map of [rawMap.current, harmMap.current]) {
      if (!map) continue;
      if (map.isStyleLoaded()) installSketch(map, drawCoordinates);
      else map.once("style.load", () => installSketch(map, drawCoordinates));
    }
  }, [drawCoordinates, basemap]);

  useEffect(() => {
    setDrawCoordinates([]);
  }, [tiles]);

  const updateDivider = (clientX: number) => {
    const bounds = compareContainer.current?.getBoundingClientRect();
    if (!bounds) return;
    setDivider(Math.max(4, Math.min(96, 100 * (clientX - bounds.left) / bounds.width)));
  };
  const finishPolygon = () => {
    if (drawCoordinates.length < 3) return;
    onPolygonSubmit([...drawCoordinates, drawCoordinates[0]]);
  };
  const legend = displayMode === "difference" ? tiles?.difference : tiles?.raw;
  const sourceScale = direction === "L7_to_L8" ? "TM/ETM+" : "OLI/OLI-2";
  const targetScale = direction === "L7_to_L8" ? "OLI" : "ETM+";

  return <section className={`workflow-step step-two trend-map-card ${locked ? "is-locked" : ""}`}
    aria-disabled={locked} inert={locked}>
    <header className="step-header">
      <div className="step-number">B</div>
      <div><p className="eyebrow">Test sensitivity of trend inference</p><h2>Harmonization effects on trend maps</h2>
        <p>Compare trend magnitude, direction, and significance before and after placing {sourceScale} observations on an {targetScale}-equivalent scale.</p></div>
    </header>
    <div className="trend-map-frame">
    <div className="map-toolbar">
      <div className={`map-toolbar-group ${tiles ? "" : "is-disabled"}`}>
        <span>Trend layer</span>
        <div className="segmented" aria-label="Trend display mode">
          <button disabled={!tiles} className={displayMode === "swipe" ? "active" : ""} onClick={() => setDisplayMode("swipe")}>Raw ↔ harmonized</button>
          <button disabled={!tiles} className={displayMode === "difference" ? "active" : ""} onClick={() => setDisplayMode("difference")}>Harmonized − unharmonized</button>
        </div>
      </div>
      <div className={`map-toolbar-group ${tiles ? "" : "is-disabled"}`}>
        <span>Analysis area</span><strong className={`map-mode-label ${tiles ? "ready" : ""}`}>Draw polygon</strong>
      </div>
      <div className="map-toolbar-group basemap-map-toggle">
        <span>Basemap</span>
        <div className="segmented" aria-label="Basemap">
          <button className={basemap === "satellite" ? "active" : ""} onClick={() => onBasemapChange("satellite")}>Satellite</button>
          <button className={basemap === "streets" ? "active" : ""} onClick={() => onBasemapChange("streets")}>Streets</button>
        </div>
      </div>
    </div>
    <div className={`map-instruction ${tiles ? "ready" : "locked"}`}>
      <span>{tiles ? "✓" : "!"}</span>
      <div><strong>{tiles ? "Draw a polygon to analyze the trend layers" : "Build the growing-season trend map first"}</strong>
        <small>{tiles
          ? "Click at least three vertices, then select Analyze polygon to test how cross-sensor harmonization changes inference within the AOI."
          : "Choose the year range above and select Build trend map. April–September annual composites reveal sensor-era offsets that can appear as environmental change."}</small></div>
    </div>
    <div ref={compareContainer} className={`compare-map ${tiles ? "is-ready" : "is-locked"}`}>
      <div ref={rawContainer} className="map-surface" />
      <div ref={harmContainer} className="map-surface map-overlay"
        style={{ clipPath: displayMode === "swipe" ? `inset(0 0 0 ${divider}%)` : "inset(0 100% 0 0)" }} />
      {displayMode === "swipe" && <>
        <div className="map-label map-label-left">Unharmonized record</div>
        <div className="map-label map-label-right">{targetScale}-equivalent harmonized</div>
        <input aria-label="Map comparison divider" className="swipe-control" type="range" min="4" max="96"
          value={divider} onChange={(event) => setDivider(Number(event.target.value))} />
        <div className={`swipe-divider ${draggingDivider ? "dragging" : ""}`} style={{ left: `${divider}%` }}
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDraggingDivider(true); }}
          onPointerMove={(event) => { if (draggingDivider) updateDivider(event.clientX); }}
          onPointerUp={(event) => { updateDivider(event.clientX); setDraggingDivider(false); event.currentTarget.releasePointerCapture(event.pointerId); }}>
          <span aria-hidden="true">↔</span>
        </div>
      </>}
      {tiles && !drawCoordinates.length && <div className="polygon-start-hint"><strong>Start the polygon</strong><span>Click the map to place the first vertex</span></div>}
      {tiles && <div className="polygon-actions">
        <strong>{drawCoordinates.length} vertices</strong>
        <button type="button" onClick={() => setDrawCoordinates((current) => current.slice(0, -1))} disabled={!drawCoordinates.length}>Undo</button>
        <button type="button" onClick={() => setDrawCoordinates([])} disabled={!drawCoordinates.length}>Clear</button>
        <button type="button" className="primary-button" onClick={finishPolygon} disabled={drawCoordinates.length < 3 || polygonLoading}>
          {polygonLoading ? "Analyzing area…" : "Analyze polygon"}
        </button>
      </div>}
      {!tiles && <div className="map-lock-screen" role="status">
        <span>{trendLoading ? "Building layers" : "Map pending"}</span>
        <strong>{trendLoading ? "Creating the April–September trend map…" : "Create the trend map to unlock polygon analysis"}</strong>
        <p>Annual trend values are calculated from April–September growing-season median composites.</p>
      </div>}
      {legend && <div className="map-legend">
        <div className="legend-ramp" />
        <div><span>{legend.min}</span><span>0</span><span>{legend.max}</span></div>
        <small>{tiles?.units}{displayMode === "difference" ? " · harmonized minus unharmonized" : ""}</small>
      </div>}
    </div>
    </div>
  </section>;
}
