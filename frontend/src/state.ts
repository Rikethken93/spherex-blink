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
  fov: 3,
  mode: "blink",
  lang: detectLang(),
  lowBandwidth: false,
};

function detectLang(): string {
  const nav = navigator.language ?? "en";
  return nav.toLowerCase().startsWith("es") ? "es" : "en";
}

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
