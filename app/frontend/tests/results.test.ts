import test from "node:test";
import assert from "node:assert/strict";
import { areaMeanSlopePerDecade, formatResultValue, polygonAreaSquareKm, significantPixelPercentage } from "../src/results.ts";

test("area-mean API slopes are converted to per decade once", () => {
  assert.equal(areaMeanSlopePerDecade(0.003), 0.03);
  assert.equal(areaMeanSlopePerDecade(-0.003), -0.03);
  assert.equal(areaMeanSlopePerDecade(null), null);
  assert.equal(areaMeanSlopePerDecade(NaN), null);
});

test("missing values and very small values remain distinguishable from zero", () => {
  assert.equal(formatResultValue(null), "Not available");
  assert.equal(formatResultValue(NaN), "Not available");
  assert.equal(formatResultValue(0), "0");
  assert.equal(formatResultValue(0.0000003), "3.00e-7");
});

test("significant proportions combine mutually exclusive categories and preserve absent data", () => {
  const distribution = { pixel_count: 10, class_percentages: { "-3": 10, "-2": 20, "-1": 30, "1": 10, "2": 15, "3": 15 }, boxplot: { low: 0, q1: 0, median: 0, q3: 0, high: 0 } };
  assert.equal(significantPixelPercentage(distribution, "decrease"), 30);
  assert.equal(significantPixelPercentage(distribution, "increase"), 30);
  assert.equal(significantPixelPercentage({ ...distribution, pixel_count: 0 }, "increase"), null);
  assert.equal(significantPixelPercentage(undefined, "increase"), null);
});

test("approximate polygon area handles orientation and holes", () => {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const area = polygonAreaSquareKm({ type: "Polygon", coordinates: [ring] });
  assert.ok(area !== null && Math.abs(area - 12363.7) < 1);
  assert.equal(polygonAreaSquareKm({ type: "Polygon", coordinates: [[...ring].reverse()] }), area);
  assert.equal(polygonAreaSquareKm({ type: "Polygon", coordinates: [ring, ring] }), 0);
});
