import type { AnalysisConfig, HarmonizationDirection, IndexName, MapCamera, Method, Partition, PolygonDraft } from "./types";

export interface SavedAnalysisSetup {
  version: 1;
  tab: "explore" | "map";
  evaluation: { partition: Partition; groupId: string; index: IndexName; direction: HarmonizationDirection };
  config: AnalysisConfig;
  view?: MapCamera;
  polygon: PolygonDraft;
  locationLabel?: string;
  hasChoice: boolean;
}

const PARTITIONS = ["conus", "ecoregion_l1", "ecoregion_l2", "ecoregion_l3", "huc02", "nlcd"] as const;
const EVALUATION_PARTITIONS = ["conus", "ecoregion_l1", "ecoregion_l2", "ecoregion_l3", "huc02"] as const;
const METHODS = ["band_linear", "band_cubic", "index_linear", "index_cubic"] as const;
const INDICES = ["NDVI", "EVI", "MSAVI"] as const;
const DIRECTIONS = ["L7_to_L8", "L8_to_L7"] as const;

export function defaultAnalysisSetup(): SavedAnalysisSetup {
  return {
    version: 1, tab: "explore", hasChoice: false,
    evaluation: { partition: "conus", groupId: "CONUS", index: "NDVI", direction: "L7_to_L8" },
    config: { partition: "conus", method: "band_linear", index: "NDVI", direction: "L7_to_L8", start_year: 1985, end_year: 2025, significant_only: false },
    polygon: { vertices: [], closed: false },
  };
}

export function validatePeriod(startYear: number, endYear: number): string | null {
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) return "Enter a whole number for each year.";
  if (startYear < 1985 || startYear > 2025 || endYear < 1985 || endYear > 2025) return "Choose start and end years between 1985 and 2025.";
  if (endYear < startYear) return "The end year must be later than the start year.";
  if (endYear - startYear + 1 < 8) return endYear >= 1992
    ? `Choose at least eight years; with an end year of ${endYear}, start in ${endYear - 7} or earlier.`
    : `Choose at least eight years; with a start year of ${startYear}, end in ${startYear + 7} or later.`;
  return null;
}

const samePoint = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
export function polygonVertices(coordinates: number[][]): number[][] {
  return coordinates.length > 1 && samePoint(coordinates[0], coordinates[coordinates.length - 1]) ? coordinates.slice(0, -1) : coordinates;
}

/** Accept both an editable vertex list and a closed GeoJSON ring. */
export function validatePolygon(coordinates: number[][], closed = true): string | null {
  if (!Array.isArray(coordinates) || coordinates.some((point) => !Array.isArray(point) || point.length !== 2 || point.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate)))) {
    return "Each point defining your area of interest must contain a longitude and latitude as finite numbers.";
  }
  const vertices = polygonVertices(coordinates);
  if (vertices.length > 100 || (closed && vertices.length < 3)) return "Use 3–100 points to define a closed boundary for your area of interest.";
  if (!vertices.length) return null;
  if (vertices.some(([longitude, latitude]) => longitude < -125 || longitude > -66 || latitude < 24 || latitude > 50)) return "Keep your area of interest within CONUS (longitude −125 to −66; latitude 24 to 50).";
  const xs = vertices.map(([longitude]) => longitude);
  const ys = vertices.map(([, latitude]) => latitude);
  if (Math.max(...xs) - Math.min(...xs) > 1.5 || Math.max(...ys) - Math.min(...ys) > 1.5) return "Keep your area of interest within 1.5° of longitude and latitude. Draw a smaller area of interest.";
  if (!closed) return null;
  if (new Set(vertices.map((point) => JSON.stringify(point))).size !== vertices.length) return "Remove repeated points from the boundary of your area of interest.";
  const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = vertices.slice(1, -1).reduce((sum, point, index) => sum + cross(vertices[0], point, vertices[index + 2]), 0);
  if (Math.abs(area) < 1e-12) return "Draw an area of interest with a nonzero area; the points cannot all lie along one line.";
  const onSegment = (a: number[], b: number[], p: number[]) => Math.abs(cross(a, b, p)) < 1e-12 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      if (j === i + 1 || (i === 0 && j === vertices.length - 1)) continue;
      const a = vertices[i], b = vertices[(i + 1) % vertices.length], c = vertices[j], d = vertices[(j + 1) % vertices.length];
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) return "The boundary of your area of interest cannot cross itself. Move or remove the intersecting points.";
    }
  }
  return null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing or invalid.`);
  return value as Record<string, unknown>;
}
function member<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is not supported.`);
  return value as T;
}
function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`${label} is missing or too long.`);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
}
function finite(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
}

