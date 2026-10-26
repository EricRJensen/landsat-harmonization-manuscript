# Landsat Harmonization Explorer

The app is organized as a two-step scientific workflow:

- **Explore & Choose** first selects the reference sensor (L7→L8 or L8→L7), then compares unharmonized, the published Roy et al. (2016) band-level OLS benchmark, four CONUS, and four selected-region strategies on one common held-out population. Method tables report RMSE, mean bias, and improvements; equations and binned diagnostics remain available as supporting detail without calling Earth Engine.
- **Map & Analyze** applies the exact chosen coefficient set uniformly to the visible Earth Engine viewport, compares unharmonized and harmonized trends with a slider, and summarizes polygon-mean merged/per-sensor time series plus pixel-level trend distributions. The difference map opens separately.

Select an approach in Explore to access **Copy coefficients** (spreadsheet-ready TSV) or **Copy JSON**. Both preserve the full numeric precision supplied by the API and include the formula, coefficient order, direction, fitting region, evaluation region, reflectance scaling, and study data link. Map & Analyze retains a summary of the selected approach. Regional choices start with an explicit selection, with a boundary preview to orient the user.

Map position and polygon outlines persist across tabs. Draw the outline on the map and click the first vertex to close it. Edit, Undo, and Clear allow the outline to be revised. Polygon outlines support 3–100 vertices within CONUS and a maximum span of 1.5° in each direction. Changing an outline or scientific settings marks previous results as needing recalculation. The significance filter affects map layers only; polygon summaries include all evaluated pixels.

Previously saved setup links and legacy parameter links remain supported. Opening a link restores inputs; maps and analysis must be calculated again. Save, download, and import controls are no longer part of the interface.

Offsets in the sample view are always **Landsat 8 minus Landsat 7**. Forward harmonization transforms Landsat 5/7 to the Landsat 8/9 OLI reference; reverse harmonization uses independently fitted regressions to transform Landsat 8/9 to the Landsat 7 ETM+ reference. Reverse cubic models are not algebraic inversions of the forward equations.

## Local setup

From the repository root:

```bash
python3 -m venv app/backend/.venv
app/backend/.venv/bin/python -m pip install -e 'app/backend[test]'
cd app/frontend && npm install && cd ../..
```

Authenticate to Earth Engine through the normal developer workflow outside the application, then set the Cloud project:

```bash
export EE_PROJECT=landsat-harmonization
```

Build or refresh the coefficient artifact from the local parquet:

```bash
app/backend/.venv/bin/build-coefficients
```

Run the API and frontend in separate terminals:

```bash
cd app/backend
EE_PROJECT=landsat-harmonization .venv/bin/uvicorn harmonization_api.main:api --reload --port 8000
```

```bash
cd app/frontend
npm run dev
```

Open `http://localhost:5173`. API documentation is at `http://localhost:8000/docs`.

Trend tiles are served as image bytes on the app origin to avoid cross-origin redirect failures. Successful images are browser-cacheable for one hour; failed upstream responses are not cached. Versioned tile URLs bypass redirects cached by older builds. Trend tiles load automatically as users pan; there is no viewport clip or **Rebuild for this view** action. The XYZ service builds and caches Earth Engine map IDs per layer for fixed zoom-7 geographic blocks, coalesces concurrent requests, and refreshes IDs after two hours. Duplicate requests await shared work without occupying the API worker pool; two dedicated map workers limit simultaneous graph builds. Raw tiles are reused across harmonization choices, and difference tiles are built only when requested. Loading indicators track the trend source independently of basemap tiles. Each block filters the source scenes to its full extent, without clipping or region-masking the output image. Trend rasters display at zoom 7–13; broader overview views show a zoom-in prompt. The selected evaluation region is outlined on both maps, with dark-gray shading outside it as a separate display-only GeoJSON layer. Region holes and islands are preserved, and shared internal borders are dissolved. Raster coverage and polygon analysis are independent of the display-only region overlay.

The trend map can run with the public Earth Engine assets configured by default:

- `EPA/Ecoregions/2013/L3` for Level II and III ecoregions.
- `USGS/WBD/2017/HUC02` for HUC02.
- `projects/sat-io/open-datasets/USGS/ANNUAL_NLCD/LANDCOVER` for annual NLCD 1985–2025.

Override the IDs and property fields with environment variables if a deployment requires pinned private copies. The app never starts exports or asset-ingestion tasks.

## Data builds

The private Cloud Storage source of truth is:

```bash
gs://coincident-etm-oli-points/SR_Landsatsamples_Covariates.parquet
```

