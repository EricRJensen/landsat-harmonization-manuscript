"""
landsat_modis_mk_trends_index_direct.py
=======================================

Pixel-level Mann-Kendall (Theil-Sen slope + Kendall tau p-value) trend analysis of
median JJA NDVI and EVI over a user-supplied AOI, for Landsat and MODIS.

DIRECT INDEX HARMONIZATION variant: each index is computed from RAW (unharmonized)
reflectance, then the INDEX itself is harmonized L5 & L7 -> L8 using index-level
coefficients (from harmonize_ols()/harmonize_poly() fit with metrics = the indices,
direction L7_to_L8). This is the counterpart to the band-harmonization pipeline,
where bands were harmonized first and indices derived afterward.

Outputs (one multi-band GeoTIFF per sensor x period x harmonization):
    <index>_slope : Theil-Sen slope (index units per year)
    <index>_mean  : temporal mean of the annual JJA medians
    <index>_pval  : Mann-Kendall (Kendall tau) two-sided p-value
    <index>_tau   : Kendall tau
    <index>_n     : number of valid annual observations
    nlcd_mode     : (Landsat only) per-pixel mode of Annual NLCD land cover

Landsat is run twice per period: UNHARMONIZED and HARMONIZED.

Trend reducers follow the Climate-Engine-style convention:
    ee.Reducer.sensSlope()            -> Theil-Sen slope
    ee.Reducer.kendallsCorrelation(2) -> Kendall tau + two-sided p-value

Author: built for Alex Brooks (DRI). Set CONFIG, then run build_all() / start tasks.
"""

import ee
import math


# ee.Authenticate()           # run once, interactively
ee.Initialize(project="")


# ==========================================================================
# CONFIG  -- edit this block
# ==========================================================================

# --- Area of interest -----------------------------------------------------
AOI = ee.FeatureCollection("projects/dri-blm/assets/ls-harm/trend_aoi_YELL").geometry()
# e.g. AOI = ee.Geometry.Rectangle([-117.0, 36.0, -116.0, 37.0])

# --- Periods --------------------------------------------------------------
LANDSAT_PERIODS = {
    "2000_2022": (2000, 2022),
 #   "1985_2024": (1985, 2024),
 #   "2010_2024": (2010, 2024),
 #   "1985_2025": (1985, 2025),
 #   "2010_2025": (2010, 2025),
}
MODIS_PERIOD = (2000, 2022)

JJA_MONTHS = (6, 8)          # inclusive calendarRange (Jun-Aug)
MIN_OBS = 8                  # minimum valid annual obs to keep a pixel's trend

# --- Indices --------------------------------------------------------------
INDICES = ["NDVI", "EVI"]            # Landsat harmonization targets + trend bands
MODIS_INDICES = ["NDVI", "EVI"]      # MOD13Q1 native indices (reference only)
# INDICES = ["NDVI"]            # Landsat harmonization targets + trend bands
# MODIS_INDICES = ["NDVI"]      # MOD13Q1 native indices (reference only)


# --- Export ---------------------------------------------------------------
EXPORT_CRS = "EPSG:5070"     # CONUS Albers -> aligns with NLCD; change as needed
LANDSAT_SCALE = 30
MODIS_SCALE = 250
DRIVE_FOLDER = "YELL_CONUS_Poly3_Direct"
MAX_PIXELS = 1e13

# --- NLCD -----------------------------------------------------------------
ANNUAL_NLCD = "projects/sat-io/open-datasets/USGS/ANNUAL_NLCD/LANDCOVER"
NLCD_MODE_START = "2015-01-01"
NLCD_MODE_END = "2024-12-31"

# --- Index harmonization (5 & 7 -> 8) -------------------------------------
# Pick the model form, then fill the matching per-INDEX coefficient table.
#   "linear" : harmonized = intercept + slope * index
#   "poly"   : harmonized = intercept + c1*index + c2*index^2 + ... (raw poly)
# Coefficients come from the INDEX-level R fit (harmonize_*() with
# metrics = the indices, direction L7_to_L8). Indices are ~[-1, 1], so the
# polynomial is well conditioned.
HARMONIZE_MODEL = "poly"          # "linear" or "poly"

