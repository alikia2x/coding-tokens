import type { AppLocale } from "@shared/types";
import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { setFormatLocale } from "./format";
import { de } from "./locales/de";
import { en, type TranslationKey } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { zhCN } from "./locales/zh-CN";
import { zhTW } from "./locales/zh-TW";

export type { TranslationKey };

export const SUPPORTED_LOCALES: ReadonlyArray<{
	code: AppLocale;
	label: string;
}> = [
	{ code: "en", label: "English" },
	{ code: "zh-CN", label: "简体中文" },
	{ code: "zh-TW", label: "繁體中文" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "es", label: "Español" },
	{ code: "fr", label: "Français" },
	{ code: "de", label: "Deutsch" },
];

export const LOCALE_RESOURCES: Record<
	AppLocale,
	Record<TranslationKey, string>
> = {
	en,
	"zh-CN": zhCN,
	"zh-TW": zhTW,
	ja,
	ko,
	es,
	fr,
	de,
};

export function isSupportedLocale(value: string): value is AppLocale {
	return Object.hasOwn(LOCALE_RESOURCES, value);
}

export function normalizeAppLocale(raw: string | null | undefined): AppLocale {
	if (!raw) return "en";
	if (isSupportedLocale(raw)) return raw;
	const lower = raw.toLowerCase();
	if (
		lower.startsWith("zh-tw") ||
		lower.startsWith("zh-hk") ||
		lower.startsWith("zh-mo") ||
		lower.includes("hant")
	) {
		return "zh-TW";
	}
	if (lower.startsWith("zh")) return "zh-CN";
	if (lower.startsWith("ja")) return "ja";
	if (lower.startsWith("ko")) return "ko";
	if (lower.startsWith("es")) return "es";
	if (lower.startsWith("fr")) return "fr";
	if (lower.startsWith("de")) return "de";
	return "en";
}

const detect = (): AppLocale => {
	try {
		const stored = localStorage.getItem("coding-tokens-locale");
		if (stored && isSupportedLocale(stored)) return stored;
	} catch {}
	if (typeof navigator !== "undefined") {
		return normalizeAppLocale(navigator.language);
	}
	return "en";
};

const resources = Object.fromEntries(
	Object.entries(LOCALE_RESOURCES).map(([code, translation]) => [
		code,
		{ translation },
	]),
);

const initialLocale = detect();

void i18n.use(initReactI18next).init({
	resources,
	lng: initialLocale,
	fallbackLng: "en",
	keySeparator: false,
	nsSeparator: false,
	interpolation: { escapeValue: false },
	returnNull: false,
});

export function setAppLocale(locale: AppLocale): void {
	const resolved = normalizeAppLocale(locale);
	void i18n.changeLanguage(resolved);
	try {
		localStorage.setItem("coding-tokens-locale", resolved);
	} catch {}
	setFormatLocale(resolved);
	if (typeof document !== "undefined") {
		document.documentElement.lang = resolved;
	}
}

setFormatLocale(normalizeAppLocale(i18n.language));

export default i18n;

export function useT(): (
	key: TranslationKey,
	options?: Record<string, unknown>,
) => string {
	const { t } = useTranslation();
	return t as unknown as (
		key: TranslationKey,
		options?: Record<string, unknown>,
	) => string;
}
