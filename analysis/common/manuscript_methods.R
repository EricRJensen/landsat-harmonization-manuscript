suppressPackageStartupMessages({
  library(dplyr)
  library(tidyr)
})

bands <- c("B", "G", "R", "NIR", "SWIR1", "SWIR2")
indices <- c("NDVI", "EVI", "MSAVI")

add_indices <- function(data) {
  data |>
    mutate(
      L7_NDVI = (L7_NIR - L7_R) / (L7_NIR + L7_R),
      L8_NDVI = (L8_NIR - L8_R) / (L8_NIR + L8_R),
      L7_EVI = 2.5 * (L7_NIR - L7_R) /
        (L7_NIR + 6 * L7_R - 7.5 * L7_B + 1),
      L8_EVI = 2.5 * (L8_NIR - L8_R) /
        (L8_NIR + 6 * L8_R - 7.5 * L8_B + 1),
      L7_MSAVI = (2 * L7_NIR + 1 -
        sqrt((2 * L7_NIR + 1)^2 - 8 * (L7_NIR - L7_R))) / 2,
      L8_MSAVI = (2 * L8_NIR + 1 -
        sqrt((2 * L8_NIR + 1)^2 - 8 * (L8_NIR - L8_R))) / 2
    )
}

legacy_coefficient_training <- function(data, assert_count = TRUE) {
  result <- data |>
    filter(split < 0.7, !is.na(nlcd_landcover), !is.na(ecoregion_l1_name)) |>
    add_indices()
  if (assert_count) stopifnot(nrow(result) == 3286393L)
  result
}

legacy_reported_validation <- function(data, assert_count = TRUE) {
  result <- data |>
    filter(split >= 0.7, !is.na(nlcd_landcover), !is.na(ecoregion_l1_name)) |>
    add_indices()
  if (assert_count) stopifnot(nrow(result) == 1406804L)
  result
}

legacy_reported_bias <- function(data, assert_count = TRUE) {
  result <- data |>
    filter(split < 0.7) |>
    drop_na() |>
    add_indices() |>
    filter(is.finite(L7_NDVI), between(L7_NDVI, 0, 1))
  if (assert_count) stopifnot(nrow(result) == 3263523L)
  result
}

fit_one <- function(data, metric, direction, degree) {
  source_sensor <- if (direction == "L7_to_L8") "L7" else "L8"
  target_sensor <- if (direction == "L7_to_L8") "L8" else "L7"
  source <- paste0(source_sensor, "_", metric)
  target <- paste0(target_sensor, "_", metric)
  model_data <- data |>
    transmute(x = .data[[source]], y = .data[[target]]) |>
    filter(is.finite(x), is.finite(y))
  formula <- if (degree == 1) y ~ x else y ~ poly(x, degree, raw = TRUE)
  fit <- lm(formula, data = model_data)
  tibble(
    approach_metric = metric,
    direction = direction,
    degree = degree,
    term = paste0("x", seq_along(coef(fit)) - 1L),
    estimate = unname(coef(fit)),
    n = nrow(model_data)
  )
}

fit_harmonization <- function(data, metrics, degrees = c(1L, 3L)) {
  grid <- tidyr::crossing(
    metric = metrics,
    direction = c("L7_to_L8", "L8_to_L7"),
    degree = degrees
  )
  purrr::pmap_dfr(
    grid,
    function(metric, direction, degree) fit_one(data, metric, direction, degree)
  )
}

coefficient_vector <- function(fits, metric, direction, degree) {
  fits |>
    filter(
      approach_metric == metric,
      .data$direction == .env$direction,
      .data$degree == .env$degree
    ) |>
    arrange(term) |>
    pull(estimate)
}

evaluate_polynomial <- function(x, coefficients) {
  Reduce(`+`, Map(function(coef, power) coef * x^power,
    coefficients, seq_along(coefficients) - 1L))
}

validation_metrics <- function(observed, predicted) {
  keep <- is.finite(observed) & is.finite(predicted)
  residual <- predicted[keep] - observed[keep]
  tibble(
    n = sum(keep),
    rmse = sqrt(mean(residual^2)),
    mean_difference = mean(residual)
  )
}

ensure_input <- function(path) {
  if (!file.exists(path)) {
    stop(
      "Required input is unavailable: ", path, "\n",
      "Generate the input with the corresponding extraction script or see README.md."
    )
  }
}
