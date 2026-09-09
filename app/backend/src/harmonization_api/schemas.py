from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Partition = Literal["conus", "ecoregion_l1", "ecoregion_l2", "ecoregion_l3", "huc02", "nlcd"]
Method = Literal["band_linear", "band_cubic", "index_linear", "index_cubic"]
IndexName = Literal["NDVI", "EVI", "MSAVI"]
HarmonizationDirection = Literal["L7_to_L8", "L8_to_L7"]


class BoundingBox(BaseModel):
    west: float = Field(ge=-180, le=180)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)

    @model_validator(mode="after")
    def ordered(self) -> "BoundingBox":
        if self.west >= self.east or self.south >= self.north:
            raise ValueError("Bounding box coordinates are not ordered")
        return self


class AnalysisRequest(BaseModel):
    partition: Partition = "conus"
    method: Method = "band_linear"
    index: IndexName = "NDVI"
    direction: HarmonizationDirection = "L7_to_L8"
    start_year: int = Field(default=1985, ge=1985, le=2025)
    end_year: int = Field(default=2025, ge=1985, le=2025)
    significant_only: bool = False
    bbox: BoundingBox | None = None
    coefficient_partition: Partition | None = None
    coefficient_group_id: str | None = None

    @model_validator(mode="after")
    def validate_period(self) -> "AnalysisRequest":
        if self.end_year - self.start_year + 1 < 8:
            raise ValueError("The trend period must span at least eight years")
        if self.coefficient_partition not in (None, "conus") and not self.coefficient_group_id:
            raise ValueError("A fixed regional coefficient selection requires coefficient_group_id")
        return self


class TimeseriesRequest(AnalysisRequest):
    longitude: float = Field(ge=-125, le=-66)
    latitude: float = Field(ge=24, le=50)
    include_harmonized_sensors: bool = False


class PolygonGeometry(BaseModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[list[float]]]

    @model_validator(mode="after")
    def validate_polygon(self) -> "PolygonGeometry":
        if len(self.coordinates) != 1:
            raise ValueError("Polygon holes are not supported")
        ring = self.coordinates[0]
        if not 4 <= len(ring) <= 101:
            raise ValueError("Polygon must contain 3–100 vertices and a closing coordinate")
        if ring[0] != ring[-1]:
            raise ValueError("Polygon ring must be closed")
        for coordinate in ring:
            if len(coordinate) != 2:
                raise ValueError("Every polygon coordinate must contain longitude and latitude")
            longitude, latitude = coordinate
            if not (-125 <= longitude <= -66 and 24 <= latitude <= 50):
                raise ValueError("Polygon coordinates must fall within CONUS")
        longitudes = [coordinate[0] for coordinate in ring]
        latitudes = [coordinate[1] for coordinate in ring]
        if max(longitudes) - min(longitudes) > 1.5 or max(latitudes) - min(latitudes) > 1.5:
            raise ValueError("Polygon extent must be no larger than 1.5 degrees in either dimension")
        return self


class PolygonAnalysisRequest(AnalysisRequest):
    geometry: PolygonGeometry


class SampleQuery(BaseModel):
    bbox: BoundingBox
    zoom: float = Field(ge=0, le=22)
    index: IndexName = "NDVI"
    year: int | None = Field(default=None, ge=2013, le=2021)
    month: int | None = Field(default=None, ge=4, le=10)
    partition: Partition | None = None
    category: str | None = None

    @field_validator("category")
    @classmethod
    def category_length(cls, value: str | None) -> str | None:
        if value is not None and len(value) > 128:
            raise ValueError("Category is too long")
        return value
