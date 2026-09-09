#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-landsat-harmonization}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-landsat-harmonization}"
REPOSITORY="${REPOSITORY:-web-apps}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-landsat-harmonization-web}"
BUCKET="${BUCKET:-coincident-etm-oli-points}"
PARQUET_OBJECT="${PARQUET_OBJECT:-SR_Landsatsamples_Covariates.parquet}"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:latest"

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  earthengine.googleapis.com \
  --project="${PROJECT_ID}"

if ! gcloud iam service-accounts describe "${RUNTIME_SA}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Landsat Harmonization web runtime"
fi

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/storage.objectViewer"

for role in roles/earthengine.viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="${role}" \
    --condition=None >/dev/null
done

if ! gcloud artifacts repositories describe "${REPOSITORY}" \
  --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --repository-format=docker \
    --description="Web application container images"
fi

BUILD_SA="$(gcloud builds get-default-service-account --project="${PROJECT_ID}")"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/cloudbuild.builds.builder" \
  --condition=None >/dev/null
gcloud artifacts repositories add-iam-policy-binding "${REPOSITORY}" \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/artifactregistry.writer" >/dev/null

gcloud builds submit . \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --config=app/cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}"

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --service-account="${RUNTIME_SA}" \
  --allow-unauthenticated \
  --execution-environment=gen2 \
  --cpu=2 \
  --memory=4Gi \
  --concurrency=4 \
  --timeout=300 \
  --min-instances=0 \
  --max-instances=3 \
  --set-env-vars="EE_PROJECT=${PROJECT_ID},SAMPLE_PARQUET=/data/${PARQUET_OBJECT}" \
  --add-volume="name=sample-data,type=cloud-storage,bucket=${BUCKET},readonly=true" \
  --add-volume-mount="volume=sample-data,mount-path=/data"

gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)'
