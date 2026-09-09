#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(ggplot2)
  library(patchwork)
  library(readr)
  library(scales)
  library(tidyr)
})
source("analysis/common/manuscript_methods.R")

sample_path <- "data/external/SR_Landsatsamples_Covariates.parquet"
series_path <- "data/external/grsa_ndvi_ts.csv"
output_dir <- "output/figures"
ensure_input(sample_path)
ensure_input(series_path)
dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)

samples <- read_parquet(sample_path) |> legacy_reported_bias()
series <- read_csv(series_path, show_col_types = FALSE)

density_data <- samples |>
  select(matches("^L[78]_(NDVI|EVI|MSAVI)$")) |>
  pivot_longer(
    everything(),
    names_to = c("sensor", "index"),
    names_pattern = "^(L[78])_(.*)$",
    values_to = "value"
  ) |>
  filter(is.finite(value), between(value, 0, 1)) |>
  mutate(
    sensor = recode(sensor, L7 = "Landsat 7 ETM+", L8 = "Landsat 8 OLI"),
    index = factor(index, levels = indices)
  )

panel_a <- ggplot(density_data, aes(value, color = sensor, fill = sensor)) +
  geom_density(alpha = 0.15, linewidth = 0.7) +
  facet_wrap(~index, nrow = 1) +
  coord_cartesian(xlim = c(0, 1)) +
  scale_color_manual(values = c("Landsat 7 ETM+" = "#D95F02", "Landsat 8 OLI" = "#1B9E77")) +
  scale_fill_manual(values = c("Landsat 7 ETM+" = "#D95F02", "Landsat 8 OLI" = "#1B9E77")) +
  labs(x = "Vegetation index", y = "Density", color = NULL, fill = NULL) +
  theme_minimal(base_size = 11) +
  theme(legend.position = "bottom", panel.grid.minor = element_blank())

missions <- tibble::tribble(
  ~mission, ~start, ~end, ~y,
  "Landsat 5 TM", 1984, 2012, 4,
  "Landsat 7 ETM+", 1999, 2021, 3,
  "Landsat 8 OLI", 2013, 2025, 2,
  "Landsat 9 OLI-2", 2022, 2025, 1
)
panel_b <- ggplot(missions) +
  geom_segment(aes(start, y, xend = end, yend = y, color = mission), linewidth = 5, lineend = "round") +
  scale_x_continuous(breaks = seq(1985, 2025, 5), limits = c(1983, 2026)) +
  scale_y_continuous(breaks = missions$y, labels = missions$mission) +
  guides(color = "none") +
  labs(x = NULL, y = NULL) +
  theme_minimal(base_size = 11) +
  theme(panel.grid.minor = element_blank(), panel.grid.major.y = element_blank())

sensor_long <- series |>
  pivot_longer(c(LS5, LS7, LS8, LS9), names_to = "sensor", values_to = "NDVI") |>
  mutate(sensor = recode(sensor,
    LS5 = "Landsat 5", LS7 = "Landsat 7",
    LS8 = "Landsat 8", LS9 = "Landsat 9"
  ))
panel_c <- ggplot(sensor_long, aes(year, NDVI, color = sensor)) +
  geom_line(linewidth = 0.75, na.rm = TRUE) +
  geom_point(size = 1.2, na.rm = TRUE) +
  scale_x_continuous(breaks = seq(1985, 2025, 5)) +
  labs(x = NULL, y = "Growing-season NDVI", color = NULL) +
  theme_minimal(base_size = 11) +
  theme(legend.position = "bottom", panel.grid.minor = element_blank())

merged <- series |>
  select(year, unharmonized, harmonized) |>
  pivot_longer(-year, names_to = "record", values_to = "NDVI") |>
  mutate(record = recode(record,
    unharmonized = "Unharmonized", harmonized = "Harmonized"
  ))
panel_d <- ggplot(merged, aes(year, NDVI, color = record)) +
  annotate("rect", xmin = 1984, xmax = 2012.5, ymin = -Inf, ymax = Inf, alpha = 0.05) +
  annotate("rect", xmin = 2012.5, xmax = 2021.5, ymin = -Inf, ymax = Inf, alpha = 0.10) +
  annotate("rect", xmin = 2021.5, xmax = 2025.5, ymin = -Inf, ymax = Inf, alpha = 0.05) +
  geom_line(linewidth = 0.8, na.rm = TRUE) +
  geom_point(size = 1.2, na.rm = TRUE) +
  scale_color_manual(values = c(Unharmonized = "#C0392B", Harmonized = "#2C3E50")) +
  scale_x_continuous(breaks = seq(1985, 2025, 5)) +
  labs(x = "Year", y = "Growing-season NDVI", color = NULL) +
  theme_minimal(base_size = 11) +
  theme(legend.position = "bottom", panel.grid.minor = element_blank())

figure <- (panel_a / panel_b / panel_c / panel_d) +
  plot_annotation(tag_levels = "A") +
  plot_layout(heights = c(0.9, 0.8, 1, 1))
ggsave(file.path(output_dir, "figure_01.png"), figure, width = 12, height = 13.1, dpi = 600, bg = "white")
ggsave(file.path(output_dir, "figure_01.pdf"), figure, width = 12, height = 13.1, bg = "white")

bias_summary <- samples |>
  summarise(
    n = n(),
    NDVI = mean(L8_NDVI - L7_NDVI),
    EVI = mean(L8_EVI - L7_EVI),
    MSAVI = mean(L8_MSAVI - L7_MSAVI)
  ) |>
  pivot_longer(-n, names_to = "index", values_to = "mean_oli_minus_etm")
write_csv(bias_summary, file.path(output_dir, "figure_01_bias_summary.csv"))
