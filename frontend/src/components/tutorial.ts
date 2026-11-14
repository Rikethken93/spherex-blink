import { t } from "../i18n/i18n";

export function renderTutorialContent(container: HTMLElement): void {
  container.innerHTML = `
    <h2 id="tutorial-title">${t("tutorial.title")}</h2>
    <p>${t("tutorial.p1")}</p>
    <p>${t("tutorial.p2")}</p>
    <p>${t("tutorial.p3")}</p>
    <p>${t("tutorial.p4")}</p>
  `;
}

export function setupTutorialDialog(dialog: HTMLDialogElement, openButton: HTMLButtonElement, contentHost: HTMLElement): void {
  openButton.addEventListener("click", () => {
    renderTutorialContent(contentHost);
    dialog.showModal();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}
