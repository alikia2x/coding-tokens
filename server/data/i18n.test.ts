import { describe, expect, test } from "bun:test";
import i18n, {
	LOCALE_RESOURCES,
	normalizeAppLocale,
	SUPPORTED_LOCALES,
} from "../../app/lib/i18n";

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{\{\s*([^},\s]+)/gu)]
		.map((match) => match[1] ?? "")
		.sort();
}

describe("i18n resources", () => {
	const enKeys = Object.keys(LOCALE_RESOURCES.en).sort();

	test("SUPPORTED_LOCALES matches LOCALE_RESOURCES", () => {
		expect(SUPPORTED_LOCALES.map((item): string => item.code).sort()).toEqual(
			Object.keys(LOCALE_RESOURCES).sort(),
		);
		expect(SUPPORTED_LOCALES.length).toBe(8);
	});

	test("all locales define the exact same keys as en without empty strings", () => {
		for (const { code } of SUPPORTED_LOCALES) {
			const catalog = LOCALE_RESOURCES[code];
			expect(Object.keys(catalog).sort()).toEqual(enKeys);
			const emptyKeys = Object.entries(catalog)
				.filter(([, value]) => value.trim().length === 0)
				.map(([key]) => key);
			expect(emptyKeys).toEqual([]);
		}
	});

	test("all locales keep interpolation placeholders in sync with en", () => {
		for (const { code } of SUPPORTED_LOCALES) {
			if (code === "en") continue;
			const catalog = LOCALE_RESOURCES[code];
			const mismatches = Object.entries(LOCALE_RESOURCES.en).flatMap(
				([key, enValue]) => {
					const translated = catalog[key as keyof typeof catalog] ?? "";
					return JSON.stringify(placeholders(enValue)) ===
						JSON.stringify(placeholders(translated))
						? []
						: [`${code}:${key}`];
				},
			);
			expect(mismatches).toEqual([]);
		}
	});

	test("normalizeAppLocale resolves regional browser tags accurately", () => {
		expect(normalizeAppLocale("zh-CN")).toBe("zh-CN");
		expect(normalizeAppLocale("zh-Hans-CN")).toBe("zh-CN");
		expect(normalizeAppLocale("zh-TW")).toBe("zh-TW");
		expect(normalizeAppLocale("zh-HK")).toBe("zh-TW");
		expect(normalizeAppLocale("zh-Hant")).toBe("zh-TW");
		expect(normalizeAppLocale("ja-JP")).toBe("ja");
		expect(normalizeAppLocale("ko-KR")).toBe("ko");
		expect(normalizeAppLocale("es-MX")).toBe("es");
		expect(normalizeAppLocale("fr-CA")).toBe("fr");
		expect(normalizeAppLocale("de-DE")).toBe("de");
		expect(normalizeAppLocale("pt-BR")).toBe("en");
	});

	test("natural count quantifiers and plurals render cleanly across locales", async () => {
		const tEn = i18n.getFixedT("en");
		expect(tEn("count.sessions", { count: 1, formatted: "1" })).toBe(
			"1 session",
		);
		expect(tEn("count.sessions", { count: 18, formatted: "18" })).toBe(
			"18 sessions",
		);

		const tZhCn = i18n.getFixedT("zh-CN");
		expect(tZhCn("count.sessions", { count: 18, formatted: "18" })).toBe(
			"18 条会话",
		);
		expect(tZhCn("session.turnNumber", { index: 3 })).toBe("第 3 轮");

		const tZhTw = i18n.getFixedT("zh-TW");
		expect(tZhTw("count.sessions", { count: 18, formatted: "18" })).toBe(
			"18 條工作階段",
		);

		const tJa = i18n.getFixedT("ja");
		expect(tJa("count.sessions", { count: 18, formatted: "18" })).toBe(
			"18 件のセッション",
		);

		const tKo = i18n.getFixedT("ko");
		expect(tKo("count.sessions", { count: 18, formatted: "18" })).toBe(
			"세션 18개",
		);

		const tEs = i18n.getFixedT("es");
		expect(tEs("count.sessions", { count: 1, formatted: "1" })).toBe(
			"1 sesión",
		);
		expect(tEs("count.sessions", { count: 18, formatted: "18" })).toBe(
			"18 sesiones",
		);

		const tFr = i18n.getFixedT("fr");
		expect(tFr("count.sessions", { count: 1, formatted: "1" })).toBe(
			"1 session",
		);

		const tDe = i18n.getFixedT("de");
		expect(tDe("count.sessions", { count: 1, formatted: "1" })).toBe(
			"1 Sitzung",
		);
		expect(tDe("count.sessions", { count: 18, formatted: "18" })).toBe(
			"18 Sitzungen",
		);
	});
});
