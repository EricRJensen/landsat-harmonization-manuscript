import { useEffect, useId, useRef, useState } from "react";
import { coefficientExport, coefficientsJson, coefficientsTsv, VARIABLE_NAMES } from "../coefficientExport";
import type { HarmonizationChoice } from "../types";
import "../exploreGuidance.css";

export function SelectedCoefficients({ choice, compact = false }: { choice: HarmonizationChoice; compact?: boolean }) {
  const data = coefficientExport(choice);
  const [message, setMessage] = useState("");
  const [fallback, setFallback] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const exportKey = coefficientsJson(choice);
  const headingId = useId();
  const fallbackId = useId();
  const copyRequest = useRef(0);
  useEffect(() => {
    ++copyRequest.current;
    setMessage(""); setFallback("");
  }, [exportKey]);
  useEffect(() => {
    if (fallback) { textRef.current?.focus(); textRef.current?.select(); }
  }, [fallback]);
  const copy = async (format: "tsv" | "json") => {
    const request = ++copyRequest.current;
    const text = format === "tsv" ? coefficientsTsv(choice) : coefficientsJson(choice);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (request !== copyRequest.current) return;
      setFallback("");
      setMessage(format === "tsv" ? "Coefficients copied. Paste into a spreadsheet or text editor." : "Coefficient JSON copied.");
    } catch {
      if (request !== copyRequest.current) return;
      setFallback(text);
      setMessage("Copy was unavailable. The text below is selected; use your keyboard or device’s Copy command.");
    }
  };
  return <section className={`selected-coefficients ${compact ? "compact" : ""}`} aria-labelledby={headingId}>
    <div className="coefficient-access-header">
      <div><h3 id={headingId}>Use these coefficients</h3><p>Fitted in <strong>{data.coefficient_fitting_region.name}</strong> · {data.source_scale} → {data.reference_scale}</p></div>
      <div className="coefficient-copy-actions">
        <button type="button" className="secondary-button" onClick={() => void copy("tsv")}>Copy coefficients</button>
        <button type="button" className="secondary-button" onClick={() => void copy("json")}>Copy JSON</button>
      </div>
    </div>
    <p className="coefficient-copy-note">Copy includes full-precision values, variable names, coefficient order, direction, fitting region, and evaluation region. Coefficients paste as spreadsheet columns.</p>
    <div role="status" className="coefficient-copy-status">{message}</div>
    {fallback && <label htmlFor={fallbackId} className="coefficient-fallback">Select and copy
      <textarea id={fallbackId} ref={textRef} value={fallback} readOnly rows={6} onFocus={(event) => event.currentTarget.select()} />
    </label>}
    <details className="coefficient-values" open={!compact || undefined}>
      <summary>Coefficient values and how to apply them</summary>
      <p><code>{data.equation}</code>, where <strong>x</strong> is the unharmonized {data.source_scale} value and <strong>y</strong> is the value adjusted to match the {data.reference_scale} reference sensor.</p>
      <p>{data.input_preparation}</p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Full-precision coefficients">
        <table><thead><tr><th>Variable</th>{data.coefficient_order.map((term) => <th key={term}>{term}</th>)}</tr></thead>
          <tbody>{Object.entries(data.models).map(([variable, model]) => <tr key={variable}>
            <th scope="row" title={VARIABLE_NAMES[variable]}>{variable}{VARIABLE_NAMES[variable] && <small>{VARIABLE_NAMES[variable]}</small>}</th>
            {model.coefficients.map((value, index) => <td key={index}>{String(value)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <p>Evaluation region: {data.evaluation_region.name}. The selected coefficients are applied uniformly within the analysis area. <a href={data.data_url} target="_blank" rel="noreferrer">Study data on Zenodo ↗</a></p>
    </details>
  </section>;
}
