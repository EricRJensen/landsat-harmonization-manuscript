import assert from "node:assert/strict";
import test from "node:test";
import { boundsError, mapIdentity, polygonIdentity, RequestGeneration } from "../src/analysisIdentity.ts";
import { api } from "../src/api.ts";

const config = { partition: "ecoregion_l2", method: "index_linear", index: "NDVI", direction: "L7_to_L8", start_year: 1985, end_year: 2025, significant_only: false, coefficient_partition: "conus", coefficient_group_id: "CONUS" };
const polygon = { vertices: [[-119.8, 39.5], [-119.7, 39.5], [-119.7, 39.6]], closed: true };

test("map filter invalidates tiles but preserves the unfiltered polygon analysis", () => {
  const filtered = { ...config, significant_only: true };
  assert.notEqual(mapIdentity(config), mapIdentity(filtered));
  assert.equal(polygonIdentity(polygon, config), polygonIdentity(polygon, filtered));
});

test("scientific settings and outline edits invalidate completed analysis", () => {
  const completed = polygonIdentity(polygon, config);
  for (const change of [{ start_year: 2018 }, { index: "EVI" }, { direction: "L8_to_L7" }, { method: "index_cubic" }, { coefficient_partition: "ecoregion_l2", coefficient_group_id: "5.3" }]) {
    assert.notEqual(polygonIdentity(polygon, { ...config, ...change }), completed);
  }
  assert.notEqual(polygonIdentity({ ...polygon, closed: false }, config), completed);
  assert.notEqual(polygonIdentity({ ...polygon, vertices: [[-119.81, 39.5], ...polygon.vertices.slice(1)] }, config), completed);
  assert.equal(polygonIdentity(structuredClone(polygon), structuredClone(config)), completed);
});

test("cancelled or slower requests cannot replace a newer result", async () => {
  const requests = new RequestGeneration();
  let result;
  let releaseOlder;
  const older = requests.next();
  const slow = new Promise(resolve => { releaseOlder = resolve; }).then(() => {
    if (requests.isCurrent(older)) result = "older";
  });
  const latest = requests.next();
  if (requests.isCurrent(latest)) result = "latest";
  releaseOlder(); await slow;
  assert.equal(result, "latest");
  requests.next();
  assert.equal(requests.isCurrent(latest), false);
});

test("map readiness allows broad views while rejecting invalid locations", () => {
  const coverage = { west: -120, south: 39, east: -119, north: 40 };
  assert.match(boundsError(null), /finish moving/);
  assert.match(boundsError({ ...coverage, west: NaN }), /finish moving/);
  assert.equal(boundsError({ west: -125, east: -66, south: 24, north: 50 }), null);
  assert.match(boundsError({ ...coverage, east: -121 }), /conterminous/);
  assert.equal(boundsError(coverage), null);
});

test("map API requests scientific settings without constraining viewport coverage", async () => {
  const originalFetch = globalThis.fetch;
  const descriptor = { raw: { url: "/api/v1/trend-tiles/scenario/raw/{z}/{x}/{y}.png", minzoom: 7 } };
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), config);
    assert.equal("bbox" in JSON.parse(options.body), false);
    return { ok: true, json: async () => descriptor };
  };
  try {
    assert.deepEqual(await api.maps(config), descriptor);
  } finally { globalThis.fetch = originalFetch; }
});
