#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(ggplot2)
  library(patchwork)
  library(readr)
  library(tidyr)
})
source("analysis/common/manuscript_methods.R")

sample_path <- "data/external/SR_Landsatsamples_Covariates.parquet"
output_dir <- "output"
ensure_input(sample_path)
dir.create(file.path(output_dir, "figures"), recursive = TRUE, showWarnings = FALSE)
dir.create(file.path(output_dir, "tables"), recursive = TRUE, showWarnings = FALSE)

all_samples <- read_parquet(sample_path)
training <- legacy_coefficient_training(all_samples)
validation <- legacy_reported_validation(all_samples)

band_fits <- fit_harmonization(training, bands)
index_fits <- fit_harmonization(training, indices)
all_fits <- bind_rows(
  mutate(band_fits, approach = "Band"),
  mutate(index_fits, approach = "Index")
)
write_csv(all_fits, file.path(output_dir, "tables", "harmonization_coefficients_full_precision.csv"))

coefficient_table <- all_fits |>
  mutate(model = if_else(degree == 1L, "Linear", "Poly-3")) |>
  select(direction, approach, model, metric = approach_metric, term, estimate, n)
write_csv(
  filter(coefficient_table, direction == "L7_to_L8"),
  file.path(output_dir, "tables", "table_01_etm_to_oli_coefficients.csv")
)
write_csv(
  filter(coefficient_table, direction == "L8_to_L7"),
  file.path(output_dir, "tables", "table_s05_oli_to_etm_coefficients.csv")
)

predict_band_route <- function(data, metric, degree) {
  transformed <- list()
  required <- switch(metric, NDVI = c("R", "NIR"), EVI = c("B", "R", "NIR"), MSAVI = c("R", "NIR"))
  for (band in required) {
    coefs <- coefficient_vector(band_fits, band, "L7_to_L8", degree)
    transformed[[band]] <- evaluate_polynomial(data[[paste0("L7_", band)]], coefs)
  }
  switch(metric,
    NDVI = (transformed$NIR - transformed$R) / (transformed$NIR + transformed$R),
    EVI = 2.5 * (transformed$NIR - transformed$R) /
      (transformed$NIR + 6 * transformed$R - 7.5 * transformed$B + 1),
    MSAVI = (2 * transformed$NIR + 1 - sqrt(
      (2 * transformed$NIR + 1)^2 - 8 * (transformed$NIR - transformed$R)
    )) / 2
  )
}

validation_rows <- list()
prediction_rows <- list()
binned_rows <- list()
for (metric in indices) {
  source <- validation[[paste0("L7_", metric)]]
  observed <- validation[[paste0("L8_", metric)]]
  metric_keep <- is.finite(source) & is.finite(observed) & source >= 0 & source <= 1
  for (degree in c(1L, 3L)) {
    model <- if (degree == 1L) "Linear" else "Poly-3"
    band_prediction <- predict_band_route(validation, metric, degree)
    index_prediction <- evaluate_polynomial(
      source,
      coefficient_vector(index_fits, metric, "L7_to_L8", degree)
    )
    for (approach in c("Band", "Index")) {
      prediction <- if (approach == "Band") band_prediction else index_prediction
      stats <- validation_metrics(observed[metric_keep], prediction[metric_keep])
      validation_rows[[length(validation_rows) + 1L]] <- stats |>
        mutate(metric = metric, approach = approach, model = model, .before = 1)
      set.seed(42 + degree + match(metric, indices) + match(approach, c("Band", "Index")))
      eligible <- which(metric_keep & is.finite(prediction))
      selected <- sample(eligible, min(50000L, length(eligible)))
      prediction_rows[[length(prediction_rows) + 1L]] <- tibble(
        metric = metric,
        approach = approach,
        model = model,
        source = source[selected],
        observed = observed[selected],
        predicted = prediction[selected]
      )
      if (metric == "NDVI") {
        binned_rows[[length(binned_rows) + 1L]] <- tibble(
          source = source[metric_keep],
          residual = prediction[metric_keep] - observed[metric_keep]
        ) |>
          mutate(source_bin = cut(source, breaks = seq(0, 1, 0.1), include.lowest = TRUE)) |>
          filter(!is.na(source_bin), is.finite(residual)) |>
          group_by(source_bin) |>
          summarise(rmse = sqrt(mean(residual^2)), mean_difference = mean(residual), .groups = "drop") |>
          mutate(approach = approach, model = model)
      }
    }
  }
  baseline <- validation_metrics(observed[metric_keep], source[metric_keep])
  validation_rows[[length(validation_rows) + 1L]] <- baseline |>
    mutate(metric = metric, approach = "None", model = "Unharmonized", .before = 1)
  if (metric == "NDVI") {
    binned_rows[[length(binned_rows) + 1L]] <- tibble(
      source = source[metric_keep],
      residual = source[metric_keep] - observed[metric_keep]
    ) |>
      mutate(source_bin = cut(source, breaks = seq(0, 1, 0.1), include.lowest = TRUE)) |>
      filter(!is.na(source_bin), is.finite(residual)) |>
      group_by(source_bin) |>
      summarise(rmse = sqrt(mean(residual^2)), mean_difference = mean(residual), .groups = "drop") |>
      mutate(approach = "None", model = "Unharmonized")
  }
}
validation_summary <- bind_rows(validation_rows)
write_csv(validation_summary, file.path(output_dir, "tables", "table_01_validation_metrics.csv"))

