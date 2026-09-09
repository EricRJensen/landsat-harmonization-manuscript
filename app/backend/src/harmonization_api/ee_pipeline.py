from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Any

import ee

from .coefficients import CoefficientStore
from .settings import Settings

COMMON_BANDS = ("blue", "green", "red", "nir", "swir1", "swir2")
COLLECTIONS = {
    "L5": ("LANDSAT/LT05/C02/T1_L2", ("SR_B1", "SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B7")),
    "L7": ("LANDSAT/LE07/C02/T1_L2", ("SR_B1", "SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B7")),
    "L8": ("LANDSAT/LC08/C02/T1_L2", ("SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7")),
    "L9": ("LANDSAT/LC09/C02/T1_L2", ("SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7")),
}
HARMONIZED_SENSORS = {
    "L7_to_L8": ("L5", "L7"),
    "L8_to_L7": ("L8", "L9"),
}
# Exclusive science-mission cutoffs used by the manuscript. Collection 2 can
# contain acquisitions after these dates, but they are intentionally excluded
# from merged composites and individual-sensor summaries.
SENSOR_END_EXCLUSIVE = {
    "L5": "2012-01-01",
    "L7": "2022-01-01",
}
NLCD_ASSET = "projects/sat-io/open-datasets/USGS/ANNUAL_NLCD/LANDCOVER"
MIN_OBSERVATIONS = 8
CONUS_BOUNDS = (-125.0, 24.0, -66.0, 50.0)


class EarthEngineConfigurationError(RuntimeError):
    pass


@lru_cache
def initialize_earth_engine(project: str | None) -> str:
    if not project:
        raise EarthEngineConfigurationError("EE_PROJECT is not configured")
    ee.Initialize(project=project)
    try:
        ee.data.setDefaultWorkloadTag("landsat-harmonization-app")
    except (AttributeError, ValueError):
        pass
    return project


def mask_and_scale(image: ee.Image, source_bands: tuple[str, ...]) -> ee.Image:
    qa = image.select("QA_PIXEL")
    obscured_bits = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5)
    clear = qa.bitwiseAnd(obscured_bits).eq(0)
    optical_not_saturated = image.select("QA_RADSAT").bitwiseAnd(0x7F).eq(0)
    reflectance = (
        image.updateMask(clear)
        .updateMask(optical_not_saturated)
        .select(list(source_bands), list(COMMON_BANDS))
        .multiply(0.0000275)
        .add(-0.2)
    )
    return ee.Image(reflectance.copyProperties(image, ["system:time_start", "system:index"]))


def add_index(image: ee.Image, index: str, name: str) -> ee.Image:
    image = ee.Image(image)
    if index == "NDVI":
        result = image.normalizedDifference(["nir", "red"])
    elif index == "EVI":
        result = image.expression(
            "2.5 * (nir - red) / (nir + 6 * red - 7.5 * blue + 1)",
            {
                "nir": image.select("nir"),
                "red": image.select("red"),
                "blue": image.select("blue"),
            },
        )
    elif index == "MSAVI":
        result = image.expression(
            "(2 * nir + 1 - sqrt((2 * nir + 1) ** 2 - 8 * (nir - red))) / 2",
            {"nir": image.select("nir"), "red": image.select("red")},
        )
    else:
        raise ValueError(f"Unsupported index: {index}")
    return result.rename(name)


def polynomial(image: ee.Image, coefficients: list[ee.Image | float]) -> ee.Image:
    image = ee.Image(image)
    result = ee.Image.constant(0)
    for power, coefficient in enumerate(coefficients):
        result = result.add(image.pow(power).multiply(coefficient))
    return result