# CONUS
# # LINEAR coefficients
# LINEAR_COEFFS = {
#     "NDVI":  {"intercept": 0.0451, "slope": 0.969},
#     "EVI":   {"intercept": 0.0303, "slope": 0.973},
# }

# # POLYNOMIAL 3 coefficients
POLY_COEFFS = {
    # Indices
    "NDVI":  {"intercept": 0.0055, "coeffs": [ 1.23, -0.320,  0.0575]},
    "EVI":   {"intercept": 0.0174, "coeffs": [ 1.08, -0.166,  0.0271]},
}

# Same coefficients used for both L5 and L7 -> give each sensor its own table
# if you have a TM-specific (L5) index fit.
HARMONIZE_SENSORS = ("L5", "L7")

# --- Per-sensor year limits ----------------------------------------------
# Optionally restrict individual sensors to (min_year, max_year), applied IN
# ADDITION to each period's range. Use None for an open bound.
# L7 is capped at 2021 by default to drop the late-mission orbital-drift years
# (degraded WRS-2 acquisition timing before decommissioning). Lower bound is
# left open ("start of L7"), so the period's own y0 governs the early edge.
SENSOR_YEAR_LIMITS = {
    "L7": (None, 2021),
    # "L5": (None, None),   # add others here if needed
}

# ==========================================================================
# LANDSAT: collections, QA/QC, scaling, indices, index harmonization
# ==========================================================================

# Only the bands the three indices need: blue (EVI), red (all), nir (all).
_L57_MAP = {"SR_B1": "blue", "SR_B3": "red", "SR_B4": "nir"}
_L89_MAP = {"SR_B2": "blue", "SR_B4": "red", "SR_B5": "nir"}

_LANDSAT_COLLECTIONS = {
    "L5": ("LANDSAT/LT05/C02/T1_L2", _L57_MAP),
    "L7": ("LANDSAT/LE07/C02/T1_L2", _L57_MAP),
    "L8": ("LANDSAT/LC08/C02/T1_L2", _L89_MAP),
    "L9": ("LANDSAT/LC09/C02/T1_L2", _L89_MAP),
}


def mask_landsat_c2(img):
    """
    Climate-Engine-style Collection 2 Level 2 QA/QC.

    QA_PIXEL bits masked: 1 dilated cloud, 2 cirrus, 3 cloud, 4 cloud shadow,
    5 snow. QA_RADSAT: drop any radiometrically saturated pixel.

    *** Swap point: paste Climate Engine's exact maskLandsat() body here for a
        line-for-line match; the rest of the pipeline is agnostic to it. ***
    """
    qa = img.select("QA_PIXEL")
    bits = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5)
    clear = qa.bitwiseAnd(bits).eq(0)
    not_saturated = img.select("QA_RADSAT").eq(0)
    return img.updateMask(clear).updateMask(not_saturated)


def _scale_sr(img):
    """Apply C2 L2 optical scale/offset -> reflectance fraction (0-1)."""
    return img.multiply(0.0000275).add(-0.2)


def _add_indices(img):
    """Compute NDVI and EVI from reflectance-fraction bands (raw, pre-harmonization)."""
    nir = img.select("nir")
    red = img.select("red")

    ndvi = img.normalizedDifference(["nir", "red"]).rename("NDVI")

    evi = img.expression(
        "2.5 * (NIR - RED) / (NIR + 6.0 * RED - 7.5 * BLUE + 1.0)",
        {"NIR": nir, "RED": red, "BLUE": img.select("blue")},
    ).rename("EVI")

    return img.addBands([ndvi, evi])


def _apply_harmonization(x, coef):
    """Harmonize a single index band: linear or polynomial per HARMONIZE_MODEL."""
    if HARMONIZE_MODEL == "linear":
        return x.multiply(coef["slope"]).add(coef["intercept"])
    elif HARMONIZE_MODEL == "poly":
        # constant intercept, masked to follow the index's own mask
        out = ee.Image.constant(coef["intercept"]).updateMask(x.mask())
        for power, c in enumerate(coef["coeffs"], start=1):
            out = out.add(x.pow(power).multiply(c))
        return out
    else:
        raise ValueError(f"HARMONIZE_MODEL must be 'linear' or 'poly', "
                         f"got {HARMONIZE_MODEL!r}")


