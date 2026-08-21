import { getCurrentLanguage, t } from "../shared/i18n";

/** 将当前语言应用到已有 DOM；翻译查询本身仍由共享语言服务提供。 */
export function applyTranslations(root: ParentNode = document): void {
	for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
		element.textContent = t(element.dataset.i18n || "");
	}
	for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
		element.title = t(element.dataset.i18nTitle || "");
	}
	for (const element of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]")) {
		element.placeholder = t(element.dataset.i18nPlaceholder || "");
	}
	for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
		element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel || ""));
	}
	document.documentElement.lang = getCurrentLanguage() === "zh-Hans" ? "zh-CN" : "en";
}
