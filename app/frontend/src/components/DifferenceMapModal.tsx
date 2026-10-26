import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { baseStyle, LABEL_LAYER_ID } from "../mapStyle";
import { installSketch } from "../mapSketch";
import { installEvaluationOverlay, type EvaluationOverlay } from "../evaluationOverlay";
import type { BasemapMode, MapTiles } from "../types";

export interface DifferenceMapView {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

interface Props {
  tiles: MapTiles;
  basemap: BasemapMode;
  view: DifferenceMapView;
  coordinates: number[][];
  closed: boolean;
  overlay: EvaluationOverlay | null;
  regionName: string;
  overlayError: boolean;
  onClose: () => void;
}

export function DifferenceMapModal({ tiles, basemap, view, coordinates, closed, overlay, regionName, overlayError, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(view.zoom);
  const [loading, setLoading] = useState(true);
  const [tileError, setTileError] = useState(false);

  useEffect(() => {
    const modal = dialog.current;
    if (!modal || !container.current) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.showModal();
    const map = new maplibregl.Map({
      container: container.current, style: baseStyle(basemap), attributionControl: { compact: true },
      center: [view.longitude, view.latitude], zoom: view.zoom, bearing: view.bearing, pitch: view.pitch, maxZoom: 13,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("style.load", () => {
      map.addSource("difference", { type: "raster", tiles: [tiles.difference.url.startsWith("/") ? window.location.origin + tiles.difference.url : tiles.difference.url], tileSize: 256,
        minzoom: tiles.difference.minzoom ?? 7, maxzoom: tiles.difference.maxzoom ?? 13, bounds: [-125, 24, -66, 50] });
      map.addLayer({ id: "difference", type: "raster", source: "difference", minzoom: tiles.difference.minzoom ?? 7, paint: { "raster-opacity": 0.86 } },
        map.getLayer(LABEL_LAYER_ID) ? LABEL_LAYER_ID : undefined);
      installEvaluationOverlay(map, overlay);
      installSketch(map, coordinates, null, closed);
    });
    map.on("moveend", () => { setZoom(map.getZoom()); setTileError(false); });
    map.on("sourcedataloading", event => { if (event.sourceId === "difference") setLoading(true); });
    map.on("sourcedata", event => {
      if (event.sourceId === "difference" && map.isSourceLoaded("difference")) setLoading(false);
    });
    map.on("idle", () => { if (map.getSource("difference") && map.isSourceLoaded("difference")) setLoading(false); });
    map.on("error", event => { if ((event as { sourceId?: string }).sourceId === "difference") { setLoading(false); setTileError(true); } });
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      map.remove();
      modal.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [tiles, basemap, view, coordinates, closed, overlay]);

  return <dialog ref={dialog} className="difference-modal step-two"
    aria-labelledby="difference-map-title" aria-describedby="difference-map-description"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="difference-modal-header">
      <div><p className="eyebrow">Change in trend</p><h2 id="difference-map-title">Harmonized − unharmonized</h2></div>
      <button type="button" className="about-modal-close" aria-label="Close trend difference map" onClick={onClose}>×</button>
    </header>
    <p id="difference-map-description">The harmonized trend minus the unharmonized trend, in {tiles.units}. Blue indicates a more positive trend after harmonization; red indicates a more negative trend.</p>
    <div className="difference-map-frame">
      <div ref={container} className="map-surface" />
      <div className="map-legend">
        <div className="legend-ramp" />
        <div><span>{tiles.difference.min}</span><span>0</span><span>{tiles.difference.max}</span></div>
        <small>{tiles.units}</small>
      </div>
    </div>
    <p className="difference-map-status" role="status">{tileError ? "Some trend tiles could not be loaded. Pan or zoom to try loading them again." : zoom < (tiles.difference.minzoom ?? 7) ? "Zoom in to see vegetation trends. " : loading ? "Loading difference tiles… " : ""}{overlayError ? "The evaluation-region boundary could not be loaded." : overlay ? `Dark gray shading marks areas outside the evaluation region: ${regionName}.` : "Loading the evaluation-region boundary…"}</p>
    <footer className="difference-modal-footer"><span>Pan and zoom to inspect the change in trend.</span>
      <button type="button" className="secondary-button" onClick={onClose}>Back to slider map</button>
    </footer>
  </dialog>;
}
