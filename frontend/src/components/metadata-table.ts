import type { EpochMeta } from "../api";
import { t } from "../i18n/i18n";

function mjdToIso(mjd: number): string {
  const unixMs = (mjd - 40587) * 86400000;
  return new Date(unixMs).toISOString().slice(0, 10);
}

export function renderMetadataTable(container: HTMLElement, epochs: EpochMeta[]): void {
  const rows = epochs
    .map(
      (e, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${mjdToIso(e.mjd_mean)}</td>
        <td>${e.n_exposures}</td>
        <td>${(e.flag_fraction * 100).toFixed(1)}%</td>
        <td>${e.detectors.join(", ")}</td>
        <td>${e.wavelengths_um.map((w) => w.toFixed(2)).join(", ")}</td>
        <td>${e.saturated_core ? `<span class="saturated-badge">${t("metadata.saturated_core")}</span>` : ""}</td>
      </tr>`,
    )
    .join("");

  container.innerHTML = `
    <table class="metadata-table">
      <caption>${t("panel.metadata")}</caption>
      <thead>
        <tr>
          <th scope="col">${t("metadata.epoch")}</th>
          <th scope="col">${t("metadata.date")}</th>
          <th scope="col">${t("metadata.n_exposures")}</th>
          <th scope="col">${t("metadata.flag_fraction")}</th>
          <th scope="col">${t("metadata.detectors")}</th>
          <th scope="col">${t("metadata.wavelengths")}</th>
          <th scope="col">${t("metadata.notes")}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
