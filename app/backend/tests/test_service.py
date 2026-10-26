import pytest

from harmonization_api.service import format_polygon_analysis, format_timeseries, trend_summary


def test_trend_summary_loads_statistics_when_needed() -> None:
    rows = [{"year": year, "raw": 0.2 + 0.01 * (year - 2000)} for year in range(2000, 2010)]
    result = trend_summary(rows, "raw")
    assert result["n"] == 10
    assert result["slope"] == pytest.approx(0.01)
    assert result["intercept"] == pytest.approx(-19.8)
    assert result["tau"] == pytest.approx(1)
    assert result["p_value"] == pytest.approx(2 / 3_628_800)


def test_format_timeseries_does_not_mutate_cached_rows() -> None:
    rows = [
        {"series": "merged", "year": 2020, "raw": 0.2, "harm": 0.21, "scene_count": 4},
        {"series": "L7", "year": 2020, "raw": 0.19, "harm": 0.2, "scene_count": 2},
    ]

    first = format_timeseries(rows, include_harmonized_sensors=False)
    second = format_timeseries(rows, include_harmonized_sensors=False)

    assert first == second
    assert rows[0]["series"] == "merged"
    assert rows[1]["harm"] == 0.2
    assert "harm" not in first["series"]["L7"][0]


def test_format_polygon_analysis_converts_class_counts_to_percentages() -> None:
    payload = {
        "rows": [
            {"series": "merged", "year": 2020, "raw": 0.2, "harm": 0.21, "scene_count": 4},
        ],
        "trend_distributions": {
            "raw": {
                "boxplot": {"low": -0.1, "q1": -0.02, "median": 0, "q3": 0.02, "high": 0.1},
                "classes": {"-1": 25, "3": 75},
            }
        },
    }

    result = format_polygon_analysis(payload)

    assert result["trend_distributions"]["raw"]["pixel_count"] == 100
    assert result["trend_distributions"]["raw"]["class_percentages"]["-1"] == 25
    assert result["trend_distributions"]["raw"]["class_percentages"]["3"] == 75
