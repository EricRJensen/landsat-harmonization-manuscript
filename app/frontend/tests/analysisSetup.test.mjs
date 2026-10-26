import assert from "node:assert/strict";
import test from "node:test";
import { analysisSetupUrl, defaultAnalysisSetup, parseAnalysisSetup, readAnalysisSetupUrl, serializeAnalysisSetup, validatePeriod, validatePolygon } from "../src/analysisSetup.ts";
import { apiErrorMessage } from "../src/api.ts";

function selectedSetup() {
  const setup = defaultAnalysisSetup();
  setup.hasChoice = true;
  setup.tab = "map";
  setup.evaluation = { partition: "ecoregion_l2", groupId: "5.3", index: "EVI", direction: "L8_to_L7" };
  setup.config = { partition: "ecoregion_l2", method: "index_cubic", index: "EVI", direction: "L8_to_L7", start_year: 2013, end_year: 2025, significant_only: true, coefficient_partition: "ecoregion_l2", coefficient_group_id: "5.3" };
  setup.view = { longitude: -119.8123456789, latitude: 39.5123456789, zoom: 12.125, bearing: 17, pitch: 30 };
  setup.locationLabel = "Study area near Reno";
  setup.polygon = { vertices: [[-119.8, 39.5], [-119.7, 39.5], [-119.75, 39.6]], closed: true };
  return setup;
}

test("saved JSON and URL restore every setting without cached results", () => {
  const setup = selectedSetup();
  assert.deepEqual(parseAnalysisSetup(serializeAnalysisSetup(setup)), setup);
  const url = new URL(analysisSetupUrl(setup, "http://localhost:5173/?old=setting#old"));
  assert.equal(url.searchParams.has("old"), false);
  assert.equal(url.hash, "");
  assert.deepEqual(readAnalysisSetupUrl(url.search), { setup, warnings: [] });
  assert.equal(Object.hasOwn(parseAnalysisSetup({ ...setup, results: { stale: true } }), "results"), false);
});

test("complete precision and all 100 polygon vertices survive sharing", () => {
  const setup = selectedSetup();
  setup.polygon.vertices = Array.from({ length: 100 }, (_, i) => [-119.8 + .1 * Math.cos(i / 100 * 2 * Math.PI), 39.5 + .1 * Math.sin(i / 100 * 2 * Math.PI)]);
  const url = new URL(analysisSetupUrl(setup, "https://example.test/app"));
  assert.deepEqual(readAnalysisSetupUrl(url.search).setup.polygon, setup.polygon);
  assert.equal(readAnalysisSetupUrl(url.search).setup.polygon.vertices.length, 100);
});

test("legacy links restore their approach and absent coordinates stay absent", () => {
  assert.equal(readAnalysisSetupUrl("").setup.view, undefined);
  const old = readAnalysisSetupUrl("?tab=map&region=ecoregion_l2&group=5.3&index=NDVI&method=index_cubic&direction=L8_to_L7&coefficients=ecoregion_l2&lon=-69.1&lat=45.9");
  assert.equal(old.setup.hasChoice, true);
  assert.equal(old.setup.config.coefficient_group_id, "5.3");
  assert.equal(old.setup.config.direction, "L8_to_L7");
  assert.deepEqual(old.setup.view, { longitude: -69.1, latitude: 45.9, zoom: 10 });
  assert.equal(old.warnings.length, 0);
});

test("malformed links recover safely with an explanation", () => {
  assert.equal(readAnalysisSetupUrl("?lon=&lat=").setup.view, undefined);
  assert.ok(readAnalysisSetupUrl("?lon=bad&lat=34").warnings.length);
  assert.ok(readAnalysisSetupUrl("?region=bad&index=bad").warnings.length);
  const unsupported = readAnalysisSetupUrl(`?setup=${encodeURIComponent('{"version":9}')}`);
  assert.deepEqual(unsupported.setup, defaultAnalysisSetup());
  assert.match(unsupported.warnings[0], /version/i);
  assert.ok(readAnalysisSetupUrl("?setup=%7Bnotjson").warnings.length);
});

