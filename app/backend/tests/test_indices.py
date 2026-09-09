from __future__ import annotations

import math

from harmonization_api.indices import calculate_indices, evaluate_polynomial


def test_standard_index_formulas() -> None:
    values = {"B": 0.1, "G": 0.2, "R": 0.2, "NIR": 0.6, "SWIR1": 0.3, "SWIR2": 0.25}
    indices = calculate_indices(values)
    assert math.isclose(indices["NDVI"], 0.5)
    assert math.isclose(indices["EVI"], 2.5 * 0.4 / (0.6 + 1.2 - 0.75 + 1))
    assert math.isclose(indices["MSAVI"], (2.2 - math.sqrt(2.2**2 - 3.2)) / 2)


def test_polynomial_uses_ordinary_power_order() -> None:
    assert evaluate_polynomial([1, 2, 3, 4], 0.5) == 1 + 1 + 0.75 + 0.5
