#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(ggplot2)
  library(purrr)
  library(readr)
  library(tidyr)
})
source("analysis/common/manuscript_methods.R")

sample_path <- "data/external/SR_Landsatsamples_Covariates.parquet"
output_dir <- "output/tables"
ensure_input(sample_path)
dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)

data <- read_parquet(sample_path) |>
  filter(split < 0.7, !is.na(ecoregion_l1_name)) |>
  add_indices()

summarise_bias <- function(measures, nonnegative_index = FALSE) {
  map_dfr(measures, function(measure) {
    values <- data |>
      transmute(
        Ecoregion = ecoregion_l1_name,
        source = .data[[paste0("L7_", measure)]],
        difference = .data[[paste0("L8_", measure)]] - source
      ) |>
      filter(!is.na(Ecoregion), is.finite(source), is.finite(difference))
    if (nonnegative_index) values <- filter(values, source >= 0)
    values |>
      group_by(Ecoregion) |>
      summarise(value = mean(difference), .groups = "drop") |>
      mutate(measure = measure)
  }) |>
    pivot_wider(names_from = measure, values_from = value)
}

band_table <- summarise_bias(bands)
index_table <- summarise_bias(indices, nonnegative_index = TRUE)
write_csv(band_table, file.path(output_dir, "table_s01_band_bias_by_ecoregion.csv"))
write_csv(index_table, file.path(output_dir, "table_s02_index_bias_by_ecoregion.csv"))

make_heatmap <- function(table, measures, filename, digits) {
  plot_data <- table |>
    pivot_longer(all_of(measures), names_to = "measure", values_to = "bias")
  limit <- max(abs(plot_data$bias), na.rm = TRUE)
  plot <- ggplot(plot_data, aes(measure, reorder(Ecoregion, bias), fill = bias)) +
    geom_tile(color = "white") +
    geom_text(aes(label = formatC(bias, format = "f", digits = digits)), size = 3) +
    scale_fill_gradient2(low = "#2166AC", mid = "white", high = "#B2182B", limits = c(-limit, limit)) +
    labs(x = NULL, y = NULL, fill = "OLI - ETM+") +
    theme_minimal(base_size = 10) +
    theme(panel.grid = element_blank())
  ggsave(file.path(dirname(output_dir), "figures", filename), plot,
    width = 10, height = 7, dpi = 300, bg = "white"
  )
}
dir.create(file.path(dirname(output_dir), "figures"), recursive = TRUE, showWarnings = FALSE)
make_heatmap(band_table, bands, "table_s01_band_bias_heatmap.png", 4)
make_heatmap(index_table, indices, "table_s02_index_bias_heatmap.png", 3)
