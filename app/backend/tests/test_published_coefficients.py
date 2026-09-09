from __future__ import annotations

from harmonization_api.published_coefficients import ROY_2016_OLS, roy_models


def test_roy_2016_ols_contains_both_directions_and_six_bands() -> None:
    assert set(ROY_2016_OLS) == {"L7_to_L8", "L8_to_L7"}
    assert all(set(models) == {"B", "G", "R", "NIR", "SWIR1", "SWIR2"} for models in ROY_2016_OLS.values())
    assert roy_models("L7_to_L8")["SWIR2"]["coefficients"] == [0.0172, 0.9071]
    assert roy_models("L8_to_L7")["NIR"]["coefficients"] == [0.0448, 0.8339]
