FROM node:24-alpine AS frontend
WORKDIR /build/frontend
COPY app/frontend/package.json app/frontend/package-lock.json ./
RUN npm ci
COPY app/frontend/ ./
RUN npm run build

FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8080
WORKDIR /app/backend
RUN groupadd --gid 1000 appuser && useradd --uid 1000 --gid appuser --create-home appuser
COPY app/backend/pyproject.toml ./
COPY app/backend/src ./src
RUN pip install --no-cache-dir .
COPY app/backend/artifacts ./artifacts
COPY --from=frontend /build/frontend/dist /app/frontend/dist
ENV SAMPLE_PARQUET=/data/SR_Landsatsamples_Covariates.parquet \
    COEFFICIENT_ARTIFACT=/app/backend/artifacts/coefficients.json \
    REGION_BOUNDARY_DIR=/app/backend/artifacts/region_boundaries \
    FRONTEND_DIST=/app/frontend/dist
USER appuser
CMD uvicorn harmonization_api.main:api --host 0.0.0.0 --port ${PORT} --workers 1