make_validation_figure <- function(metric, filename, width = 10, height = 7) {
  metric_predictions <- bind_rows(prediction_rows) |>
    filter(.data$metric == .env$metric)
  comparison <- ggplot(metric_predictions, aes(observed, predicted)) +
    geom_hex(bins = 70) +
    geom_abline(slope = 1, intercept = 0, linetype = "dashed", color = "white") +
    facet_grid(approach ~ model) +
    coord_equal(xlim = c(0, 1), ylim = c(0, 1)) +
    scale_fill_viridis_c(trans = "log10") +
    labs(x = paste("Observed OLI", metric), y = paste("Predicted OLI", metric), fill = "Count") +
    theme_minimal(base_size = 10)
  metrics_plot <- validation_summary |>
    filter(.data$metric == .env$metric) |>
    pivot_longer(c(rmse, mean_difference), names_to = "statistic", values_to = "value") |>
    ggplot(aes(interaction(approach, model, sep = "\n"), value, fill = approach)) +
    geom_col() +
    facet_wrap(~statistic, scales = "free_y") +
    labs(x = NULL, y = NULL, fill = NULL) +
    theme_minimal(base_size = 10) +
    theme(axis.text.x = element_text(angle = 35, hjust = 1), legend.position = "bottom")
  combined <- comparison / metrics_plot + plot_layout(heights = c(3, 1.2))
  ggsave(file.path(output_dir, "figures", filename), combined, width = width, height = height, dpi = 600, bg = "white")
}

make_validation_figure("EVI", "figure_s01.png", 10, 7)
make_validation_figure("MSAVI", "figure_s02.png", 10, 7)

make_fit_panel <- function(metric, fits, title, limits) {
  set.seed(42 + match(metric, c("R", "NIR", "NDVI")))
  sampled <- training |>
    transmute(x = .data[[paste0("L7_", metric)]], y = .data[[paste0("L8_", metric)]]) |>
    filter(is.finite(x), is.finite(y))
  sampled <- slice_sample(sampled, n = min(100000L, nrow(sampled)))
  grid <- tibble(x = seq(limits[[1]], limits[[2]], length.out = 300))
  curves <- bind_rows(lapply(c(1L, 3L), function(degree) {
    coefficients <- coefficient_vector(fits, metric, "L7_to_L8", degree)
    grid |>
      mutate(y = evaluate_polynomial(x, coefficients), model = if_else(degree == 1L, "Linear", "Poly-3"))
  }))
  ggplot(sampled, aes(x, y)) +
    geom_hex(bins = 70) +
    geom_abline(slope = 1, intercept = 0, linetype = "dotted", color = "white") +
    geom_line(data = curves, aes(x, y, color = model), inherit.aes = FALSE, linewidth = 0.9) +
    coord_cartesian(xlim = limits, ylim = limits) +
    scale_fill_viridis_c(trans = "log10", guide = "none") +
    scale_color_manual(values = c(Linear = "#1b9e77", `Poly-3` = "#d95f02")) +
    labs(title = title, x = paste("ETM+", metric), y = paste("OLI", metric), color = NULL) +
    theme_minimal(base_size = 9) + theme(legend.position = "bottom")
}