`build-coefficients` reads the repository-local parquet by default. To refresh that
copy before rebuilding the artifact:

```bash
gcloud storage cp \
  gs://coincident-etm-oli-points/SR_Landsatsamples_Covariates.parquet \
  data/external/SR_Landsatsamples_Covariates.parquet
app/backend/.venv/bin/build-coefficients
```

The version-4 artifact records the source checksum, sample-selection rules, both independently fitted model directions, region catalogs, candidate points, coefficient equations, and held-out/binned diagnostics. It contains CONUS, Level I, Level II, Level III, HUC02, and legacy NLCD models. Empirical choices below 1,000 training pairs are marked unavailable and never silently fall back to CONUS; fallback remains only for backward-compatible dynamic map requests.

In the regional diagnostics panel, Level I coefficients can be evaluated within a nested Level II or III ecoregion, and Level II coefficients within a nested Level III ecoregion. The dropdown updates all three charts and their data tables while retaining the parent region's fitted coefficients. “Entire region” restores the original evaluation. This diagnostic selection does not change the chosen harmonization approach or map settings.

Nested evaluations use the existing `SAMPLE_PARQUET` paired observations and the same held-out filters, common valid comparison population, index calculations, and bins as the artifact build. They are calculated on demand and cached in memory; the coefficient artifact is not modified. Hierarchy choices come from explicit parent codes in the local ecoregion boundaries. The API exposes `GET /api/v1/region-guide/{partition}/{group_id}/children` and accepts `coefficient_partition` and `coefficient_group_id` on the evaluation endpoint to distinguish the fitting region from the evaluation region.

Coefficient fitting follows the manuscript workflow: April–October observations
must have NLCD and Level I ecoregion values, with `split < 0.7` used for fitting.
This gives the 3,286,393 CONUS training observations used to calculate Table 1
and Table S5. Dashboard validation applies the corresponding `split >= 0.7`
filter and retains observations whose unharmonized source index is in `[0,1]`,
matching the validation calculation in
`analysis/figure_02_s01_s03_tables_01_s05_harmonization.R`. Every alternative
for a selected region and direction is scored on identical rows. Mean bias is
transformed source minus observed target, and bias improvement is the percent
reduction in its absolute magnitude relative to the unharmonized baseline.
Earth Engine mapping uses April–September annual medians and excludes Landsat 7
from 2022 onward.

The regional explorer models use the same base sample-selection rules as the
CONUS manuscript coefficients, followed by the selected region membership.

For high-traffic deployment, create a static PMTiles sample archive. This requires `tippecanoe` and the `pmtiles` CLI:

```bash
cd app/backend
.venv/bin/build-sample-tiles --output artifacts/landsat_samples.pmtiles
```

The local app intentionally queries only the visible parquet viewport, capped at 15,000 features. The PMTiles output is intended for Cloud Storage/CDN hosting when public traffic makes direct parquet queries inappropriate.

## Checks

```bash
app/backend/.venv/bin/python -m pytest app/backend/tests -q
npm --prefix app/frontend run build
node --experimental-strip-types --test app/frontend/tests/*.test.mjs app/frontend/tests/*.test.ts
```

Area extraction combines scene counts and spatial means in each Earth Engine response, reduces only the displayed raw individual-sensor values, and skips seasons outside each sensor's availability while preserving explicit missing-year rows. Merged raw/harmonized records, QA masks, April–September medians, 30 m spatial means, 90 m distributions, minimum observation counts, and trend/significance calculations are unchanged. Completed area analyses are cached for 30 minutes (32 entries per process); concurrent identical requests share one computation in a separate two-worker pool. Cache keys include the exact geometry and all scientific settings, but exclude the map-only significance toggle. Failed jobs are retriable. Earth Engine initialization also runs off the event loop.

Bounded checks on 2026-10-19 are recorded in `review/performance-2026-10-19/`: a ~0.004° square near Death Valley took 48.55 → 28.37 seconds for 1985–2025 and 12.05 → 7.87 seconds for 2013–2020. Formatted outputs matched exactly, including missing values and pixel counts. A single zoom-11 raw tile (1985–2025) took 55.48 → 15.04 seconds including map-ID creation; PNG bytes were identical. Harmonized and difference tiles also matched for EVI, reverse adjustment, index cubic coefficients, and significance filtering. These are single-run wall times with unknown Earth Engine cache state, not EECU measurements or guaranteed production latencies. The first-season constants follow the [Landsat 7](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LE07_C02_T1_L2), [Landsat 8](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC08_C02_T1_L2), and [Landsat 9](https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC09_C02_T1_L2) catalogs; Landsat 9's first April–September season is 2022.

