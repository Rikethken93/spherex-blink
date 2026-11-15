export interface AppState {
  ra: string;
  dec: string;
  fov: number;
  mode: string;
  lang: string;
  lowBandwidth: boolean;
}

const DEFAULTS: AppState = {
  ra: "",
  dec: "",
  // Matches backend/app/config.py's FOV_DEFAULT_ARCMIN -- SPHEREx's native
  // pixel scale is ~6.2"/pixel, so 3' was only ~29 native pixels across;
  // 6' gives meaningfully more context around a target without losing
  // visible proper motion for this app's demo targets.
  fov: 6,
  mode: "blink",
  // English-first by default (judges should never land on Spanish by
  // accident because of their browser's locale setting) -- Spanish is a
  // one-click toggle or an explicit ?lang=es away, not auto-detected.
  lang: "en",
  lowBandwidth: false,
};

export function readStateFromUrl(): AppState {
  const params = new URLSearchParams(window.location.search);
  return {
    ra: params.get("ra") ?? DEFAULTS.ra,
    dec: params.get("dec") ?? DEFAULTS.dec,
    fov: params.has("fov") ? Number(params.get("fov")) : DEFAULTS.fov,
    mode: params.get("mode") ?? DEFAULTS.mode,
    lang: params.get("lang") ?? DEFAULTS.lang,
    lowBandwidth: params.get("lowbw") === "1",
  };
}

export function writeStateToUrl(state: AppState, replace = true): void {
  const params = new URLSearchParams();
  if (state.ra) params.set("ra", state.ra);
  if (state.dec) params.set("dec", state.dec);
  params.set("fov", String(state.fov));
  params.set("mode", state.mode);
  params.set("lang", state.lang);
  if (state.lowBandwidth) params.set("lowbw", "1");
  const url = `${window.location.pathname}?${params.toString()}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

export function shareUrl(state: AppState): string {
  const params = new URLSearchParams();
  if (state.ra) params.set("ra", state.ra);
  if (state.dec) params.set("dec", state.dec);
  params.set("fov", String(state.fov));
  params.set("mode", state.mode);
  params.set("lang", state.lang);
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

export function embedSnippet(state: AppState): string {
  const url = shareUrl(state);
  return `<iframe src="${url}" width="900" height="650" loading="lazy" style="border:0" title="SPHEREx Blink"></iframe>`;
}