def _harmonize_indices(img, sensor):
    """Apply per-index harmonization (sensor in HARMONIZE_SENSORS; else pass-through)."""
    if sensor not in HARMONIZE_SENSORS:
        return img
    coeffs = LINEAR_COEFFS if HARMONIZE_MODEL == "linear" else POLY_COEFFS
    out = img
    for idx in INDICES:
        out = out.addBands(
            _apply_harmonization(img.select(idx), coeffs[idx]).rename(idx),
            overwrite=True,
        )
    return out


def build_landsat_vi_collection(aoi, y0, y1, harmonize):
    """Merged, masked Landsat collection of indices, optionally index-harmonized."""
    merged = ee.ImageCollection([])

    for sensor, (cid, band_map) in _LANDSAT_COLLECTIONS.items():
        # Apply optional per-sensor year cap on top of the period range.
        sy0, sy1 = y0, y1
        lim = SENSOR_YEAR_LIMITS.get(sensor)
        if lim is not None:
            lo, hi = lim
            if lo is not None:
                sy0 = max(sy0, lo)
            if hi is not None:
                sy1 = min(sy1, hi)
        if sy0 > sy1:
            continue  # sensor falls entirely outside this period

        start, end = f"{sy0}-01-01", f"{sy1 + 1}-01-01"
        src = (ee.ImageCollection(cid)
               .filterBounds(aoi)
               .filterDate(start, end)
               .filter(ee.Filter.calendarRange(JJA_MONTHS[0], JJA_MONTHS[1], "month")))

        old_bands = list(band_map.keys())
        new_bands = [band_map[b] for b in old_bands]

        def _prep(img, old=old_bands, new=new_bands, sen=sensor, harm=harmonize):
            img = mask_landsat_c2(img)                      # QA/QC first
            refl = _scale_sr(img.select(old).rename(new))   # -> reflectance
            vi = _add_indices(refl)                         # indices from RAW reflectance
            if harm:
                vi = _harmonize_indices(vi, sen)            # then harmonize the index
            return (vi.select(INDICES)
                    .toFloat()
                    .copyProperties(img, ["system:time_start"])
                    .set("SENSOR", sen))

        merged = merged.merge(src.map(_prep))

    return ee.ImageCollection(merged)

# ==========================================================================
# MODIS: Terra MOD13Q1 (250 m) -- independent reference (NDVI, EVI)
# ==========================================================================

def build_modis_vi_collection(aoi, y0, y1):
    """Terra MOD13Q1 NDVI/EVI, SummaryQA <= 1, scaled to fraction."""
    start, end = f"{y0}-01-01", f"{y1 + 1}-01-01"
    col = (ee.ImageCollection("MODIS/061/MOD13Q1")
           .filterBounds(aoi)
           .filterDate(start, end)
           .filter(ee.Filter.calendarRange(JJA_MONTHS[0], JJA_MONTHS[1], "month")))

    def _prep(img):
        mask = img.select("SummaryQA").lte(1)            # 0 good, 1 marginal
        ndvi = img.select("NDVI").multiply(0.0001).rename("NDVI")
        evi = img.select("EVI").multiply(0.0001).rename("EVI")
        return (ndvi.addBands(evi).updateMask(mask)
                .toFloat()
                .copyProperties(img, ["system:time_start"]))

    return ee.ImageCollection(col.map(_prep))


# ==========================================================================
# Annual JJA median + Mann-Kendall trend
# ==========================================================================

def annual_jja_median(col, y0, y1, indices):
    """One median-JJA composite per year (the given indices + integer 'year' band)."""
    years = ee.List.sequence(y0, y1)

    def _per_year(y):
        y = ee.Number(y)
        yr = col.filter(ee.Filter.calendarRange(y, y, "year"))
        med = yr.select(indices).median().toFloat()
        year_band = ee.Image.constant(y).float().rename("year")
        return (med.addBands(year_band)
                .set("year", y)
                .set("n_scenes", yr.size()))

    annual = ee.ImageCollection(years.map(_per_year))
    return annual.filter(ee.Filter.gt("n_scenes", 0))     # drop empty years


