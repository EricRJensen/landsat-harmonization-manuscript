from __future__ import annotations

import numpy as np

from harmonization_api.coefficient_build import diagnostics, fit_from_moments


def row_from_values(x: np.ndarray, y: np.ndarray) -> dict[str, float | int]:
    row: dict[str, float | int] = {
        "n": len(x), "x_min": x.min(), "x_max": x.max(),
        "sy": y.sum(), "sy2": np.square(y).sum(),
    }
    for power in range(1, 7):
        row[f"sx{power}"] = np.power(x, power).sum()
    for power in range(4):
        row[f"sxy{power}"] = (np.power(x, power) * y).sum()
    return row


def test_grouped_moment_fit_matches_direct_cubic_ols() -> None:
    x = np.linspace(-0.2, 0.9, 2000)
    y = 0.02 + 0.9 * x + 0.15 * x**2 - 0.08 * x**3
    row = row_from_values(x, y)
    coefficients, _ = fit_from_moments(row, 3)
    assert np.allclose(coefficients, [0.02, 0.9, 0.15, -0.08], atol=1e-8)
    stats = diagnostics(row, coefficients)
    assert stats["rmse"] < 1e-7
    assert stats["r_squared"] > 0.999999


def test_grouped_moment_fit_matches_linear_ols() -> None:
    rng = np.random.default_rng(42)
    x = rng.uniform(-0.1, 0.8, 500)
    y = 0.04 + 0.95 * x + rng.normal(0, 0.01, len(x))
    row = row_from_values(x, y)
    coefficients, _ = fit_from_moments(row, 1)
    direct = np.linalg.lstsq(np.column_stack([np.ones(len(x)), x]), y, rcond=None)[0]
    assert np.allclose(coefficients, direct)