Earth Engine smoke checks should use a point or regional AOI first. A nationwide 1985–2025 map-ID request still exceeds the interactive memory envelope. Continuous browsing therefore uses bounded source-scene blocks behind a stable tile URL, rather than one nationwide computation graph. Precomputed annual scenario composites remain the deployment path for nationwide overview rasters and higher traffic.

## Cloud Run deployment

Initial page delivery uses gzip and immutable caching for Vite's content-hashed
assets; HTML revalidates on each visit. MapLibre and ECharts load when needed,
and the banner/footer use WebP assets. Statistical imports are deferred until
an area summary is requested. Paired-map metadata is cached per process.
HTTP concurrency is 80 to accommodate simultaneous trend-tile waiters;
uncached parquet reads share a two-query limit. Minimum instances remains 0,
so the first visit after scale-to-zero can still incur a cold start.

The React bundle is compiled into the FastAPI container and served from the same
origin, so the initial production architecture is one Cloud Run service. Firebase
Hosting is optional and is not needed for the first deployment.

The deployment uses project `landsat-harmonization` in `us-central1`, a dedicated
runtime service account, and a read-only Cloud Storage volume. The private bucket is
mounted at `/data`, and `SAMPLE_PARQUET` points to the mounted file. This keeps the
579 MB parquet out of the container image and avoids long-lived storage keys.

Review and run the repeatable deployment script from the repository root:

```bash
bash app/deploy-cloud-run.sh
```

The script enables Cloud Run, Cloud Build, and Artifact Registry; creates the
runtime service account and container repository if missing; grants only Storage
Object Viewer, Earth Engine Resource Viewer, and Service Usage Consumer to the
runtime identity; builds the image; and deploys a public Cloud Run service. The
Cloud project must be registered for Earth Engine before deployment.

After deployment, verify both the static UI and API:

```bash
SERVICE_URL="$(gcloud run services describe landsat-harmonization \
  --project=landsat-harmonization --region=us-central1 \
  --format='value(status.url)')"
curl --fail "$SERVICE_URL/api/v1/health"
curl --fail "$SERVICE_URL/api/v1/sample-map/config" >/dev/null
open "$SERVICE_URL"
```

For higher traffic, build and host the PMTiles archive instead of querying the
parquet for every sample-map request, and add shared caching/rate limiting before
raising the instance limit. If cold trend tiles miss the latency target, batch-export
versioned annual three-index composites for the finite partition/method scenarios,
then compute arbitrary trend ranges from those annual assets.

### Custom domain and map rendering

The public Explorer domain is `https://app.landsat-harmonization.earth/`.
Cloud Run maps that hostname to the `landsat-harmonization` service; Squarespace
DNS has a CNAME named `app` pointing to `ghs.googlehosted.com`. Google manages
its HTTPS certificate. The existing `run.app` address remains available.

Keep HTTP concurrency at 80: map views issue many simultaneous tile requests
that wait asynchronously on shared Earth Engine map-ID builds. The two map
workers and two parquet-query slots continue to bound expensive work. A limit
of eight caused production tile bursts to fail with “no available instance.”

MapLibre CSS is loaded with the lazy map chunk. The `.map-surface.maplibregl-map`
selector must preserve absolute positioning regardless of stylesheet load order;
otherwise MapLibre's `position: relative` collapses the map containers to zero
height in production. This also applies to the difference-map modal.


Polygon reductions allow up to 200 million pixels for 30 m area-mean time
series and 20 million pixels for 90 m trend distributions, ten times the previous
limits. The existing 1.5° outline span remains in place. Exceeding a reduction's
pixel budget returns an actionable message with the required and allowed pixel
counts. Resolution, masks, annual composites, and summary calculations are
unchanged; larger areas can still take longer or encounter Earth Engine runtime
limits.


The trend-class legend and data table list decreases first, then increases;
each direction runs from non-significant through significant at p ≤ 0.05 to
significant at p ≤ 0.01. The desktop legend aligns the two directions in rows
with matching significance columns; narrow screens use one column. The 0.05
classes contain only 0.01 < p ≤ 0.05, keeping categories mutually exclusive.
Zero slopes remain grouped with increases. These display names and legend
ordering do not change the classification thresholds or diverging bar stacks.


The shared footer uses 11 px vertical padding and a 52 px logo frame, retaining
the 104 px logo image and existing link sizes. Desktop height is 77 px rather
than 119 px (35.3% less). Narrow screens arrange resources in two columns.
