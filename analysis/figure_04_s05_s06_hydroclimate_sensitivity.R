#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(ggrepel)
  library(patchwork)
  library(readr)
  library(tidyr)
})
source("analysis/common/manuscript_methods.R")

ndvi_path <- "data/external/Landsat_SR_NDVI_1984_2025_Great_Basin_casestudy.csv"
spei_path <- "data/external/GridMET_SPEI1y_1984_2025_Great_Basin_casestudy.csv"
output_dir <- "output"
ensure_input(ndvi_path)
ensure_input(spei_path)
dir.create(file.path(output_dir, "figures"), recursive = TRUE, showWarnings = FALSE)
dir.create(file.path(output_dir, "tables"), recursive = TRUE, showWarnings = FALSE)

ndvi <- read_csv(ndvi_path, show_col_types = FALSE) |>
  transmute(
    year = as.integer(year), product, harmonization,
    NDVI = as.numeric(value)
  ) |>
  filter(year <= 2025, year != 2012) |>
  filter(!(product == "LANDSAT7_SR" & year %in% c(2022, 2023)))

spei <- read_csv(spei_path, show_col_types = FALSE) |>
  select(matches("^\\d{4}_spei1y$")) |>
  pivot_longer(everything(), names_to = "year", values_to = "SPEI") |>
  mutate(year = as.integer(substr(year, 1, 4)))

merged <- ndvi |>
  filter(product == "LANDSAT_SR") |>
  left_join(spei, by = "year") |>
  mutate(
    record = recode(harmonization, none = "Unharmonized", l7_to_l8 = "Harmonized"),
    record = factor(record, levels = c("Unharmonized", "Harmonized")),
    era = case_when(
      year <= 2012 ~ "TM/ETM+",
      year <= 2021 ~ "ETM+/OLI",
      TRUE ~ "OLI/OLI-2"
    )
  )

era_colors <- c("TM/ETM+" = "#3B6EA8", "ETM+/OLI" = "#B88A1D", "OLI/OLI-2" = "#008C72")
record_colors <- c("Unharmonized" = "#C0392B", "Harmonized" = "#2C3E50")

panel_a <- ggplot(merged, aes(year, NDVI, color = record)) +
  geom_line(linewidth = 0.8) + geom_point(size = 1.4) +
  scale_color_manual(values = record_colors) +
  scale_x_continuous(breaks = seq(1985, 2025, 5)) +
  labs(x = NULL, y = "Growing-season NDVI", color = NULL) +
  theme_minimal(base_size = 11) + theme(legend.position = "bottom", panel.grid.minor = element_blank())

panel_b <- ggplot(spei, aes(year, SPEI, fill = SPEI >= 0)) +
  geom_col(width = 0.8) + geom_hline(yintercept = 0) +
  scale_fill_manual(values = c(`TRUE` = "#0072B2", `FALSE` = "#D55E00"), guide = "none") +
  scale_x_continuous(breaks = seq(1985, 2025, 5)) +
  labs(x = NULL, y = "Water-year SPEI") +
  theme_minimal(base_size = 11) + theme(panel.grid.minor = element_blank())

model_summary <- merged |>
  filter(is.finite(NDVI), is.finite(SPEI)) |>
  group_by(record) |>
  group_modify(~ {
    fit <- lm(NDVI ~ SPEI, data = .x)
    tibble(
      n = nrow(.x),
      intercept = unname(coef(fit)[[1]]),
      slope = unname(coef(fit)[[2]]),
      r_squared = summary(fit)$r.squared,
      p_value = summary(fit)$coefficients["SPEI", "Pr(>|t|)"]
    )
  }) |>
  ungroup()
write_csv(model_summary, file.path(output_dir, "tables", "figure_04_hydroclimate_models.csv"))

labels <- model_summary |>
  mutate(label = sprintf("R² = %.3f", r_squared))
panel_c <- ggplot(merged, aes(SPEI, NDVI)) +
  geom_smooth(method = "lm", formula = y ~ x, color = "grey25", fill = "grey75") +
  geom_point(aes(color = era), size = 2.2, alpha = 0.85) +
  geom_text(data = labels, aes(x = -Inf, y = Inf, label = label), inherit.aes = FALSE, hjust = -0.15, vjust = 1.5) +
  facet_wrap(~record, nrow = 1) +
  scale_color_manual(values = era_colors) +
  labs(x = "Water-year SPEI", y = "Growing-season NDVI", color = "Sensor era") +
  theme_minimal(base_size = 11) + theme(legend.position = "bottom", panel.grid.minor = element_blank())

figure_04 <- panel_a / panel_b / panel_c + plot_annotation(tag_levels = "A") + plot_layout(heights = c(1, 1, 1.3))
ggsave(file.path(output_dir, "figures", "figure_04.png"), figure_04, width = 8, height = 12.5, dpi = 600, bg = "white")
ggsave(file.path(output_dir, "figures", "figure_04.pdf"), figure_04, width = 8, height = 12.5, bg = "white")

sensor_names <- c(
  LANDSAT5_SR = "Landsat 5", LANDSAT7_SR = "Landsat 7",
  LANDSAT8_SR = "Landsat 8", LANDSAT9_SR = "Landsat 9"
)
sensors <- ndvi |>
  filter(product != "LANDSAT_SR") |>
  left_join(spei, by = "year") |>
  mutate(
    sensor = recode(product, !!!sensor_names),
    record = recode(harmonization, none = "Unharmonized", l7_to_l8 = "Harmonized")
  )

sensor_models <- sensors |>
  filter(is.finite(NDVI), is.finite(SPEI)) |>
  group_by(record, sensor) |>
  group_modify(~ tibble(r_squared = summary(lm(NDVI ~ SPEI, data = .x))$r.squared)) |>
  ungroup()
write_csv(sensor_models, file.path(output_dir, "tables", "figure_s05_sensor_models.csv"))

figure_s05 <- ggplot(sensors, aes(SPEI, NDVI, color = sensor)) +
  geom_point(alpha = 0.8) +
  geom_smooth(method = "lm", formula = y ~ x, se = FALSE) +
  facet_wrap(~record, nrow = 1) +
  labs(x = "Water-year SPEI", y = "Growing-season NDVI", color = NULL) +
  theme_minimal(base_size = 10) + theme(legend.position = "bottom")
ggsave(file.path(output_dir, "figures", "figure_s05.png"), figure_s05, width = 8, height = 4.8, dpi = 600, bg = "white")

figure_s06 <- ggplot(sensors, aes(year, NDVI, color = sensor)) +
  geom_line() + geom_point(size = 1) +
  facet_wrap(~record, ncol = 1) +
  scale_x_continuous(breaks = seq(1985, 2025, 5)) +
  labs(x = "Year", y = "Growing-season NDVI", color = NULL) +
  theme_minimal(base_size = 10) + theme(legend.position = "bottom")
ggsave(file.path(output_dir, "figures", "figure_s06.png"), figure_s06, width = 8, height = 6.5, dpi = 600, bg = "white")
