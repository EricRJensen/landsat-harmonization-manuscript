from __future__ import annotations

from typing import Final


ROY_2016_ID: Final = "roy_2016_band_ols"

# Band-level OLS transformations from Roy et al. (2016). Coefficients are
# ordered as [intercept, slope] and use surface reflectance on a 0–1 scale.
ROY_2016_OLS: Final[dict[str, dict[str, tuple[float, float]]]] = {
    "L7_to_L8": {
        "B": (0.0003, 0.8474),
        "G": (0.0088, 0.8483),
        "R": (0.0061, 0.9047),
        "NIR": (0.0412, 0.8462),
        "SWIR1": (0.0254, 0.8937),
        "SWIR2": (0.0172, 0.9071),
    },
    "L8_to_L7": {
        "B": (0.0183, 0.8850),
        "G": (0.0123, 0.9317),
        "R": (0.0123, 0.9372),
        "NIR": (0.0448, 0.8339),
        "SWIR1": (0.0306, 0.8639),
        "SWIR2": (0.0116, 0.9165),
    },
}


def roy_models(direction: str) -> dict[str, dict[str, object]]:
    """Return API-shaped models for displaying the published equations."""
    return {
        band: {
            "coefficients": list(coefficients),
            "n": 0,
            "predictor_min": 0.0,
            "predictor_max": 1.0,
        }
        for band, coefficients in ROY_2016_OLS[direction].items()
    }
