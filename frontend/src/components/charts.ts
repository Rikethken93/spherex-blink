import {
  Chart,
  LinearScale,
  LineElement,
  PointElement,
  LineController,
  ScatterController,
  Tooltip,
  Legend,
} from "chart.js";
import type { SpectrumPoint, LightCurvePoint } from "../api";
import { t } from "../i18n/i18n";

Chart.register(LinearScale, LineElement, PointElement, LineController, ScatterController, Tooltip, Legend);

// Color-blind-safe (Okabe-Ito inspired) palette.
const COLORS = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00"];

let spectrumChart: Chart | null = null;
let lightCurveChart: Chart | null = null;

export function renderSpectrum(canvas: HTMLCanvasElement, points: SpectrumPoint[]): void {
  spectrumChart?.destroy();
  const byDetector = new Map<number, SpectrumPoint[]>();
  for (const p of points) {
    const arr = byDetector.get(p.detector) ?? [];
    arr.push(p);
    byDetector.set(p.detector, arr);
  }

  const datasets = Array.from(byDetector.entries()).map(([detector, pts], i) => ({
    label: `D${detector}`,
    data: pts.map((p) => ({ x: p.wavelength_um, y: p.flux })),
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: COLORS[i % COLORS.length],
    showLine: false,
    pointRadius: 3,
  }));

  spectrumChart = new Chart(canvas, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      scales: {
        x: { type: "linear", title: { display: true, text: "Wavelength (µm)" } },
        y: { title: { display: true, text: "Flux (MJy/sr)" } },
      },
      plugins: { legend: { display: datasets.length > 1 } },
    },
  });
}

export function renderLightCurve(canvas: HTMLCanvasElement, points: LightCurvePoint[]): void {
  lightCurveChart?.destroy();
  lightCurveChart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        {
          label: t("panel.lightcurve"),
          data: points.map((p) => ({ x: p.mjd, y: p.flux })),
          borderColor: COLORS[0],
          backgroundColor: COLORS[0],
          pointRadius: 4,
          showLine: true,
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { type: "linear", title: { display: true, text: "MJD" } },
        y: { title: { display: true, text: "Flux (MJy/sr)" } },
      },
    },
  });
}