/** Only recognized fields are restored. A saved setup never contains cached analysis results. */
export function parseAnalysisSetup(input: unknown): SavedAnalysisSetup {
  let decoded = input;
  if (typeof input === "string") {
    try { decoded = JSON.parse(input); }
    catch { throw new Error("The setup is not valid JSON. Choose a setup file downloaded from this app."); }
  }
  const source = record(decoded, "Saved setup");
  if (source.version !== 1) throw new Error("This saved-setup version is not supported. Use a version 1 setup from this app.");
  const evaluation = record(source.evaluation, "Evaluation context");
  const config = record(source.config, "Analysis settings");
  const polygon = record(source.polygon, "Area of interest");
  const setup: SavedAnalysisSetup = {
    version: 1,
    tab: member(source.tab, ["explore", "map"], "Workflow tab"),
    hasChoice: bool(source.hasChoice, "Selected approach"),
    evaluation: {
      partition: member(evaluation.partition, EVALUATION_PARTITIONS, "Evaluation region type"),
      groupId: name(evaluation.groupId, "Evaluation region"),
      index: member(evaluation.index, INDICES, "Vegetation index"),
      direction: member(evaluation.direction, DIRECTIONS, "Reference sensor"),
    },
    config: {
      partition: member(config.partition, PARTITIONS, "Analysis region type"),
      method: member(config.method, METHODS, "Harmonization approach"),
      index: member(config.index, INDICES, "Analysis index"),
      direction: member(config.direction, DIRECTIONS, "Analysis reference sensor"),
      start_year: finite(config.start_year, 1985, 2025, "Start year"),
      end_year: finite(config.end_year, 1985, 2025, "End year"),
      significant_only: bool(config.significant_only, "Significance filter"),
    },
    polygon: { vertices: polygon.vertices as number[][], closed: bool(polygon.closed, "Area of interest closure") },
  };
  const periodError = validatePeriod(setup.config.start_year, setup.config.end_year);
  if (periodError) throw new Error(periodError);
  const polygonError = validatePolygon(setup.polygon.vertices, setup.polygon.closed);
  if (polygonError) throw new Error(polygonError);
  setup.polygon.vertices = polygonVertices(setup.polygon.vertices).map((point) => [...point]);
  if (config.coefficient_partition !== undefined) setup.config.coefficient_partition = member(config.coefficient_partition, PARTITIONS, "Coefficient region type");
  if (config.coefficient_group_id !== undefined) setup.config.coefficient_group_id = name(config.coefficient_group_id, "Coefficient region");
  if (setup.hasChoice && !setup.config.coefficient_partition) throw new Error("The saved approach is missing its coefficient region type.");
  if (setup.config.coefficient_partition && setup.config.coefficient_partition !== "conus" && !setup.config.coefficient_group_id) throw new Error("Regional coefficients require a coefficient region identifier.");
  if (setup.evaluation.partition === "conus" && setup.evaluation.groupId !== "CONUS") throw new Error("The CONUS evaluation region identifier must be CONUS.");
  if (setup.hasChoice && setup.config.coefficient_partition === "conus" && setup.config.coefficient_group_id && setup.config.coefficient_group_id !== "CONUS") throw new Error("CONUS coefficients must use the CONUS coefficient region.");
  // The comparison endpoint offers CONUS fits and fits from this evaluation region.
  if (setup.hasChoice && setup.config.coefficient_partition !== "conus"
    && (setup.config.coefficient_partition !== setup.evaluation.partition || setup.config.coefficient_group_id !== setup.evaluation.groupId)) {
    throw new Error("The saved regional coefficients do not match the evaluation region. Select an approach again.");
  }
  if (source.locationLabel !== undefined) setup.locationLabel = name(source.locationLabel, "Location label");
  if (source.view !== undefined) {
    const view = record(source.view, "Map view");
    setup.view = { longitude: finite(view.longitude, -180, 180, "Map longitude"), latitude: finite(view.latitude, -85.051129, 85.051129, "Map latitude"), zoom: finite(view.zoom, 0, 22, "Map zoom") };
    if (view.bearing !== undefined) setup.view.bearing = finite(view.bearing, -360, 360, "Map bearing");
    if (view.pitch !== undefined) setup.view.pitch = finite(view.pitch, 0, 85, "Map pitch");
  }
  if (setup.hasChoice && (setup.config.partition !== setup.evaluation.partition || setup.config.index !== setup.evaluation.index || setup.config.direction !== setup.evaluation.direction)) throw new Error("The selected approach and evaluation context do not agree. Choose the approach again.");
  return setup;
}