class LandsatPipeline:
    def __init__(self, settings: Settings, coefficients: CoefficientStore):
        initialize_earth_engine(settings.ee_project)
        self.settings = settings
        self.coefficient_store = coefficients

    def _static_partition(self, partition: str) -> tuple[str, str]:
        if partition in ("ecoregion_l1", "ecoregion_l2", "ecoregion_l3"):
            if not self.settings.ecoregion_asset:
                raise EarthEngineConfigurationError("ECOREGION_ASSET is required for this partition")
            field = {
                "ecoregion_l1": self.settings.ecoregion_l1_field,
                "ecoregion_l2": self.settings.ecoregion_l2_field,
                "ecoregion_l3": self.settings.ecoregion_l3_field,
            }[partition]
            return self.settings.ecoregion_asset, field
        if partition == "huc02":
            if not self.settings.huc02_asset:
                raise EarthEngineConfigurationError("HUC02_ASSET is required for this partition")
            return self.settings.huc02_asset, self.settings.huc02_field
        raise EarthEngineConfigurationError(f"No static asset mapping for {partition}")

    def _coefficient_image(
        self,
        partition: str,
        method: str,
        metric: str,
        power: int,
        year: ee.Number | None,
        direction: str = "L7_to_L8",
        fixed_partition: str | None = None,
        fixed_group_id: str | None = None,
    ) -> ee.Image:
        if fixed_partition is not None:
            group_id = "CONUS" if fixed_partition == "conus" else fixed_group_id
            group = self.coefficient_store.empirical_group(
                fixed_partition, group_id, direction
            )
            family, degree_name = method.split("_")
            degree = "1" if degree_name == "linear" else "3"
            value = group[family][degree][metric]["coefficients"][power]
            return ee.Image.constant(value)
        if partition != "nlcd":
            return self._static_coefficient_image(
                partition, method, metric, power, direction
            )

        groups = self.coefficient_store.groups(partition, direction)
        conus_groups = self.coefficient_store.groups("conus", direction)
        family, degree_name = method.split("_")
        degree = "1" if degree_name == "linear" else "3"
        fallback = conus_groups["CONUS"][family][degree][metric]["coefficients"][power]
        values: dict[str, float] = {}
        for group_id, group in groups.items():
            model = group.get(family, {}).get(degree, {}).get(metric)
            if model is not None:
                values[str(group_id)] = model["coefficients"][power]

        if year is None:
            raise ValueError("NLCD coefficient lookup requires an image year")
        landcover = (
            ee.ImageCollection(NLCD_ASSET)
            .filter(ee.Filter.eq("year", year))
            .first()
            .select(0)
        )
        keys = [int(key) for key in values]
        mapped = landcover.remap(keys, [values[str(key)] for key in keys], fallback)
        return mapped.unmask(fallback)

    @lru_cache(maxsize=512)
    def _static_coefficient_image(
        self,
        partition: str,
        method: str,
        metric: str,
        power: int,
        direction: str = "L7_to_L8",
    ) -> ee.Image:
        """Build each non-annual coefficient raster once per API process."""
        groups = self.coefficient_store.groups(partition, direction)
        conus_groups = self.coefficient_store.groups("conus", direction)
        family, degree_name = method.split("_")
        degree = "1" if degree_name == "linear" else "3"
        fallback = conus_groups["CONUS"][family][degree][metric]["coefficients"][power]
        if partition == "conus":
            return ee.Image.constant(fallback)

        values: dict[str, float] = {}
        for group_id, group in groups.items():
            model = group.get(family, {}).get(degree, {}).get(metric)
            if model is not None:
                values[str(group_id)] = model["coefficients"][power]

        asset, field = self._static_partition(partition)
        dictionary = ee.Dictionary(values)
        collection = ee.FeatureCollection(asset).map(
            lambda feature: ee.Feature(feature).set(
                "harm_coef",
                dictionary.get(ee.String(ee.Feature(feature).get(field)), fallback),
            )
        )
        return collection.reduceToImage(["harm_coef"], ee.Reducer.first()).unmask(fallback)

    def _harmonize(
        self,
        reflectance: ee.Image,
        partition: str,
        method: str,
        index: str,
        year: ee.Number,
        direction: str = "L7_to_L8",
        fixed_partition: str | None = None,
        fixed_group_id: str | None = None,
    ) -> ee.Image:
        family, degree_name = method.split("_")
        coefficient_count = 2 if degree_name == "linear" else 4
        if family == "band":
            output: ee.Image | None = None
            artifact_names = ("B", "G", "R", "NIR", "SWIR1", "SWIR2")
            for band, artifact_name in zip(COMMON_BANDS, artifact_names):
                coefficients = [
                    self._coefficient_image(
                        partition, method, artifact_name, power, year,
                        direction, fixed_partition, fixed_group_id
                    )
                    for power in range(coefficient_count)
                ]
                transformed = polynomial(reflectance.select(band), coefficients).rename(band)
                output = transformed if output is None else output.addBands(transformed)
            if output is None:
                raise ValueError("No band transforms were constructed")
            return add_index(output, index, "harm")

        raw = add_index(reflectance, index, "raw")
        coefficients = [
            self._coefficient_image(
                partition, method, index, power, year,
                direction, fixed_partition, fixed_group_id
            )
            for power in range(coefficient_count)
        ]
        return polynomial(raw, coefficients).rename("harm")

    def sensor_collection(
        self,
        sensor: str,
        partition: str,
        method: str,
        index: str,
        direction: str,
        start_year: int,
        end_year: int,
        output: str = "both",
        geometry: ee.Geometry | None = None,
        fixed_partition: str | None = None,
        fixed_group_id: str | None = None,
    ) -> ee.ImageCollection:
        collection_id, source_bands = COLLECTIONS[sensor]
        source = (
            ee.ImageCollection(collection_id)
            .filterDate(f"{start_year}-01-01", f"{end_year + 1}-01-01")
            .filter(ee.Filter.calendarRange(4, 9, "month"))
        )
        if geometry is not None:
            source = source.filterBounds(geometry)
        if sensor in SENSOR_END_EXCLUSIVE:
            source = source.filter(
                ee.Filter.lt(
                    "system:time_start",
                    ee.Date(SENSOR_END_EXCLUSIVE[sensor]).millis(),
                )
            )

        def prepare(image: ee.Image) -> ee.Image:
            image = ee.Image(image)
            reflectance = mask_and_scale(image, source_bands)
            raw = add_index(reflectance, index, "raw")
            if output == "raw":
                result = raw.rename("value")
            elif sensor in HARMONIZED_SENSORS[direction]:
                year = ee.Number(image.date().get("year"))
                harm = self._harmonize(
                    reflectance, partition, method, index, year,
                    direction, fixed_partition, fixed_group_id
                )
                result = harm.rename("value") if output == "harm" else raw.addBands(harm)
            else:
                harm = raw.rename("harm")
                result = harm.rename("value") if output == "harm" else raw.addBands(harm)
            return ee.Image(
                result.toFloat().copyProperties(image, ["system:time_start", "system:index"]).set(
                    "sensor", sensor
                )
            )

        return ee.ImageCollection(source.map(prepare))

    @staticmethod
    def annual(
        collection: ee.ImageCollection,
        start_year: int,
        end_year: int,
        bands: tuple[str, ...] = ("raw", "harm"),
    ) -> ee.ImageCollection:
        images: list[ee.Image] = []
        for year in range(start_year, end_year + 1):
            # Literal filterDate ranges can use the collection time index. A
            # server-side calendarRange inside List.map repeatedly scanned the
            # full multi-sensor archive and exceeded interactive tile memory.
            subset = collection.filterDate(f"{year}-01-01", f"{year + 1}-01-01")
            empty = ee.Image.constant([0] * len(bands)).rename(list(bands)).updateMask(ee.Image.constant(0))
            image = ee.Image(ee.Algorithms.If(subset.size().gt(0), subset.median(), empty))
            images.append(image.set(
                {
                    "year": year,
                    "scene_count": subset.size(),
                    "system:time_start": ee.Date.fromYMD(year, 7, 1).millis(),
                }
            ))
        return ee.ImageCollection.fromImages(images)

    def merged_collection(
        self,
        partition: str,
        method: str,
        index: str,
        direction: str,
        start_year: int,
        end_year: int,
        output: str,
        geometry: ee.Geometry | None = None,
        fixed_partition: str | None = None,
        fixed_group_id: str | None = None,
    ) -> ee.ImageCollection:
        merged = ee.ImageCollection([])
        for sensor in COLLECTIONS:
            merged = merged.merge(
                self.sensor_collection(
                    sensor, partition, method, index, direction, start_year, end_year,
                    output=output, geometry=geometry,
                    fixed_partition=fixed_partition, fixed_group_id=fixed_group_id
                )
            )
        return merged

    def annual_collections(
        self,
        partition: str,
        method: str,
        index: str,
        direction: str,
        start_year: int,
        end_year: int,
        geometry: ee.Geometry | None = None,
        fixed_partition: str | None = None,
        fixed_group_id: str | None = None,
    ) -> tuple[ee.ImageCollection, dict[str, ee.ImageCollection]]:
        sensors = {
            sensor: self.sensor_collection(
                sensor, partition, method, index, direction, start_year, end_year, geometry=geometry,
                fixed_partition=fixed_partition, fixed_group_id=fixed_group_id
            )
            for sensor in COLLECTIONS
        }
        merged = ee.ImageCollection([])
        for collection in sensors.values():
            merged = merged.merge(collection)
        return self.annual(merged, start_year, end_year), {
            sensor: self.annual(collection, start_year, end_year)
            for sensor, collection in sensors.items()
        }

    @staticmethod
    def trend(
        annual: ee.ImageCollection,
        band: str,
        prefix: str,
        include_significance: bool = True,
    ) -> ee.Image:
        pairs = annual.map(
            lambda image: ee.Image.constant(ee.Number(ee.Image(image).get("year")))
            .toFloat()
            .rename("year")
            .addBands(ee.Image(image).select(band).toFloat().rename("value"))
        )
        slope = pairs.reduce(ee.Reducer.sensSlope()).select("slope").rename(f"{prefix}_slope")
        count = annual.select(band).reduce(ee.Reducer.count()).toFloat().rename(f"{prefix}_n")
        output = slope.addBands(count).updateMask(count.gte(MIN_OBSERVATIONS))
        if not include_significance:
            return output
        tau = pairs.reduce(ee.Reducer.kendallsCorrelation(2)).select("tau").rename(f"{prefix}_tau")
        variance = count.multiply(2).add(5).multiply(2).divide(
            count.multiply(count.subtract(1)).multiply(9)
        )
        p_value = tau.divide(variance.sqrt()).abs().divide(math.sqrt(2)).erfc().rename(f"{prefix}_p")
        return output.addBands([tau, p_value])

    def trend_image(
        self,
        partition: str,
        method: str,
        index: str,
        direction: str,
        start_year: int,
        end_year: int,
    ) -> ee.Image:
        annual, _ = self.annual_collections(
            partition,
            method,
            index,
            direction,
            start_year,
            end_year,
            geometry=ee.Geometry.Rectangle(CONUS_BOUNDS, geodesic=False),
        )
        raw = self.trend(annual, "raw", "raw")
        harm = self.trend(annual, "harm", "harm")
        difference = harm.select("harm_slope").subtract(raw.select("raw_slope")).rename("difference_slope")
        return raw.addBands(harm).addBands(difference)

    @staticmethod
    def _tile(image: ee.Image, minimum: float, maximum: float) -> dict[str, Any]:
        palette = ["#b2182b", "#f7f7f7", "#2166ac"]
        map_id = image.getMapId({"min": minimum, "max": maximum, "palette": palette})
        return {
            "url": map_id["tile_fetcher"].url_format,
            "min": minimum,
            "max": maximum,
            "palette": palette,
        }

    @lru_cache(maxsize=32)
    def map_tiles(
        self,
        partition: str,
        method: str,
        index: str,
        direction: str,
        start_year: int,
        end_year: int,
        significant_only: bool,
        bounds: tuple[float, float, float, float] | None = None,
        fixed_partition: str | None = None,
        fixed_group_id: str | None = None,
    ) -> dict[str, Any]:
        # Build and composite the source archive once. The old implementation
        # constructed independent raw and harmonized 40-year graphs, doubling
        # the Landsat archive fanout and exceeding EE's interactive memory limit.
        analysis_bounds = bounds or CONUS_BOUNDS
        geometry = ee.Geometry.Rectangle(analysis_bounds, geodesic=False)
        annual, _ = self.annual_collections(
            partition,
            method,
            index,
            direction,
            start_year,
            end_year,
            geometry=geometry,
            fixed_partition=fixed_partition,
            fixed_group_id=fixed_group_id,
        )
        raw_trend = self.trend(annual, "raw", "raw", significant_only)
        harm_trend = self.trend(annual, "harm", "harm", significant_only)
        # Present trends per decade to match the scientific figures while the
        # underlying Theil–Sen regression remains in index units per year.
        raw = raw_trend.select("raw_slope").multiply(10).clip(geometry)
        harm = harm_trend.select("harm_slope").multiply(10).clip(geometry)
        difference = harm.subtract(raw).rename("difference_slope")
        if significant_only:
            raw = raw.updateMask(raw_trend.select("raw_p").lte(0.05))
            harm = harm.updateMask(harm_trend.select("harm_p").lte(0.05))
            difference = difference.updateMask(
                raw_trend.select("raw_p").lte(0.05).And(harm_trend.select("harm_p").lte(0.05))
            )
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                "raw": executor.submit(self._tile, raw, -0.05, 0.05),
                "harmonized": executor.submit(self._tile, harm, -0.05, 0.05),
                "difference": executor.submit(self._tile, difference, -0.03, 0.03),
            }
            tiles = {name: future.result() for name, future in futures.items()}
        return {
            **tiles,
            "units": f"{index} per decade",
            "bounds": analysis_bounds,
            "fixed_coefficients": fixed_partition is not None,
        }

    @staticmethod
    def _sample_features(
        annual: ee.ImageCollection,
        geometry: ee.Geometry,
        series: str,
        bands: list[str],
    ) -> ee.FeatureCollection:
        size = annual.size()
        images = annual.toList(size)

        def sample(value: ee.Image) -> ee.Feature:
            image = ee.Image(value)
            values = image.select(bands).reduceRegion(
                reducer=ee.Reducer.first(), geometry=geometry, scale=30
            )
            return ee.Feature(None, values).set(
                {"series": series, "year": image.get("year"), "scene_count": image.get("scene_count")}
            )

        return ee.FeatureCollection(images.map(sample))

    @lru_cache(maxsize=256)
    def time_series(
        self,
        partition: str,
        method: str,
        index: str,
        direction: str,
        start_year: int,
        end_year: int,
        longitude: float,
        latitude: float,
        fixed_partition: str | None = None,
        fixed_group_id: str | None = None,
    ) -> list[dict[str, Any]]:
        point = ee.Geometry.Point([longitude, latitude])
        annual, sensors = self.annual_collections(
            partition, method, index, direction, start_year, end_year, geometry=point,
            fixed_partition=fixed_partition, fixed_group_id=fixed_group_id
        )
        features = self._sample_features(annual, point, "merged", ["raw", "harm"])
        for sensor, collection in sensors.items():
            features = features.merge(self._sample_features(collection, point, sensor, ["raw", "harm"]))
        payload = features.getInfo()
        return [feature["properties"] for feature in payload.get("features", [])]

    @staticmethod
    def _mean_rows(
        annual: ee.ImageCollection,
        geometry: ee.Geometry,
        series: str,
        bands: list[str],
        start_year: int,
        end_year: int,
    ) -> list[dict[str, Any]]:
        # A reduceRegion mapped over every annual image creates hundreds of
        # concurrent aggregations. Stack years as bands and spatially reduce
        # once per collection instead.
        stacked: ee.Image | None = None
        for year in range(start_year, end_year + 1):
            image = ee.Image(annual.filter(ee.Filter.eq("year", year)).first()).select(bands)
            renamed = image.rename([f"{band}_{year}" for band in bands])
            stacked = renamed if stacked is None else stacked.addBands(renamed)
        if stacked is None:
            return []
        values = stacked.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=geometry,
            scale=30,
            maxPixels=20_000_000,
            tileScale=4,
        ).getInfo()
        scene_counts = annual.aggregate_array("scene_count").getInfo()
        return [
            {
                "series": series,
                "year": year,
                "scene_count": int(scene_counts[year - start_year]),
                **{band: values.get(f"{band}_{year}") for band in bands},
            }
            for year in range(start_year, end_year + 1)
        ]

    def polygon_analysis(
        self,
        partition: str,
        method: str,
        index: str,
        direction: str,
        start_year: int,
        end_year: int,
        coordinates: tuple[tuple[float, float], ...],
        fixed_partition: str | None = None,
        fixed_group_id: str | None = None,
    ) -> dict[str, Any]:
        """Summarize annual values and pixel trends for one bounded polygon."""
        geometry = ee.Geometry.Polygon([list(coordinates)], geodesic=False)
        annual, sensors = self.annual_collections(
            partition,
            method,
            index,
            direction,
            start_year,
            end_year,
            geometry=geometry,
            fixed_partition=fixed_partition,
            fixed_group_id=fixed_group_id,
        )
        rows = self._mean_rows(
            annual, geometry, "merged", ["raw", "harm"], start_year, end_year
        )
        for sensor, collection in sensors.items():
            rows.extend(
                self._mean_rows(
                    collection, geometry, sensor, ["raw", "harm"], start_year, end_year
                )
            )

        raw_trend = self.trend(annual, "raw", "raw")
        harm_trend = self.trend(annual, "harm", "harm")
        summaries: dict[str, Any] = {}
        for prefix, trend in (("raw", raw_trend), ("harmonized", harm_trend)):
            slope = trend.select(f"{prefix if prefix == 'raw' else 'harm'}_slope").multiply(10).rename("trend")
            p_value = trend.select(f"{prefix if prefix == 'raw' else 'harm'}_p")
            boxplot_values = slope.reduceRegion(
                reducer=ee.Reducer.percentile(
                    [5, 25, 50, 75, 95], ["low", "q1", "median", "q3", "high"]
                ),
                geometry=geometry,
                scale=90,
                maxPixels=2_000_000,
                tileScale=4,
            )
            boxplot = ee.Dictionary({
                "low": boxplot_values.get("trend_low"),
                "q1": boxplot_values.get("trend_q1"),
                "median": boxplot_values.get("trend_median"),
                "q3": boxplot_values.get("trend_q3"),
                "high": boxplot_values.get("trend_high"),
            })
            trend_class = (
                ee.Image.constant(0)
                .where(slope.lt(0).And(p_value.gt(0.05)), -1)
                .where(slope.lt(0).And(p_value.lte(0.05)).And(p_value.gt(0.01)), -2)
                .where(slope.lt(0).And(p_value.lte(0.01)), -3)
                .where(slope.gte(0).And(p_value.gt(0.05)), 1)
                .where(slope.gte(0).And(p_value.lte(0.05)).And(p_value.gt(0.01)), 2)
                .where(slope.gte(0).And(p_value.lte(0.01)), 3)
                .updateMask(slope.mask().And(p_value.mask()))
                .rename("class")
            )
            histogram = trend_class.reduceRegion(
                reducer=ee.Reducer.frequencyHistogram(),
                geometry=geometry,
                scale=90,
                maxPixels=2_000_000,
                tileScale=4,
            ).get("class")
            # Resolve one source at a time to prevent Earth Engine from
            # scheduling raw and harmonized reductions concurrently.
            summaries[prefix] = ee.Dictionary({"boxplot": boxplot, "classes": histogram}).getInfo()

        return {
            "rows": rows,
            "trend_distributions": summaries,
        }

    @lru_cache(maxsize=256)
    def point_strata(
        self,
        partition: str,
        start_year: int,
        end_year: int,
        longitude: float,
        latitude: float,
    ) -> dict[str, Any]:
        if partition == "conus":
            return {"active_group": "CONUS", "by_year": {}}
        point = ee.Geometry.Point([longitude, latitude])
        if partition == "nlcd":
            years = ee.List.sequence(start_year, end_year)

            def sample_year(value: ee.Number) -> ee.Feature:
                year = ee.Number(value)
                image = ee.Image(ee.ImageCollection(NLCD_ASSET).filter(ee.Filter.eq("year", year)).first())
                selected = image.select(0)
                result = selected.reduceRegion(ee.Reducer.first(), point, 30).get(
                    ee.String(selected.bandNames().get(0))
                )
                return ee.Feature(None, {"year": year, "group_id": result})

            payload = ee.FeatureCollection(years.map(sample_year)).getInfo()
            by_year = {
                str(feature["properties"]["year"]): feature["properties"].get("group_id")
                for feature in payload.get("features", [])
            }
            active = next((str(value) for value in reversed(list(by_year.values())) if value is not None), None)
            return {"active_group": active, "by_year": by_year}
        asset, field = self._static_partition(partition)
        value = ee.Feature(ee.FeatureCollection(asset).filterBounds(point).first()).get(field).getInfo()
        return {"active_group": str(value) if value is not None else None, "by_year": {}}
