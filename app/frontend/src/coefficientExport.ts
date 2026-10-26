import type { HarmonizationChoice } from "./types";

export const METHOD_NAMES: Record<string, string> = {
  band_linear: "Band-level · Linear",
  band_cubic: "Band-level · Third-order polynomial",
  index_linear: "Index-level · Linear",
  index_cubic: "Index-level · Third-order polynomial",
};

export const VARIABLE_NAMES: Record<string, string> = {
  B: "Blue", G: "Green", R: "Red", NIR: "Near infrared",
  SWIR1: "Shortwave infrared 1", SWIR2: "Shortwave infrared 2",
};

export function coefficientExport(choice: HarmonizationChoice) {
  const bandLevel = choice.alternative.method?.startsWith("band_") ?? false;
  const cubic = choice.alternative.method?.endsWith("_cubic") ?? false;
  const fittingPartition = choice.alternative.coefficient_partition ?? "conus";
  return {
    schema_version: 1,
    method: choice.alternative.method,
    direction: choice.direction,
    source_scale: choice.direction === "L7_to_L8" ? "ETM+" : "OLI",
    reference_scale: choice.direction === "L7_to_L8" ? "OLI" : "ETM+",
    index: choice.index,
    coefficient_fitting_region: {
      partition: fittingPartition,
      id: choice.alternative.coefficient_group_id ?? "CONUS",
      name: fittingPartition === "conus" ? "Conterminous U.S. (CONUS)" : choice.groupName,
    },
    evaluation_region: { partition: choice.partition, id: choice.groupId, name: choice.groupName },
    equation: cubic ? "y = b0 + b1*x + b2*x^2 + b3*x^3" : "y = b0 + b1*x",
    coefficient_order: cubic ? ["b0", "b1", "b2", "b3"] : ["b0", "b1"],
    input_units: bandLevel ? "unitless surface reflectance" : "unitless vegetation index",
    input_preparation: bandLevel
      ? "Apply to physical surface reflectance: Landsat Collection 2 Level-2 SR DN * 0.0000275 - 0.2. Calculate the index from the adjusted bands."
      : "Calculate the unharmonized index from physical surface reflectance (Landsat Collection 2 Level-2 SR DN * 0.0000275 - 0.2), then apply the coefficients to the index value, without an integer scale factor.",
    output_units: bandLevel ? "unitless surface reflectance adjusted to match the reference sensor" : "unitless vegetation index adjusted to match the reference sensor",
    data_url: "https://zenodo.org/records/22033662",
    models: Object.fromEntries(Object.entries(choice.alternative.models ?? {}).map(([variable, model]) => [variable, {
      coefficients: [...model.coefficients],
      predictor_min: model.predictor_min,
      predictor_max: model.predictor_max,
      training_count: model.n,
    }])),
  };
}

export function coefficientsJson(choice: HarmonizationChoice): string {
  return JSON.stringify(coefficientExport(choice), null, 2);
}

export function coefficientsTsv(choice: HarmonizationChoice): string {
  const data = coefficientExport(choice);
  const header = ["variable", ...data.coefficient_order, "method", "direction", "index", "coefficient_partition", "coefficient_region_id", "coefficient_region_name", "evaluation_partition", "evaluation_region_id", "evaluation_region_name", "equation", "input_units", "input_preparation", "predictor_min", "predictor_max", "training_count", "data_url"];
  const cell = (value: unknown) => String(value ?? "").replace(/[\t\r\n]+/g, " ");
  const rows = Object.entries(data.models).map(([variable, model]) => [
    variable, ...model.coefficients, data.method, data.direction, data.index,
    data.coefficient_fitting_region.partition, data.coefficient_fitting_region.id, data.coefficient_fitting_region.name,
    data.evaluation_region.partition, data.evaluation_region.id, data.evaluation_region.name,
    data.equation, data.input_units, data.input_preparation,
    model.predictor_min, model.predictor_max, model.training_count, data.data_url,
  ].map(cell).join("\t"));
  return [header.join("\t"), ...rows].join("\n");
}