def _trend_for_index(annual, index, min_obs):
    """Theil-Sen slope + temporal mean + Kendall tau + analytical MK p-value + n."""
    ts = annual.map(lambda im: im.select(["year", index]).toFloat())  # [x, y]

    slope = ts.reduce(ee.Reducer.sensSlope()).select("slope").rename(f"{index}_slope")

    mean = annual.select(index).reduce(ee.Reducer.mean()).toFloat().rename(f"{index}_mean")

    tau = (ts.reduce(ee.Reducer.kendallsCorrelation(2))
             .select(0)
             .rename(f"{index}_tau"))

    n = annual.select(index).reduce(ee.Reducer.count()).toFloat().rename(f"{index}_n")

    var_tau = (n.multiply(2).add(5).multiply(2.0)
               .divide(n.multiply(n.subtract(1)).multiply(9.0)))
    z = tau.divide(var_tau.sqrt())
    pval = z.abs().divide(math.sqrt(2)).erfc().rename(f"{index}_pval")

    out = (slope
           .addBands(mean)
           .addBands(tau)
           .addBands(pval)
           .addBands(n))
    return out.updateMask(n.gte(min_obs))


def mk_trend_image(annual, indices, min_obs=MIN_OBS):
    """Stacked trend bands for each index."""
    img = _trend_for_index(annual, indices[0], min_obs)
    for idx in indices[1:]:
        img = img.addBands(_trend_for_index(annual, idx, min_obs))
    return img


# ==========================================================================
# NLCD per-pixel mode
# ==========================================================================

def nlcd_mode(aoi):
    recent = (ee.ImageCollection(ANNUAL_NLCD)
              .filterBounds(aoi)
              .filterDate(NLCD_MODE_START, NLCD_MODE_END)
              .map(lambda i: i.select(0).rename("landcover")))
    return recent.reduce(ee.Reducer.mode()).rename("nlcd_mode")


# ==========================================================================
# Assembly + export
# ==========================================================================

def _export(image, description, scale):
    return ee.batch.Export.image.toDrive(
        image=image.toFloat().clip(AOI),   # <-- unify all bands to Float32
        description=description,
        folder=DRIVE_FOLDER,
        fileNamePrefix=description,
        region=AOI,
        scale=scale,
        crs=EXPORT_CRS,
        maxPixels=MAX_PIXELS,
    )


def build_all(start_tasks=False):
    """
    Build every trend image and its export task.
    Returns {name: {'image': ee.Image, 'task': ee.batch.Task}}.
    Set start_tasks=True to launch them.
    """
    results = {}
    nlcd = nlcd_mode(AOI)

    # ---- Landsat: each period x {unharmonized, harmonized} ----
    for pname, (y0, y1) in LANDSAT_PERIODS.items():
        for harm in (False, True):
            tag = "harm" if harm else "raw"
            name = f"landsat_{pname}_{tag}"
            col = build_landsat_vi_collection(AOI, y0, y1, harm)
            annual = annual_jja_median(col, y0, y1, INDICES)
            img = mk_trend_image(annual, INDICES).addBands(nlcd)
            results[name] = {"image": img, "task": _export(img, name, LANDSAT_SCALE)}

    # ---- MODIS: independent reference (NDVI, EVI) ----
    y0, y1 = MODIS_PERIOD
    col = build_modis_vi_collection(AOI, y0, y1)
    annual = annual_jja_median(col, y0, y1, MODIS_INDICES)
    img = mk_trend_image(annual, MODIS_INDICES)
    name = f"modis_{y0}_{y1}"
    results[name] = {"image": img, "task": _export(img, name, MODIS_SCALE)}

    if start_tasks:
        for name, r in results.items():
            r["task"].start()
            print(f"started: {name}")

    return results


# ==========================================================================
# Optional: small-AOI per-pixel CSV (use only on small AOIs -> 250k px cap)
# ==========================================================================

def export_pixels_csv(image, description, scale):
    """Sample every pixel of `image` to a CSV (lat/lon + band values)."""
    sampled = image.addBands(ee.Image.pixelLonLat()).sample(
        region=AOI, scale=scale, projection=EXPORT_CRS,
        geometries=False, dropNulls=True,
    )
    return ee.batch.Export.table.toDrive(
        collection=sampled, description=description,
        folder=DRIVE_FOLDER, fileFormat="CSV",
    )


if __name__ == "__main__":
    out = build_all(start_tasks=True)
    print("Started tasks:")
    for k in out:
        print(f"  {k}")