#!/usr/bin/env python3
"""Reproduce Figures S7 and S8 from precomputed GRSA sampling summaries.

Run from any directory; defaults are relative to the manuscript repository.
This script plots existing estimates, rather than extracting or reanalyzing
Landsat observations. See the repository README for input provenance.
"""
from pathlib import Path
import hashlib
import json
import argparse

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.font_manager import findfont
import numpy as np
import pandas as pd
import plotnine as p9

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_DIR = ROOT / 'data/external/grsa_sampling'
DEFAULT_OUTPUT_DIR = ROOT / 'output/figures'
STEM = 'figure_s07_observation_availability_sensitivity'
FULL_STEM = 'figure_s08_complete_record_monthly_sensitivity'
SOURCE_NAMES = [
    'observation_count_distribution.csv', 'valid_acquisition_dates_by_year_sensor.csv',
    'annual_aprsep_means.csv', 'fixed_panel_annual_means.csv', 'fixed_panel_summary.json',
]
SENSORS = {'L5': '#7B8085', 'L7': '#C58F32', 'L8': '#237DA6', 'L9': '#399C89'}
RAW, HARM, INK = '#B95626', '#167398', '#20343F'
YEAR_BREAKS = [1984, 1990, 2000, 2010, 2020, 2025]


def base_theme():
    return p9.theme_minimal(base_size=9, base_family='Arial') + p9.theme(
        text=p9.element_text(color=INK, weight='normal'),
        axis_title=p9.element_text(weight='normal'),
        axis_text=p9.element_text(color=INK, size=8),
        panel_grid_major=p9.element_line(color='#E4E8EB', size=.35),
        panel_grid_minor=p9.element_blank(),
        axis_line=p9.element_line(color='#A7B0B5', size=.4),
        legend_title=p9.element_blank(), legend_position='top',
        legend_text=p9.element_text(size=8), legend_key_width=17,
        legend_key_height=11, legend_margin=0, legend_box_spacing=.01,
        plot_tag=p9.element_text(size=11, weight='bold'),
        plot_margin=.018,
    )


def time_series(annual, treatment, color, tag, fixed=False):
    # Explicit run groups keep gaps (e.g., 1990) from being interpolated.
    rows = []
    labels = ({'original': 'Original observations', 'balanced': 'Equal months'} if fixed else
              {'all': 'All points', 'matched': 'Complete months', 'balanced': 'Equal months'})
    colors = {label: '#B9BEC2' if method == 'all' else color for method, label in labels.items()}
    lines = {label: 'dashed' if method == 'balanced' else 'solid' for method, label in labels.items()}
    for method, label in labels.items():
        values = annual[['year', f'{treatment}_{method}']].rename(columns={f'{treatment}_{method}': 'ndvi'}).copy()
        values['segment'] = values.ndvi.isna().cumsum().astype(str) + method
        values['series'] = label
        rows.append(values.dropna())
    data = pd.concat(rows)
    data['series'] = pd.Categorical(data.series, categories=list(labels.values()), ordered=True)
    return (p9.ggplot(data, p9.aes('year', 'ndvi', color='series', linetype='series', group='segment'))
        + p9.geom_line(size=.65)
        + p9.scale_color_manual(values=colors)
        + p9.scale_linetype_manual(values=lines)
        + p9.scale_x_continuous(breaks=[2000, 2005, 2010, 2015, 2020, 2022] if fixed else YEAR_BREAKS,
                                limits=(1999.5, 2022.5) if fixed else (1983.5, 2025.5), expand=(0, 0))
        + p9.scale_y_continuous(breaks=np.arange(.12, .211, .02) if fixed else np.arange(.125, .326, .025),
                                limits=(.11, .21) if fixed else (.12, .34))
        + p9.labs(x='', y='Raw NDVI' if treatment == 'raw' else 'Harmonized NDVI', tag=tag)
        + base_theme()
        + p9.theme(axis_text_x=p9.element_text(rotation=40, ha='right'),
                   legend_text=p9.element_text(size=7), legend_key_width=12,
                   legend_direction='horizontal', legend_spacing=3,
                   legend_key_spacing_x=4))