binned_ndvi <- bind_rows(binned_rows) |>
  mutate(method = if_else(approach == "None", "Unharmonized", paste(approach, model)))
write_csv(binned_ndvi, file.path(output_dir, "tables", "figure_02_ndvi_binned_validation.csv"))
rmse_plot <- ggplot(binned_ndvi, aes(source_bin, rmse, fill = method)) +
  geom_col(position = position_dodge2(preserve = "single")) +
  labs(x = "Unharmonized ETM+ NDVI bin", y = "RMSE", fill = NULL) +
  theme_minimal(base_size = 9) +
  theme(axis.text.x = element_text(angle = 35, hjust = 1), legend.position = "bottom")
md_plot <- ggplot(binned_ndvi, aes(source_bin, mean_difference, fill = method)) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  geom_col(position = position_dodge2(preserve = "single")) +
  labs(x = "Unharmonized ETM+ NDVI bin", y = "Mean difference (prediction - OLI)", fill = NULL) +
  theme_minimal(base_size = 9) +
  theme(axis.text.x = element_text(angle = 35, hjust = 1), legend.position = "bottom")

figure_02 <- (
  make_fit_panel("R", band_fits, "Red", c(0, 0.4)) |
    make_fit_panel("NIR", band_fits, "NIR", c(0, 0.75)) |
    make_fit_panel("NDVI", index_fits, "NDVI", c(0, 1))
) / rmse_plot / md_plot +
  plot_layout(heights = c(1.1, 0.8, 0.8), guides = "collect") +
  plot_annotation(tag_levels = "A")
ggsave(file.path(output_dir, "figures", "figure_02.png"), figure_02, width = 13, height = 11, dpi = 600, bg = "white")

# Figure S3 evaluates the selected direct cubic NDVI model by Level I ecoregion.
ndvi_source <- validation$L7_NDVI
ndvi_observed <- validation$L8_NDVI
ndvi_prediction <- evaluate_polynomial(
  ndvi_source,
  coefficient_vector(index_fits, "NDVI", "L7_to_L8", 3L)
)
ecoregion_validation <- tibble(
  ecoregion = validation$ecoregion_l1_name,
  source = ndvi_source,
  observed = ndvi_observed,
  predicted = ndvi_prediction
) |>
  filter(is.finite(source), is.finite(observed), is.finite(predicted), between(source, 0, 1)) |>
  group_by(ecoregion) |>
  summarise(
    n = n(),
    unharmonized_rmse = sqrt(mean((source - observed)^2)),
    harmonized_rmse = sqrt(mean((predicted - observed)^2)),
    unharmonized_md = mean(source - observed),
    harmonized_md = mean(predicted - observed),
    .groups = "drop"
  )
write_csv(ecoregion_validation, file.path(output_dir, "tables", "figure_s03_ecoregion_validation.csv"))
figure_s03 <- ecoregion_validation |>
  select(ecoregion, unharmonized_rmse, harmonized_rmse) |>
  pivot_longer(-ecoregion, names_to = "record", values_to = "rmse") |>
  ggplot(aes(reorder(ecoregion, rmse), rmse, fill = record)) +
  geom_col(position = "dodge") +
  coord_flip() +
  labs(x = NULL, y = "NDVI RMSE", fill = NULL) +
  theme_minimal(base_size = 10) +
  theme(legend.position = "bottom")
ggsave(file.path(output_dir, "figures", "figure_s03.png"), figure_s03, width = 8, height = 5, dpi = 600, bg = "white")
