import { useEffect, useRef, useState } from "react";
import type { BasemapMode, IndexName } from "../types";
import { SampleMap } from "./SampleMap";

interface Props {
  open: boolean;
  basemap: BasemapMode;
  initialIndex?: IndexName;
  onClose: () => void;
}

export function AboutStudyModal({ open, basemap, initialIndex = "NDVI", onClose }: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [samplesOpen, setSamplesOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onClose]);

  if (!open) return null;

  return <div className="about-modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-study-title">
      <header className="about-modal-header">
        <div><p className="eyebrow">About this research</p>
          <h2 id="about-study-title">Cross-Sensor Differences in Landsat Collection 2 Vegetation Indices Alter Environmental Inference</h2>
          <p className="manuscript-meta">Environmental Research Letters · Letter · Eric R. Jensen, Alex C. Brooks, Christine M. Albano, Kenneth C. McGwire, Charles Morton, and Justin L. Huntington</p>
          <p className="about-modal-lead">The manuscript tests whether residual differences between Landsat 7 ETM+ and Landsat 8 OLI alter merged vegetation-index time series and the environmental conclusions drawn from them.</p>
        </div>
        <button ref={closeButton} className="about-modal-close" type="button" aria-label="Close research overview" onClick={onClose}>×</button>
      </header>

      <div className="about-overview-grid">
        <article><span>01</span><h3>Manuscript question</h3>
          <p>Does the consistently processed Landsat Collection 2 archive still contain systematic ETM+/OLI differences large enough to change trend magnitude, direction, significance, or downstream interpretation?</p>
        </article>
        <article><span>02</span><h3>General approach</h3>
          <p>Five million ETM+–OLI pixels from acquisitions one day apart across CONUS are split 70/30 into training and held-out samples. Independent transformations in both sensor directions are evaluated for NDVI, EVI, and MSAVI.</p>
        </article>
        <article><span>03</span><h3>Purpose of this app</h3>
          <p>Evaluate whether harmonization is warranted: choose the reference sensor scale, compare systematic bias and total error, select coefficients suited to the index and region, and test their effect on environmental inference.</p>
        </article>
      </div>

      <div className="study-method-strip" aria-label="Study workflow summary">
        <div><span>Paired evidence</span><strong>2013–2021 · April–October</strong></div>
        <div><span>Calibration directions</span><strong>ETM+ ↔ OLI reference scales</strong></div>
        <div><span>Trend inputs</span><strong>April–September annual composites</strong></div>
      </div>

      <section className="manuscript-findings" aria-label="Key manuscript findings">
        <div><strong>Systematic index offsets</strong><span>Median OLI–ETM+ offsets were +0.0316 NDVI, +0.0234 EVI, and +0.0238 MSAVI.</span></div>
        <div><strong>Bias matters more than perfect agreement</strong><span>Harmonization reduces directional cross-sensor bias; it is not expected to make every paired observation identical.</span></div>
        <div><strong>Environmental inference can change</strong><span>Uncorrected sensor-era offsets can create false temporal structure and apparent greening when the offset is large relative to the environmental signal.</span></div>
      </section>

      <details className="sample-accordion about-sample-accordion" open={samplesOpen}
        onToggle={(event) => setSamplesOpen(event.currentTarget.open)}>
        <summary><div><p className="eyebrow">Explore the underlying data</p><h2>Explore paired observations behind the manuscript</h2>
          <p>Inspect acquisition dates, reflectance offsets, vegetation-index offsets, and geographic context for the LEOHS samples.</p></div>
          <span>{samplesOpen ? "Hide sample map" : "Show sample map"}</span></summary>
        {samplesOpen && <div className="sample-accordion-content">
          <SampleMap key={`${basemap}-${initialIndex}`} basemap={basemap} selectedIndex={initialIndex} />
        </div>}
      </details>

      <footer className="about-modal-footer">
        <p>The manuscript recommends selecting and validating harmonization for the index, region, season, and application. This app supports that sensitivity analysis; it does not imply that one coefficient set is optimal everywhere.</p>
        <button className="primary-button" type="button" onClick={onClose}>Start exploring</button>
      </footer>
    </section>
  </div>;
}