def save_figure(figure, stem, output_dir):
    # Draw once: repeat Compose.draw calls accumulate text artists.
    rendered = figure.draw()
    for ext in ['png', 'svg', 'pdf']:
        destination = output_dir
        destination.mkdir(parents=True, exist_ok=True)
        rendered.savefig(destination / f'{stem}.{ext}', dpi=400)
    plt.close(rendered)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, default=DEFAULT_INPUT_DIR,
                        help='Directory containing the five precomputed CSV/JSON summaries.')
    parser.add_argument('--output-dir', type=Path, default=DEFAULT_OUTPUT_DIR,
                        help='Destination for PDF, SVG, PNG, captions, and provenance.')
    args = parser.parse_args()
    input_dir, output_dir = args.input_dir.resolve(), args.output_dir.resolve()
    missing = [name for name in SOURCE_NAMES if not (input_dir / name).is_file()]
    if missing:
        parser.error(f"Missing summary inputs in {input_dir}: {', '.join(missing)}. See README.")
    counts = pd.read_csv(input_dir / 'observation_count_distribution.csv')
    dates = pd.read_csv(input_dir / 'valid_acquisition_dates_by_year_sensor.csv')
    annual = pd.read_csv(input_dir / 'annual_aprsep_means.csv')
    fixed = pd.read_csv(input_dir / 'fixed_panel_annual_means.csv')
    fixed = fixed[fixed.elevation_band == 'All points'].sort_values('year')
    summary = json.loads((input_dir / 'fixed_panel_summary.json').read_text())
    assert summary['n_points'] == 5493 and summary['n_years'] == 23
    assert summary['composition'][-1]['fixed_n'] == 0
    assert fixed.year.tolist() == list(range(2000, 2023))
    assert fixed.n_points.eq(5493).all()
    assert fixed[['raw_original', 'harm_original', 'raw_balanced', 'harm_balanced']].notna().all().all()
    assert annual.year.tolist() == list(range(1984, 2026))
    assert annual.loc[annual.n_complete == 0, 'year'].tolist() == [1984, 1990]
    assert annual.loc[annual.n_complete == 0, ['raw_matched', 'harm_matched', 'raw_balanced', 'harm_balanced']].isna().all().all()
    frequency = dates.groupby(['sensor', 'year']).n_valid.sum()
    expected = counts[counts.sensor != 'all'].set_index(['sensor', 'year']).mean_n * 10000
    np.testing.assert_allclose(frequency.reindex(expected.index, fill_value=0), expected, atol=1e-7, rtol=0)
    try:
        font_path = findfont('Arial', fallback_to_default=False)
    except ValueError:
        parser.error('Arial is required. Install Arial before rendering these manuscript figures.')
    matplotlib.rcParams.update({'svg.fonttype': 'none', 'pdf.fonttype': 42, 'savefig.facecolor': 'white'})
    sensor_counts = counts[counts.sensor != 'all'].copy()
    sensor_counts['sensor'] = pd.Categorical(sensor_counts.sensor, categories=list(SENSORS), ordered=True)
    a = (p9.ggplot(sensor_counts, p9.aes('year', 'mean_n', fill='sensor'))
         + p9.geom_col(width=.87, position=p9.position_stack(reverse=True))
         + p9.scale_fill_manual(values=SENSORS)
         + p9.scale_x_continuous(breaks=YEAR_BREAKS, limits=(1983.4, 2025.6), expand=(0, 0))
         + p9.scale_y_continuous(breaks=[0, 10, 20, 30, 40], limits=(0, 40), expand=(0, 0))
         + p9.labs(x='', y='Valid observations per point', tag='A')
         + base_theme() + p9.theme(panel_grid_major_x=p9.element_blank()))
    b = time_series(fixed, 'raw', RAW, 'B', fixed=True)
    c = time_series(fixed, 'harm', HARM, 'C', fixed=True)
    ci = summary['trend_summary_4km']
    trends = pd.DataFrame([
        {'method': method_label, 'treatment': treatment_label, **ci[f'{treatment}_{method}']}
        for treatment, treatment_label in [('raw', 'Raw'), ('harm', 'Harmonized')]
        for method, method_label in [('original', 'Original observations'), ('balanced', 'Equal months')]
    ])
    trends['method'] = pd.Categorical(trends.method, categories=['Original observations', 'Equal months'], ordered=True)
    trends['treatment'] = pd.Categorical(trends.treatment, categories=['Raw', 'Harmonized'], ordered=True)
    dodge = p9.position_dodge(width=.16)
    d = (p9.ggplot(trends, p9.aes('method', 'mean', color='treatment'))
         + p9.geom_errorbar(p9.aes(ymin='ci_low', ymax='ci_high'), width=.06, position=dodge, size=.6)
         + p9.geom_point(position=dodge, size=2.5)
         + p9.scale_color_manual(values={'Raw': RAW, 'Harmonized': HARM})
         + p9.scale_y_continuous(limits=(0, .025), breaks=np.arange(0, .0251, .005),
                                 minor_breaks=np.arange(.0025, .025, .005),
                                 labels=lambda xs: [f'{x:.3f}' for x in xs], expand=(0, 0))
         + p9.labs(x='', y='Mean trend (NDVI / decade)', tag='D')
         + base_theme()
         + p9.theme(panel_grid_major_x=p9.element_blank(),
                    panel_grid_minor_y=p9.element_line(color='#E4E8EB', size=.35)))
    figure = (a / (b | c) / d) & p9.theme(figure_size=(7.2, 8.2), dpi=400)
    save_figure(figure, STEM, output_dir)
    full_figure = (time_series(annual, 'raw', RAW, 'A') | time_series(annual, 'harm', HARM, 'B')) & p9.theme(
        figure_size=(7.2, 3.2), dpi=400)
    save_figure(full_figure, FULL_STEM, output_dir)
    caption = (
        'Figure S7. Observation availability and monthly-weighting sensitivity in Great Sand Dunes National Park and Preserve. '
        '(A) Mean valid April-September observation counts by sensor across 10,000 sampled points, including zero counts. '
        '(B-C) Spatial means of annual April-September NDVI before (B) and after (C) harmonization, using the same 5,493 points in every year of 2000-2022. '
        'Each point has at least one valid observation in every April-September month of every year. '
        'Solid lines average all valid observations within each point-year; dashed lines average its six monthly means equally. '
        'Both methods use identical observations, locations, and years. '
        '(D) Mean point-specific Theil-Sen trends for this same fixed sample and period. '
        'Error bars show 95% intervals from 2,000 paired spatial-block bootstrap replicates (4 km blocks). '
        'Harmonization precedes aggregation. The fixed sample excludes elevations at or above 3,000 m; monthly weighting does not standardize within-month timing or recover missing observations.'
    )
    (output_dir / f'{STEM}_caption.txt').write_text(caption + '\n')
    full_caption = (
        'Figure S8. Full-record NDVI sensitivity to observation availability and monthly weighting in GRSA, 1984-2025. '
        'Annual April-September means are shown for raw (A) and harmonized (B) NDVI. '
        'Gray lines include all points with valid observations; colored solid lines restrict observation-weighted means to points with all six months observed; '
        'dashed lines equally weight monthly means at those same points. '
        'Eligible locations vary annually, with none qualifying in 1984 or 1990. '
        'Gray-to-colored differences reflect sample selection; solid-to-dashed differences reflect monthly weighting.'
    )
    (output_dir / f'{FULL_STEM}_caption.txt').write_text(full_caption + '\n')
    (output_dir / f'{STEM}_provenance.json').write_text(json.dumps({
        'source_sha256': {name: hashlib.sha256((input_dir / name).read_bytes()).hexdigest() for name in SOURCE_NAMES},
        'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'count_timing_totals_agree': True, 'fixed_time_series_missing_years': [],
        'complete_record_missing_complete_month_years': [1984, 1990],
        'complete_record_figure': FULL_STEM,
        'fixed_points': 5493, 'trend_years': [2000, 2022], 'bootstrap_blocks': 37,
        'plotnine_version': p9.__version__, 'font': 'Arial', 'font_path': font_path,
        'trend_grid_interval': .0025, 'trend_connecting_lines': False,
        'formats': ['PDF vector', 'SVG editable text', 'PNG 400 dpi']}, indent=2) + '\n')
    print(output_dir / f'{STEM}.pdf')
    print(output_dir / f'{FULL_STEM}.pdf')


if __name__ == '__main__':
    main()
