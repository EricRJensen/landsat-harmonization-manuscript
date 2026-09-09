from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Landsat Harmonization Explorer"
    ee_project: str | None = None
    coefficient_artifact: Path = BACKEND_DIR / "artifacts" / "coefficients.json"
    region_boundary_dir: Path = BACKEND_DIR / "artifacts" / "region_boundaries"
    sample_parquet: str = str(
        REPO_ROOT
        / "data/external/SR_Landsatsamples_Covariates.parquet"
    )
    ecoregion_asset: str | None = "EPA/Ecoregions/2013/L3"
    huc02_asset: str | None = "USGS/WBD/2017/HUC02"
    ecoregion_l1_field: str = "na_l1code"
    ecoregion_l2_field: str = "na_l2code"
    ecoregion_l3_field: str = "us_l3code"
    huc02_field: str = "huc2"
    frontend_dist: Path = BACKEND_DIR.parent / "frontend" / "dist"
    sample_point_limit: int = 15_000
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origin_list(self) -> list[str]:
        return [value.strip() for value in self.cors_origins.split(",") if value.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
