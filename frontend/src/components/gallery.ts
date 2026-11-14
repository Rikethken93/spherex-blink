import type { TargetInfo } from "../api";
import { getLang, t } from "../i18n/i18n";

export function renderGallery(container: HTMLElement, targets: TargetInfo[], onPick: (t: TargetInfo) => void): void {
  const lang = getLang() === "es" ? "es" : "en";
  const required = targets.filter((tg) => tg.required);
  const extra = targets.filter((tg) => !tg.required);

  container.innerHTML = `
    <h2>${t("gallery.title")}</h2>
    <h3>${t("gallery.required")}</h3>
    <ul class="gallery-grid" data-group="required"></ul>
    <h3>${t("gallery.extra")}</h3>
    <ul class="gallery-grid" data-group="extra"></ul>
  `;

  const fill = (group: "required" | "extra", items: TargetInfo[]) => {
    const ul = container.querySelector<HTMLUListElement>(`[data-group="${group}"]`);
    if (!ul) return;
    for (const target of items) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gallery-card";
      button.innerHTML = `
        <strong>${target.display_name[lang]}</strong>
        <span class="gallery-category">${t(`category.${target.category}`)}</span>
        <p>${target.note[lang]}</p>
      `;
      button.addEventListener("click", () => onPick(target));
      li.appendChild(button);
      ul.appendChild(li);
    }
  };

  fill("required", required);
  fill("extra", extra);
}
