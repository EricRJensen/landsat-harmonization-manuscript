from __future__ import annotations

import math
from collections.abc import Mapping

INDEX_NAMES = ("NDVI", "EVI", "MSAVI")
BAND_NAMES = ("B", "G", "R", "NIR", "SWIR1", "SWIR2")


def ndvi(red: float, nir: float) -> float | None:
    denominator = nir + red
    if denominator == 0:
        return None
    return (nir - red) / denominator


def evi(blue: float, red: float, nir: float) -> float | None:
    denominator = nir + 6 * red - 7.5 * blue + 1
    if denominator == 0:
        return None
    return 2.5 * (nir - red) / denominator


def msavi(red: float, nir: float) -> float | None:
    radicand = (2 * nir + 1) ** 2 - 8 * (nir - red)
    if radicand < 0:
        return None
    return (2 * nir + 1 - math.sqrt(radicand)) / 2


def calculate_indices(values: Mapping[str, float]) -> dict[str, float | None]:
    return {
        "NDVI": ndvi(values["R"], values["NIR"]),
        "EVI": evi(values["B"], values["R"], values["NIR"]),
        "MSAVI": msavi(values["R"], values["NIR"]),
    }


def evaluate_polynomial(coefficients: list[float], value: float) -> float:
    return sum(coefficient * value**power for power, coefficient in enumerate(coefficients))


SQL_INDEX_EXPRESSIONS = {
    "NDVI": lambda sensor: (
        f"(({sensor}_NIR - {sensor}_R) / "
        f"nullif({sensor}_NIR + {sensor}_R, 0))"
    ),
    "EVI": lambda sensor: (
        f"(2.5 * ({sensor}_NIR - {sensor}_R) / "
        f"nullif({sensor}_NIR + 6 * {sensor}_R - 7.5 * {sensor}_B + 1, 0))"
    ),
    "MSAVI": lambda sensor: (
        f"(CASE WHEN pow(2 * {sensor}_NIR + 1, 2) - "
        f"8 * ({sensor}_NIR - {sensor}_R) >= 0 THEN "
        f"(2 * {sensor}_NIR + 1 - sqrt(pow(2 * {sensor}_NIR + 1, 2) - "
        f"8 * ({sensor}_NIR - {sensor}_R))) / 2 END)"
    ),
}

