import en from '../../locales/en.json';
import zhHans from '../../locales/zh-Hans.json';

type TranslationMap = Record<string, string>;
type LanguageChangeListener = (language: SupportedLanguage) => void;

export type SupportedLanguage = 'zh-Hans' | 'en';

const dictionaries: Record<SupportedLanguage, TranslationMap> = {
	'zh-Hans': zhHans,
	en,
};

const languageChangeListeners = new Set<LanguageChangeListener>();
let currentLanguage = normalizeLanguage(globalThis.navigator?.language);
let initialized = false;

export function t(tag: string, ...args: Array<string | number>): string {
	const api = getI18nApi();
	if (api?.text) {
		try {
			const translated = api.text(tag, undefined, undefined, ...args);
			if (translated && translated !== tag) return translated;
		}
		catch {
			// 本地预览和旧版宿主使用下方的内置词典。
		}
	}

	const template = dictionaries[currentLanguage][tag]
		?? dictionaries['zh-Hans'][tag]
		?? dictionaries.en[tag]
		?? tag;
	return interpolate(template, args);
}

export function getCurrentLanguage(): SupportedLanguage {
	return currentLanguage;
}

export function getNumberLocale(): string {
	return currentLanguage === 'zh-Hans' ? 'zh-CN' : 'en-US';
}

export function onLanguageChanged(listener: LanguageChangeListener): () => void {
	languageChangeListeners.add(listener);
	return () => languageChangeListeners.delete(listener);
}

export async function initializeI18n(): Promise<SupportedLanguage> {
	if (initialized) return currentLanguage;
	initialized = true;
	const api = getI18nApi();
	if (!api) return currentLanguage;

	try {
		const language = await api.getCurrentLanguage?.();
		if (language) setLanguage(language);
	}
	catch {
		// 保留浏览器语言回退逻辑。
	}

	try {
		api.addLanguageChangedEventListener?.(
			`ngspice-waveform-language-${isIframeContext() ? 'iframe' : 'host'}`,
			(newLanguage: string) => setLanguage(newLanguage),
			false,
		);
	}
	catch {
		// 旧版 EDA 宿主可以不支持语言变更监听。
	}
	return currentLanguage;
}

function isIframeContext(): boolean {
	try {
		return Boolean(globalThis.window && globalThis.window.parent !== globalThis.window);
	}
	catch {
		return false;
	}
}

function setLanguage(language: string): void {
	const next = normalizeLanguage(language);
	if (next === currentLanguage) return;
	currentLanguage = next;
	for (const listener of languageChangeListeners) listener(next);
}

function normalizeLanguage(language?: string): SupportedLanguage {
	const normalized = String(language || '').trim().toLowerCase();
	return normalized.startsWith('zh') ? 'zh-Hans' : 'en';
}

function interpolate(template: string, args: Array<string | number>): string {
	return template.replace(/\$\{(\d+)\}/g, (match, indexText: string) => {
		const index = Number(indexText) - 1;
		return index >= 0 && index < args.length ? String(args[index]) : match;
	});
}

function getI18nApi(): any | null {
	try {
		const ownEda = (globalThis as any).eda;
		if (ownEda?.sys_I18n) return ownEda.sys_I18n;
	}
	catch {
		// 忽略当前上下文无法访问 EDA 对象的情况。
	}
	try {
		const parentEda = globalThis.window?.parent && (globalThis.window.parent as any).eda;
		return parentEda?.sys_I18n || null;
	}
	catch {
		return null;
	}
}
