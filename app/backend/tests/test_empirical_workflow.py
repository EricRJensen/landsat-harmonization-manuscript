from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from harmonization_api.coefficients import CoefficientStore
from harmonization_api.main import api


ARTIFACT = Path(__file__).resolve().parents[1] / "artifacts" / "coefficients.json"


def test_artifact_has_requested_region_catalogs_and_common_validation_population() -> None:
    store = CoefficientStore(ARTIFACT)
    assert store.metadata["schema_version"] == 4
    assert {partition: len(store.regions(partition)) for partition in (
        "ecoregion_l1", "ecoregion_l2", "ecoregion_l3", "huc02"
    )} == {"ecoregion_l1": 10, "ecoregion_l2": 20, "ecoregion_l3": 85, "huc02": 18}

    group_id = store.regions("ecoregion_l1")[0]["id"]
    for direction in ("L7_to_L8", "L8_to_L7"):
        alternatives = store.evaluation("ecoregion_l1", group_id, "NDVI", direction)
        assert len(alternatives) == 10
        assert len({item["n"] for item in alternatives.values()}) == 1
        assert all(len(item["bins"]) == 10 for item in alternatives.values())
    assert (
        store.metadata["directions"]["L8_to_L7"]["mean_difference"]
        == "transformed L8 minus observed L7"
    )


TABLE_1_COEFFICIENTS = {
    "band_linear": {
        "B": [0.0018, 0.8837],
        "G": [0.0054, 0.9139],
        "NIR": [0.0264, 0.9407],
        "R": [0.0013, 0.9387],
        "SWIR1": [0.0167, 0.9271],
        "SWIR2": [0.0111, 0.9384],
    },
    "band_cubic": {
        "B": [0.0085, 0.4979, 5.4321, -20.7359],
        "G": [0.0105, 0.7583, 1.2129, -2.5844],
        "NIR": [0.0142, 1.0444, -0.2235, 0.0833],
        "R": [0.0043, 0.8382, 0.7587, -1.5247],
        "SWIR1": [0.0249, 0.7908, 0.6207, -0.8181],
        "SWIR2": [0.0082, 0.9638, 0.0762, -0.4148],
    },
    "index_linear": {
        "EVI": [0.0303, 0.9734],
        "MSAVI": [0.0308, 0.9776],
        "NDVI": [0.0451, 0.9690],
    },
    "index_cubic": {
        "EVI": [0.0174, 1.0812, -0.1660, 0.0271],
        "MSAVI": [0.0128, 1.1343, -0.2337, 0.0140],
        "NDVI": [0.0055, 1.2289, -0.3197, 0.0575],
    },
}

TABLE_1_METRICS = {
    "EVI": {
        "conus_band_linear": (0.0479, 0.0011),
        "conus_band_cubic": (0.0477, 0.0011),
        "conus_index_linear": (0.0476, -0.0003),
        "conus_index_cubic": (0.0474, -0.0002),
        "unharmonized": (0.0529, -0.0225),
    },
    "MSAVI": {
        "conus_band_linear": (0.0447, -0.0001),
        "conus_band_cubic": (0.0447, -0.0002),
        "conus_index_linear": (0.0446, -0.0003),
        "conus_index_cubic": (0.0440, -0.0001),
        "unharmonized": (0.0513, -0.0248),
    },
    "NDVI": {
        "conus_band_linear": (0.0563, 0.0034),
        # The R script produces 0.0526; Table 1 currently prints 0.0525.
        "conus_band_cubic": (0.0526, 0.0028),
        "conus_index_linear": (0.0497, -0.0013),
        "conus_index_cubic": (0.0484, -0.0005),
        "unharmonized": (0.0598, -0.0314),
    },
}


def test_conus_models_reproduce_table_1() -> None:
    store = CoefficientStore(ARTIFACT)
    conus = store.empirical_group("conus", None, "L7_to_L8")
    assert store.region("conus", None)["training_count"] == 3_286_393
    assert store.region("conus", None)["validation_count"] == 1_406_804

    for method, expected_metrics in TABLE_1_COEFFICIENTS.items():
        family, model = method.split("_")
        degree = "1" if model == "linear" else "3"
        for metric, expected in expected_metrics.items():
            fitted = conus[family][degree][metric]
            assert fitted["n"] == 3_286_393
            assert fitted["coefficients"] == pytest.approx(expected, abs=5e-5)

    for index, expected_methods in TABLE_1_METRICS.items():
        evaluation = store.evaluation("conus", None, index, "L7_to_L8")
        for method, (rmse, mean_difference) in expected_methods.items():
            assert evaluation[method]["rmse"] == pytest.approx(rmse, abs=5e-5)
            assert evaluation[method]["mean_difference"] == pytest.approx(
                mean_difference, abs=5e-5
            )


def test_empirical_endpoints_report_no_fallback_and_valid_random_candidate() -> None:
    client = TestClient(api)
    catalog = client.get("/api/v1/regions", params={"partition": "ecoregion_l1"})
    assert catalog.status_code == 200
    group_id = catalog.json()["regions"][0]["id"]

    for direction in ("L7_to_L8", "L8_to_L7"):
        response = client.get(
            f"/api/v1/evaluations/ecoregion_l1/{group_id}",
            params={"index": "EVI", "direction": direction},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["direction"] == direction
        assert body["fallback_to_conus"] is False
        assert len(body["alternatives"]) == 10
        assert all(item["available"] for item in body["alternatives"])
        roy = next(item for item in body["alternatives"] if item["id"] == "roy_2016_band_ols")
        assert roy["source"] == "published"
        assert roy["regression_type"] == "OLS"
        expected_blue = [0.0003, 0.8474] if direction == "L7_to_L8" else [0.0183, 0.885]
        assert roy["models"]["B"]["coefficients"] == expected_blue

    candidate = client.get(f"/api/v1/regions/ecoregion_l1/{group_id}/random-point")
    assert candidate.status_code == 200
    point = candidate.json()["point"]
    assert -125 <= point["longitude"] <= -66
    assert 24 <= point["latitude"] <= 50
    assert candidate.json()["zoom"] == 10