export function readAnalysisSetupUrl(search: string): { setup: SavedAnalysisSetup; warnings: string[] } {
  const params = new URLSearchParams(search);
  if (params.has("setup")) {
    try { return { setup: parseAnalysisSetup(params.get("setup")), warnings: [] }; }
    catch (reason) { return { setup: defaultAnalysisSetup(), warnings: [`The saved setup could not be restored: ${(reason as Error).message}`] }; }
  }
  const setup = defaultAnalysisSetup();
  const warnings: string[] = [];
  const legacyMember = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (allowed.includes(value as T)) return value as T;
    warnings.push(`The link's ${key} setting was not recognized; the default is shown.`); return fallback;
  };
  setup.tab = legacyMember("tab", ["explore", "map"], "explore");
  setup.evaluation.partition = legacyMember("region", EVALUATION_PARTITIONS, "conus");
  setup.evaluation.groupId = setup.evaluation.partition === "conus" ? "CONUS" : params.get("group") || "";
  if (!setup.evaluation.groupId || setup.evaluation.groupId.length > 512) {
    warnings.push("The link did not specify a valid evaluation region; choose a region in Explore & Choose.");
    setup.evaluation.partition = "conus"; setup.evaluation.groupId = "CONUS";
  }
  setup.evaluation.index = legacyMember("index", INDICES, "NDVI");
  setup.evaluation.direction = legacyMember("direction", DIRECTIONS, "L7_to_L8");
  setup.config = { ...setup.config, partition: setup.evaluation.partition, index: setup.evaluation.index, direction: setup.evaluation.direction, method: legacyMember("method", METHODS, "band_linear") };
  if (params.has("method") && METHODS.includes(params.get("method") as Method) && params.has("coefficients") && PARTITIONS.includes(params.get("coefficients") as Partition)) {
    setup.config.coefficient_partition = params.get("coefficients") as Partition;
    setup.config.coefficient_group_id = params.get("coefficient_group") || (setup.config.coefficient_partition === "conus" ? "CONUS" : setup.evaluation.groupId);
    setup.hasChoice = true;
  }
  const longitude = params.get("lon"), latitude = params.get("lat");
  if (longitude !== null || latitude !== null) {
    if (longitude?.trim() && latitude?.trim() && Number.isFinite(Number(longitude)) && Number.isFinite(Number(latitude)) && Math.abs(Number(longitude)) <= 180 && Math.abs(Number(latitude)) <= 85.051129) {
      const zoom = params.has("zoom") ? Number(params.get("zoom")) : 10;
      setup.view = { longitude: Number(longitude), latitude: Number(latitude), zoom: Number.isFinite(zoom) && zoom >= 0 && zoom <= 22 ? zoom : 10 };
    } else warnings.push("The link's map location was incomplete or invalid; choose a location before building the map.");
  }
  if (params.has("start") || params.has("end")) {
    const start = params.has("start") ? Number(params.get("start")) : 1985;
    const end = params.has("end") ? Number(params.get("end")) : 2025;
    const periodError = validatePeriod(start, end);
    if (periodError) warnings.push(`The link's analysis period was invalid: ${periodError} The default period is shown.`);
    else { setup.config.start_year = start; setup.config.end_year = end; }
  }
  setup.config.significant_only = params.get("significant") === "true";
  if (params.has("coefficients") && !PARTITIONS.includes(params.get("coefficients") as Partition)) warnings.push("The link's coefficient region type was not recognized; select an approach again.");
  if (setup.hasChoice) {
    try { parseAnalysisSetup(setup); }
    catch (reason) {
      setup.hasChoice = false;
      delete setup.config.coefficient_partition; delete setup.config.coefficient_group_id;
      warnings.push(`The link's selected approach could not be restored: ${(reason as Error).message}`);
    }
  }
  return { setup, warnings };
}

export function serializeAnalysisSetup(setup: SavedAnalysisSetup): string {
  return JSON.stringify(parseAnalysisSetup(setup), null, 2);
}

export function analysisSetupUrl(setup: SavedAnalysisSetup, baseUrl: string): string {
  const url = new URL(baseUrl);
  // The versioned payload supersedes old query settings and preserves every vertex.
  url.search = new URLSearchParams({ setup: JSON.stringify(parseAnalysisSetup(setup)) }).toString();
  url.hash = "";
  return url.toString();
}
