import type { EpochMeta } from "../api";
import { t } from "../i18n/i18n";

function mjdToIso(mjd: number): string {
  const unixMs = (mjd - 40587) * 86400000;
  return new Date(unixMs).toISOString().slice(0, 10);
}

// Column headers are uppercased by CSS, which would also turn "µm" into
// "ΜM" (Greek capital Mu): keep units in a span that opts out of it.
function header(label: string): string {
  return label.replace(/\(([^)]*)\)/, '<span class="unit">($1)</span>');
}

export function renderMetadataTable(container: HTMLElement, epochs: EpochMeta[]): void {
  const cols = [
    t("metadata.epoch"),
    t("metadata.date"),
    t("metadata.n_exposures"),
    t("metadata.flag_fraction"),
    t("metadata.detectors"),
    t("metadata.wavelengths"),
    t("metadata.notes"),
  ];
  // data-label carries each column's name into the stacked card layout
  // used when the panel is narrow (see .metadata-table in style.css).
  const cell = (col: number, value: string) => `<td data-label="${cols[col]}">${value}</td>`;
  const rows = epochs
    .map(
      (e, i) => `
      <tr>
        ${cell(0, String(i + 1))}
        ${cell(1, mjdToIso(e.mjd_mean))}
        ${cell(2, String(e.n_exposures))}
        ${cell(3, `${(e.flag_fraction * 100).toFixed(1)}%`)}
        ${cell(4, e.detectors.join(", "))}
        ${cell(5, e.wavelengths_um.map((w) => w.toFixed(2)).join(", "))}
        ${e.saturated_core ? cell(6, `<span class="saturated-badge">${t("metadata.saturated_core")}</span>`) : '<td class="empty-note"></td>'}
      </tr>`,
    )
    .join("");

  container.innerHTML = `
    <table class="metadata-table">
      <caption>${t("panel.metadata")}</caption>
      <thead>
        <tr>${cols.map((c) => `<th scope="col">${header(c)}</th>`).join("")}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
