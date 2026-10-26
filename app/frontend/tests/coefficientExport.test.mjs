import assert from "node:assert/strict";
import test from "node:test";
import { coefficientExport, coefficientsJson, coefficientsTsv } from "../src/coefficientExport.ts";

const exact = [0.012345678901234567, 0.9876543210987654, -0.000000123456789012345, 0.12345678901234567];
for (const direction of ["L7_to_L8", "L8_to_L7"]) {
  for (const method of ["band_linear", "band_cubic", "index_linear", "index_cubic"]) {
    for (const regional of [false, true]) {
      test(`${direction} ${method} ${regional ? "regional" : "CONUS"} export preserves exact values and scope`, () => {
        const values = exact.slice(0, method.endsWith("linear") ? 2 : 4);
        const variables = method.startsWith("band") ? ["B", "G", "R", "NIR", "SWIR1", "SWIR2"] : ["NDVI"];
        const choice = {
          partition: "ecoregion_l2", groupId: "5.3", groupName: "Atlantic Highlands", index: "NDVI", direction,
          alternative: { method, coefficient_partition: regional ? "ecoregion_l2" : "conus", coefficient_group_id: regional ? "5.3" : "CONUS",
            models: Object.fromEntries(variables.map(variable => [variable, { coefficients: values, predictor_min: 0.01, predictor_max: 0.9, n: 100 }])) },
        };
        const json = JSON.parse(coefficientsJson(choice));
        assert.equal(json.direction, direction);
        assert.equal(json.reference_scale, direction === "L7_to_L8" ? "OLI" : "ETM+");
        assert.equal(json.coefficient_fitting_region.id, regional ? "5.3" : "CONUS");
        assert.equal(json.evaluation_region.id, "5.3");
        assert.equal(json.coefficient_order.length, values.length);
        const [header, ...rows] = coefficientsTsv(choice).split("\n").map(row => row.split("\t"));
        assert.equal(rows.length, variables.length);
        for (const [i, row] of rows.entries()) {
          assert.equal(row.length, header.length);
          assert.equal(row[0], variables[i]);
          assert.deepEqual(row.slice(1, values.length + 1).map(Number), values);
          assert.deepEqual(json.models[variables[i]].coefficients, values);
        }
        assert.match(coefficientExport(choice).input_preparation, /0\.0000275 - 0\.2/);
      });
    }
  }
}
