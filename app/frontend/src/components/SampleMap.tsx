import { useCallback, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { api } from "../api";
import { baseStyle, LABEL_LAYER_ID } from "../mapStyle";
import type { BasemapMode, GeoJsonFeatureCollection, IndexName, Partition } from "../types";

function formatNumber(value: unknown, digits = 5) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function acquisitionDate(value: unknown) {
  if (typeof value !== "string" || value.length !== 8) return "—";
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function popupContent(properties: Record<string, unknown>): HTMLElement {
  const root = document.createElement("div");
  root.className = "sample-popup";
  const title = document.createElement("strong");
  title.textContent = properties.kind === "aggregate"
    ? `${Number(properties.sample_count).toLocaleString()} paired samples`
    : `Paired sample · ${properties.image_year}`;
  root.append(title);
  const rows: Array<[string, string]> = properties.kind === "aggregate"
    ? [["Mean displayed offset", formatNumber(properties.offset)]]
    : [
        ["ETM+ acquisition", acquisitionDate(properties.l7_date)],
        ["OLI acquisition", acquisitionDate(properties.l8_date)],
        ["NDVI (ETM+ / OLI / OLI−ETM+)", `${formatNumber(properties.l7_ndvi)} / ${formatNumber(properties.l8_ndvi)} / ${formatNumber(properties.ndvi_offset)}`],
        ["EVI (ETM+ / OLI / OLI−ETM+)", `${formatNumber(properties.l7_evi)} / ${formatNumber(properties.l8_evi)} / ${formatNumber(properties.evi_offset)}`],
        ["MSAVI (ETM+ / OLI / OLI−ETM+)", `${formatNumber(properties.l7_msavi)} / ${formatNumber(properties.l8_msavi)} / ${formatNumber(properties.msavi_offset)}`],
        ["Blue Δ", formatNumber(properties.b_offset)],
        ["Green Δ", formatNumber(properties.g_offset)],
        ["Red Δ", formatNumber(properties.r_offset)],
        ["NIR Δ", formatNumber(properties.nir_offset)],
        ["SWIR1 Δ", formatNumber(properties.swir1_offset)],
        ["SWIR2 Δ", formatNumber(properties.swir2_offset)],
        ["Level I ecoregion", String(properties.ecoregion_l1_name ?? "—")],
        ["Level II ecoregion", String(properties.ecoregion_l2_name ?? "—")],
        ["Level III ecoregion", String(properties.ecoregion_l3_name ?? "—")],
        ["HUC02", String(properties.huc02_name ?? "—")],
        ["NLCD class", String(properties.nlcd_landcover ?? "—")],
      ];
  const table = document.createElement("dl");
  rows.forEach(([label, value]) => {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    table.append(dt, dd);
  });
  root.append(table);
  return root;
}

interface Props {
  basemap: BasemapMode;
  selectedIndex?: IndexName;
  selectedPartition?: Partition;
  selectedGroupId?: string;
  lockedRegion?: boolean;
}

export function SampleMap({
  basemap,
  selectedIndex = "NDVI",
  selectedPartition = "conus",
  selectedGroupId = "",
  lockedRegion = false,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const [index, setIndex] = useState<IndexName>(selectedIndex);
  const [year, setYear] = useState<string>("");
  const [month, setMonth] = useState<string>("");
  const [partition, setPartition] = useState<Partition>(selectedPartition);
  const [category, setCategory] = useState(selectedPartition === "conus" ? "" : selectedGroupId);
  const [categories, setCategories] = useState<Record<string, string[]>>({});
  const [ranges, setRanges] = useState<Record<string, [number, number]>>({});
  const [range, setRange] = useState<[number, number]>([-0.1, 0.1]);
  const [metadata, setMetadata] = useState<GeoJsonFeatureCollection["metadata"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.sampleConfig().then((config) => {
      setCategories(config.categories as Record<string, string[]>);
      const availableRanges = config.offset_ranges as Record<string, [number, number]>;
      setRanges(availableRanges);
      if (availableRanges?.NDVI) setRange(availableRanges.NDVI);
    }).catch((reason: Error) => setError(reason.message));
  }, []);

  const refresh = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !map.getSource("samples")) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const bounds = map.getBounds();
    setLoading(true);
    setError(null);
    try {
      const data = await api.sampleFeatures({
        bbox: { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() },
        zoom: map.getZoom(),
        index,
        year: year ? Number(year) : null,
        month: month ? Number(month) : null,
        partition,
        category: category || null,
      }, controller.signal);
      (map.getSource("samples") as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: data.features,
      } as FeatureCollection);
      setMetadata(data.metadata);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, [index, year, month, partition, category]);
  refreshRef.current = () => { void refresh(); };

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: baseStyle(basemap), center: [-100, 39], zoom: 3.5 });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("load", () => {
      map.addSource("samples", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "sample-aggregates", type: "circle", source: "samples",
        filter: ["==", ["get", "kind"], "aggregate"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "sample_count"], 1, 4, 500, 8, 15000, 20],
          "circle-color": ["interpolate", ["linear"], ["get", "offset"], range[0], "#a6611a", 0, "#f5f5f5", range[1], "#5e3c99"],
          "circle-opacity": 0.82, "circle-stroke-color": "#172326", "circle-stroke-width": 0.5,
        },
      }, map.getLayer(LABEL_LAYER_ID) ? LABEL_LAYER_ID : undefined);
      map.addLayer({
        id: "sample-points", type: "circle", source: "samples",
        filter: ["==", ["get", "kind"], "sample"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 13, 5],
          "circle-color": ["interpolate", ["linear"], ["get", "offset"], range[0], "#a6611a", 0, "#f5f5f5", range[1], "#5e3c99"],
          "circle-opacity": 0.8, "circle-stroke-color": "#172326", "circle-stroke-width": 0.35,
        },
      }, map.getLayer(LABEL_LAYER_ID) ? LABEL_LAYER_ID : undefined);
      refreshRef.current();
    });
    map.on("moveend", () => refreshRef.current());
    let hoverPopup: maplibregl.Popup | null = null;
    const hover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feature = event.features?.[0];
      if (!feature) return;
      map.getCanvas().style.cursor = "pointer";
      hoverPopup?.remove();
      hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "430px" })
        .setLngLat(event.lngLat).setDOMContent(popupContent(feature.properties)).addTo(map);
    };
    const leave = () => { map.getCanvas().style.cursor = ""; hoverPopup?.remove(); hoverPopup = null; };
    map.on("mouseenter", "sample-points", hover);
    map.on("mousemove", "sample-points", hover);
    map.on("mouseleave", "sample-points", leave);
    map.on("mouseenter", "sample-aggregates", hover);
    map.on("mouseleave", "sample-aggregates", leave);
    map.on("click", "sample-points", (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (feature) new maplibregl.Popup({ maxWidth: "430px" }).setLngLat(event.lngLat)
        .setDOMContent(popupContent(feature.properties)).addTo(map);
    });
    mapRef.current = map;
    return () => { abortRef.current?.abort(); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setIndex(selectedIndex); }, [selectedIndex]);
  useEffect(() => {
    setPartition(selectedPartition);
    setCategory(selectedPartition === "conus" ? "" : selectedGroupId);
  }, [selectedPartition, selectedGroupId]);
  useEffect(() => { if (ranges[index]) setRange(ranges[index]); }, [index, ranges]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("sample-points")) return;
    for (const layer of ["sample-points", "sample-aggregates"]) {
      map.setPaintProperty(layer, "circle-color", ["interpolate", ["linear"], ["get", "offset"], range[0], "#a6611a", 0, "#f5f5f5", range[1], "#5e3c99"]);
    }
  }, [range]);

  const partitionCategories = categories[partition] ?? [];
  return <div className="sample-layout">
    <section className="control-card sample-controls">
      <div>
        <p className="eyebrow">Paired observations</p>
        <h2>Near-coincident ETM+–OLI observations</h2>
        <p>Offsets are OLI minus ETM+ for acquisitions one day apart. Zoom in to inspect individual paired samples.</p>
      </div>
      <label>Color by index
        <select value={index} onChange={(event) => setIndex(event.target.value as IndexName)}>
          {(["NDVI", "EVI", "MSAVI"] as IndexName[]).map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>
      <label>Year
        <select value={year} onChange={(event) => setYear(event.target.value)}><option value="">All years</option>
          {Array.from({ length: 9 }, (_, i) => 2013 + i).map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>
      <label>Month
        <select value={month} onChange={(event) => setMonth(event.target.value)}><option value="">All months</option>
          {[4, 5, 6, 7, 8, 9, 10].map((item) => <option key={item} value={item}>{new Date(2000, item - 1).toLocaleString("en", { month: "short" })}</option>)}
        </select>
      </label>
      {!lockedRegion && <label>Partition filter
        <select value={partition} onChange={(event) => { setPartition(event.target.value as Partition); setCategory(""); }}>
          <option value="conus">None</option><option value="ecoregion_l1">Level I ecoregion</option><option value="ecoregion_l2">Level II ecoregion</option>
          <option value="ecoregion_l3">Level III ecoregion</option><option value="huc02">HUC02</option><option value="nlcd">NLCD class</option>
        </select>
      </label>}
      {!lockedRegion && partition !== "conus" && <label>Category
        <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>
          {partitionCategories.map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>}
      <div className="offset-range">
        <span>{range[0]?.toFixed(3)}</span><div className="legend-ramp" /><span>{range[1]?.toFixed(3)}</span>
      </div>
      <small>{loading ? "Loading visible samples…" : metadata ? `${metadata.mode === "aggregate" ? "Aggregates" : "Points"} loaded${metadata.truncated ? " · viewport capped" : ""}` : "Move the map to load samples"}</small>
      {error && <p className="error-message">{error}</p>}
    </section>
    <section className="map-card sample-map-card"><div ref={container} className="map-surface" /></section>
  </div>;
}