test("saved setup validates required fields, periods, coefficient scope and booleans", () => {
  const setup = selectedSetup();
  assert.throws(() => parseAnalysisSetup({ ...setup, config: { ...setup.config, start_year: 2020 } }), /eight years/);
  assert.throws(() => parseAnalysisSetup({ ...setup, config: { ...setup.config, coefficient_group_id: undefined } }), /region identifier/);
  assert.throws(() => parseAnalysisSetup({ ...setup, config: { ...setup.config, significant_only: "false" } }), /true or false/);
  assert.throws(() => parseAnalysisSetup({ ...setup, config: { ...setup.config, index: "NDVI" } }), /do not agree/);
  assert.throws(() => parseAnalysisSetup({ ...setup, polygon: {} }), /closure/);
  assert.throws(() => parseAnalysisSetup({ ...setup, view: { longitude: Infinity, latitude: 20, zoom: 10 } }), /longitude/);
  assert.throws(() => parseAnalysisSetup({ ...setup, config: { ...setup.config, coefficient_group_id: "wrong-region" } }), /do not match the evaluation/);
  assert.throws(() => parseAnalysisSetup({ ...setup, config: { ...setup.config, coefficient_partition: "conus" } }), /CONUS coefficient region/);
  assert.throws(() => parseAnalysisSetup({ ...setup, evaluation: { ...setup.evaluation, partition: "nlcd" } }), /not supported/);
});

test("inconsistent legacy coefficient contexts require a new selection", () => {
  const result = readAnalysisSetupUrl("?region=ecoregion_l2&group=5.3&method=index_linear&coefficients=ecoregion_l3&coefficient_group=bad");
  assert.equal(result.setup.hasChoice, false);
  assert.equal(result.setup.config.coefficient_partition, undefined);
  assert.match(result.warnings.join(" "), /do not match/);
});

test("period validation matches inclusive eight-year rule and supported bounds", () => {
  assert.equal(validatePeriod(2018, 2025), null);
  assert.equal(validatePeriod(1985, 1992), null);
  assert.match(validatePeriod(2020, 2025), /2018 or earlier/);
  assert.match(validatePeriod(1985, 1986), /1992 or later/);
  assert.match(validatePeriod(1984, 2025), /1985 and 2025/);
  assert.match(validatePeriod(NaN, 2025), /whole number/);
  assert.match(validatePeriod(2020.5, 2025), /whole number/);
  assert.match(validatePeriod(2020, 2019), /later/);
});

test("polygon drafts restore and closed rings normalize without losing vertices", () => {
  const setup = selectedSetup();
  setup.polygon.vertices.push([...setup.polygon.vertices[0]]);
  assert.equal(parseAnalysisSetup(setup).polygon.vertices.length, 3);
  setup.polygon = { vertices: [[-119.8, 39.5]], closed: false };
  assert.deepEqual(parseAnalysisSetup(setup).polygon, setup.polygon);
  assert.equal(validatePolygon([], false), null);
  assert.match(validatePolygon([], true), /3–100/);
});

test("polygons reject unsupported extents, invalid coordinates and degeneracy", () => {
  assert.match(validatePolygon([[-119, 39], [-117, 39], [-118, 40]]), /1.5°/);
  assert.match(validatePolygon([[-126, 39], [-125, 39], [-125, 40]]), /CONUS/);
  assert.match(validatePolygon([[-119, 39], [-119, 39.2], [-119, 39.4]]), /nonzero area/);
  assert.match(validatePolygon([[-119, 39], [-119.1, 39.1], [-119, 39.1], [-119.1, 39]]), /nonzero area|cross/);
  assert.match(validatePolygon([[-119, 39], [-119.1, 39.1], [-119, 39.1], [-119, 39.1]]), /repeated/);
  assert.match(validatePolygon([[NaN, 39], [-119, 39], [-119.1, 39]]), /finite numbers/);
});

test("FastAPI validation failures become human-readable messages", () => {
  assert.equal(apiErrorMessage({ detail: [{ loc: ["body"], msg: "Value error, The trend period must span at least eight years" }] }, 422), "The trend period must span at least eight years");
  assert.equal(apiErrorMessage({ detail: [{ loc: ["body", "start_year"], msg: "Input should be greater than or equal to 1985" }] }, 422), "Start year: Input should be greater than or equal to 1985");
  assert.equal(apiErrorMessage({ detail: "Earth Engine is unavailable" }, 503), "Earth Engine is unavailable");
  assert.match(apiErrorMessage({ unexpected: {} }, 500), /could not be completed/);
  assert.equal(apiErrorMessage({ detail: { message: "Try a smaller area" } }, 400), "Try a smaller area");
});
