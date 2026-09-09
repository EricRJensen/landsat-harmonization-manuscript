export type IndexName = "NDVI" | "EVI" | "MSAVI";
export type Partition = "conus" | "ecoregion_l1" | "ecoregion_l2" | "ecoregion_l3" | "huc02" | "nlcd";
export type Method = "band_linear" | "band_cubic" | "index_linear" | "index_cubic";
export type HarmonizationDirection = "L7_to_L8" | "L8_to_L7";

export interface AnalysisConfig {
  partition: Partition;
  method: Method;
  index: IndexName;
  direction: HarmonizationDirection;
  start_year: number;
  end_year: number;
  significant_only: boolean;
  coefficient_partition?: Partition;
  coefficient_group_id?: string;
}

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TileDescriptor {
  url: string;
  min: number;
  max: number;
  palette: string[];
}

export interface MapTiles {
  raw: TileDescriptor;
  harmonized: TileDescriptor;
  difference: TileDescriptor;
  units: string;
}

export type BasemapMode = "satellite" | "streets";

export interface RegionSummary {
  id: string;
  name: string;
  sample_count: number;
  training_count: number;
  validation_count: number;
}

export interface BinMetric {
  bin: number;
  lower: number;
  upper: number;
  n: number;
  mean_difference: number | null;
}

export interface ValidationMetrics {
  n: number;
  rmse: number;
  mean_difference: number;
  bins: BinMetric[];
}

export interface CoefficientModel {
  coefficients: number[];
  n: number;
  predictor_min: number;
  predictor_max: number;
  validation?: { n: number; rmse: number; bias: number };
}

export interface EvaluationAlternative {
  id: string;
  source: "raw" | "CONUS" | "regional" | "published";
  coefficient_partition?: Partition;
  coefficient_group_id?: string;
  method: Method | null;
  available: boolean;
  metrics: ValidationMetrics | null;
  models: Record<string, CoefficientModel> | null;
  citation?: string;
  regression_type?: string;
}

export interface EvaluationResponse {
  partition: Partition;
  group_id: string;
  group_name: string;
  sample_count: number;
  index: IndexName;
  direction: HarmonizationDirection;
  source_sensor: "L7" | "L8";
  target_sensor: "L7" | "L8";
  mean_difference: string;
  fallback_to_conus: false;
  alternatives: EvaluationAlternative[];
  provenance: Record<string, unknown>;
}

export interface HarmonizationChoice {
  partition: Partition;
  groupId: string;
  groupName: string;
  index: IndexName;
  direction: HarmonizationDirection;
  alternative: EvaluationAlternative;
}

export interface TimePoint {
  year: number;
  raw?: number | null;
  harm?: number | null;
  scene_count: number;
}

export interface TimeseriesResponse {
  point: { longitude: number; latitude: number };
  series: Record<string, TimePoint[]>;
  trends: Record<string, { slope: number; p_value: number; tau: number; n: number } | null>;
  strata: { active_group: string | null; by_year: Record<string, string | number | null> };
}

export interface TrendDistribution {
  boxplot: { low: number; q1: number; median: number; q3: number; high: number };
  class_percentages: Record<"-3" | "-2" | "-1" | "1" | "2" | "3", number>;
  pixel_count: number;
}

export interface PolygonAnalysisResponse {
  geometry: { type: "Polygon"; coordinates: number[][][] };
  series: Record<string, TimePoint[]>;
  trends: Record<string, { slope: number; p_value: number; tau: number; n: number } | null>;
  trend_distributions: Record<"raw" | "harmonized", TrendDistribution>;
  units: string;
}

export interface LocationSearchResult {
  id: string;
  label: string;
  type: string;
  longitude: number;
  latitude: number;
  inside_selected_region: boolean;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
  metadata: { mode: "aggregate" | "samples"; truncated: boolean; limit: number; offset: string };
}
