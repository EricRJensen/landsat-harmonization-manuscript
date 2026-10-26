import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

export type EvaluationOverlay = GeoJSON.FeatureCollection;
const EMPTY: EvaluationOverlay = { type: "FeatureCollection", features: [] };

export function installEvaluationOverlay(map: MapLibreMap, data: EvaluationOverlay | null) {
  const source = map.getSource("evaluation-region") as GeoJSONSource | undefined;
  if (source) source.setData(data ?? EMPTY);
  else {
    map.addSource("evaluation-region", { type: "geojson", data: data ?? EMPTY });
    map.addLayer({ id: "evaluation-outside", type: "fill", source: "evaluation-region",
      filter: ["==", ["get", "role"], "outside"],
      paint: { "fill-color": "#24282d", "fill-opacity": 0.65, "fill-antialias": false } });
    map.addLayer({ id: "evaluation-boundary", type: "line", source: "evaluation-region",
      filter: ["==", ["get", "role"], "boundary"],
      paint: { "line-color": "#f7f7f7", "line-width": 2, "line-dasharray": [4, 2] } });
  }
  // Reinstalled raster/style layers must never cover the region guide. Keep
  // the editable sketch above both, including after a basemap change.
  const before = map.getStyle().layers?.find(layer => layer.id.startsWith("analysis-sketch-"))?.id;
  map.moveLayer("evaluation-outside", before);
  map.moveLayer("evaluation-boundary", before);
}
