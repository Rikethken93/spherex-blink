export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export interface ResolveResult {
  ra_deg: number;
  dec_deg: number;
  name: string | null;
  source: string;
  gaia_source_id: number | null;
  pmra_mas_yr: number | null;
  pmdec_mas_yr: number | null;
  gaia_ref_epoch: number | null;
  propagated_to_epoch: number | null;
  warning: string | null;
}

export interface EpochMeta {
  mjd_min: number;
  mjd_max: number;
  mjd_mean: number;
  n_exposures: number;
  flag_fraction: number;
  detectors: number[];
  wavelengths_um: number[];
}

export interface FramesResult {
  ra_deg: number;
  dec_deg: number;
  fov_arcmin: number;
  mode: string;
  frames: string[];
  frame_urls: string[];
  epochs: EpochMeta[];
  n_exposures_total: number;
  cache_hit: boolean;
}

export interface SpectrumPoint {
  wavelength_um: number;
  flux: number;
  error: number;
  detector: number;
  mjd: number;
}

export interface LightCurvePoint {
  mjd: number;
  mjd_min: number;
  mjd_max: number;
  flux: number;
  error: number;
  n_exposures: number;
  flag_fraction: number;
}

export interface TargetInfo {
  key: string;
  display_name: { en: string; es: string };
  category: string;
  required: boolean;
  note: { en: string; es: string };
  ra_deg: number;
  dec_deg: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString());
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      detail = body.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, detail);
  }
  return resp.json() as Promise<T>;
}

export function resolveName(name: string) {
  return getJson<ResolveResult>("/api/resolve", { name });
}

export function getFrames(
  ra: number | string,
  dec: number | string,
  fov: number,
  mode: string,
  detector?: number,
  wlMin?: number,
  wlMax?: number,
) {
  return getJson<FramesResult>("/api/frames", {
    ra, dec, fov, mode, detector, wl_min: wlMin, wl_max: wlMax,
  });
}

export function getSpectrum(ra: number | string, dec: number | string, fov?: number) {
  return getJson<{ ra_deg: number; dec_deg: number; points: SpectrumPoint[] }>("/api/spectrum", { ra, dec, fov });
}

export function getLightCurve(ra: number | string, dec: number | string, fov?: number) {
  return getJson<{ ra_deg: number; dec_deg: number; points: LightCurvePoint[] }>("/api/lightcurve", { ra, dec, fov });
}

export function getTargets() {
  return getJson<TargetInfo[]>("/api/targets", {});
}

export function frameUrl(path: string): string {
  return path.startsWith("http") ? path : API_BASE + path;
}
