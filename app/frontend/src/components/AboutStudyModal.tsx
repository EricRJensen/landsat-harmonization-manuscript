import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { BasemapMode, IndexName } from "../types";
const SampleMap = lazy(() => import("./SampleMap").then((module) => ({ default: module.SampleMap })));

const PAIRED_DATA_URL = "https://zenodo.org/records/22033662";

interface Props {
  open: boolean;
  basemap: BasemapMode;
  initialIndex?: IndexName;
  onClose: () => void;
}

export function AboutStudyModal({ open, basemap, initialIndex = "NDVI", onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const closeOverview = () => {
    setSamplesOpen(false);
    onClose();
  };

  useEffect(() => {
    const modal = dialog.current;
    if (!open || !modal) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.showModal();
    return () => {
      modal.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;

  return <dialog ref={dialog} className={`about-modal${samplesOpen ? " with-samples" : ""}`}
    aria-labelledby="about-study-title" aria-describedby="about-study-purpose"
    onCancel={(event) => { event.preventDefault(); closeOverview(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) closeOverview();
    }}>
    <div className="about-modal-content">
      <header className="about-modal-header">
        <div><p className="eyebrow">About this research</p>
          <h2 id="about-study-title">Understand cross-sensor bias in Landsat vegetation indices</h2>
        </div>
        <button className="about-modal-close" type="button" aria-label="Close research overview" onClick={closeOverview}>×</button>
      </header>

      <p id="about-study-purpose" className="about-modal-lead">Small, systematic differences between Landsat sensors can alter vegetation trends and environmental inference, even in Collection 2 Level-2 analysis-ready data. Explore whether harmonization changes the conclusions you draw from merged growing-season NDVI, EVI, and MSAVI time series across the conterminous United States (CONUS).</p>

      <ol className="about-workflow" aria-label="How to use the explorer">
        <li><span aria-hidden="true">1</span><div><h3>Explore &amp; Choose</h3>
          <p>Choose a reference sensor, region, and vegetation index. Compare bias and error on held-out observations, then select a harmonization approach for further analysis.</p>
        </div></li>
        <li><span aria-hidden="true">2</span><div><h3>Map &amp; Analyze</h3>
          <p>Apply the selected harmonization approach to trend maps and time series analysis to evaluate the effects on environmental inference.</p>
        </div></li>
      </ol>

      <details className="about-disclosure">
        <summary>Study details</summary>
        <div className="about-study-details">
          <h3>Cross-Sensor Differences in Landsat Collection 2 Spectral Vegetation Indices Alter Environmental Inference</h3>
          <p className="manuscript-meta">Eric R. Jensen, Alexander C. Brooks, Christine M. Albano, Kenneth C. McGwire, Charles Morton, Saeed Arab, Christopher J. Crawford, and Justin L. Huntington. Submitted to Environmental Research Letters.</p>
          <p>Landsat provides a decades-long record of environmental change, but combining observations from different sensor generations can introduce changes that reflect the instruments rather than the landscape. This study examines whether those differences still matter in Collection 2 Level-2 data.</p>
          <p>Using 4.82 million paired Landsat 7 ETM+ and Landsat 8 OLI observations collected one day apart across the conterminous United States during April–October, 2013–2021, we found that OLI generally produced higher NDVI, EVI, and MSAVI values. We compared four harmonization approaches that adjust spectral bands or vegetation indices to a common sensor scale, testing them on observations not used to fit the adjustments. Harmonization substantially reduced systematic bias, although differences between individual observations remained.</p>
          <p>Three case studies demonstrated these effects on common environmental analyses. Uncorrected sensor differences:</p>
          <ol className="about-case-studies">
            <li>Exaggerated long-term greening.</li>
            <li>Obscured relationships between vegetation and water availability.</li>
            <li>Affected modeled agricultural water use.</li>
          </ol>
          <p>Harmonization improved agreement with independent vegetation trends and strengthened relationships with climate. The practical message is to evaluate whether sensor differences are large enough to affect conclusions and apply harmonization appropriate for your index, region, and application.</p>
          {/* Replace this placeholder with the manuscript URL when available. */}
          <p><a href="#manuscript" aria-disabled="true" onClick={event => event.preventDefault()}
            title="The manuscript link will be added when available">Read the manuscript (link forthcoming)</a></p>
          <p><a href={PAIRED_DATA_URL} target="_blank" rel="noopener noreferrer"
            aria-label="View the paired dataset on Zenodo (opens in a new tab)">View the paired dataset on Zenodo <span aria-hidden="true">↗</span></a></p>
        </div>
      </details>

      <details className="about-disclosure about-sample-accordion" open={samplesOpen}
        onToggle={(event) => setSamplesOpen(event.currentTarget.open)}>
        <summary>Explore paired observations</summary>
        {samplesOpen && <div className="sample-accordion-content">
          <p className="about-sample-description">Explore the paired ETM+ and OLI observations used to develop and evaluate the harmonization coefficients presented in the manuscript and this app. Inspect acquisition dates and differences in reflectance and vegetation indices for individual pairs. <a href={PAIRED_DATA_URL} target="_blank" rel="noopener noreferrer"
            aria-label="Data and downloads on Zenodo (opens in a new tab)">Data and downloads on Zenodo <span aria-hidden="true">↗</span></a></p>
          <Suspense fallback={<div className="loading-panel" role="status">Loading paired observations map…</div>}>
            <SampleMap key={`${basemap}-${initialIndex}`} basemap={basemap} selectedIndex={initialIndex} />
          </Suspense>
        </div>}
      </details>
    </div>
    <footer className="about-modal-footer">
      <button className="primary-button" type="button" onClick={closeOverview}>Start Exploring <span aria-hidden="true">→</span></button>
    </footer>
  </dialog>;
}
