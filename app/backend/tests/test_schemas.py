import pytest
from pydantic import ValidationError

from harmonization_api.schemas import AnalysisRequest, PolygonAnalysisRequest


def test_analysis_period_requires_eight_years() -> None:
    with pytest.raises(ValidationError):
        AnalysisRequest(start_year=2019, end_year=2025)


def test_eight_year_period_is_valid() -> None:
    value = AnalysisRequest(start_year=2018, end_year=2025)
    assert value.end_year - value.start_year + 1 == 8


def test_analysis_request_accepts_visible_bounds() -> None:
    value = AnalysisRequest(
        bbox={"west": -115, "south": 42, "east": -113, "north": 44}
    )
    assert value.bbox is not None
    assert value.bbox.west == -115


def test_analysis_request_accepts_reverse_harmonization() -> None:
    value = AnalysisRequest(direction="L8_to_L7")
    assert value.direction == "L8_to_L7"


def test_analysis_request_rejects_unknown_direction() -> None:
    with pytest.raises(ValidationError):
        AnalysisRequest(direction="L9_to_L5")


def test_polygon_analysis_accepts_small_closed_conus_polygon() -> None:
    value = PolygonAnalysisRequest(
        geometry={
            "type": "Polygon",
            "coordinates": [[[-114.2, 42.7], [-114.1, 42.7], [-114.1, 42.8], [-114.2, 42.7]]],
        }
    )
    assert value.geometry.coordinates[0][0] == value.geometry.coordinates[0][-1]


def test_polygon_analysis_rejects_unbounded_extent() -> None:
    with pytest.raises(ValidationError):
        PolygonAnalysisRequest(
            geometry={
                "type": "Polygon",
                "coordinates": [[[-120, 40], [-110, 40], [-110, 41], [-120, 40]]],
            }
        )
