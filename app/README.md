# Landsat Harmonization Explorer

The app is organized as a two-step scientific workflow:

- **Explore & Choose** first selects the reference scale (L7→L8 or L8→L7), then compares unharmonized, the published Roy et al. (2016) band-level OLS benchmark, four CONUS, and four selected-region strategies on one common held-out population. Method tables report RMSE, mean bias, and improvements; equations and binned diagnostics remain available as supporting detail without calling Earth Engine.
- **Apply on Map** applies the exact chosen coefficient set uniformly to the visible Earth Engine viewport, compares raw and harmonized trends, and summarizes polygon-mean merged/per-sensor time series plus pixel-level trend distributions.

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

Trend layers are evaluated for the current map viewport. Zoom until the view spans at most 6° longitude and latitude, then select **Update trend map**. Keeping the interactive analysis regional prevents multi-decade annual composites from exceeding Earth Engine's online memory limit; the deployment roadmap below describes the precomputed assets needed for seamless nationwide trends.

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

The version-3 artifact records the source checksum, split/month rules, both independently fitted model directions, region catalogs, candidate points, coefficient equations, and held-out/binned diagnostics. It contains CONUS, Level I, Level II, Level III, HUC02, and legacy NLCD models. Empirical choices below 1,000 training pairs are marked unavailable and never silently fall back to CONUS; fallback remains only for backward-compatible dynamic map requests.

Dashboard validation uses April–October rows with `split >= 0.7`, finite predictors, and the selected direction's target index in `[0,1]`. Every alternative for a selected region and direction is scored on identical rows. Mean bias is transformed source minus observed target, and bias improvement is the percent reduction in its absolute magnitude relative to the unharmonized baseline. Earth Engine mapping uses April–September annual medians and excludes Landsat 7 from 2022 onward.

These explorer rules are intentionally broader than the manuscript's legacy,
output-specific row profiles. The explorer artifact uses all raw training rows
meeting its finite-value requirements; see `../REPRODUCIBILITY_NOTES.md` before
comparing app coefficients with manuscript tables.

For high-traffic deployment, create a static PMTiles sample archive. This requires `tippecanoe` and the `pmtiles` CLI:

```bash
cd app/backend
.venv/bin/build-sample-tiles --output artifacts/landsat_samples.pmtiles
```

The local app intentionally queries only the visible parquet viewport, capped at 15,000 features. The PMTiles output is intended for Cloud Storage/CDN hosting when public traffic makes direct parquet queries inappropriate.

## Checks

```bash
cd app/backend && .venv/bin/pytest -q
cd app/frontend && npm run build
```

Earth Engine smoke checks should use a point or regional AOI first. Map-ID creation for a full multi-decade CONUS trend exceeds the interactive memory envelope, so local map requests are bounded to the visible viewport and cached in each API process. The deployment roadmap should precompute annual scenario composites for nationwide browsing.

## Cloud Run deployment

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
