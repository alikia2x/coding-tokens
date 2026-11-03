import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
	new URL("../../app/lib/i18n.ts", import.meta.url),
	"utf8",
);

function translationBlock(startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker);
	if (start === -1) throw new Error(`Missing ${startMarker}`);
	const end = source.indexOf(endMarker, start);
	if (end === -1) throw new Error(`Missing ${endMarker} after ${startMarker}`);
	return source.slice(start, end);
}

function entries(block: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const match of block.matchAll(
		/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?$/gmu,
	)) {
		const key = match[1];
		const value = match[2];
		if (key && value !== undefined) result.set(key, value);
	}
	return result;
}

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{\{\s*([^},\s]+)/gu)]
		.map((match) => match[1] ?? "")
		.sort();
}

const en = entries(translationBlock("const en = {", "} as const;"));
const zh = entries(
	translationBlock("const zh: Record<TranslationKey, string> = {", "\n};"),
);

describe("i18n resources", () => {
	test("both locales define the same keys", () => {
		expect([...zh.keys()].sort()).toEqual([...en.keys()].sort());
	});

	test("translations keep interpolation placeholders in sync", () => {
		const mismatches = [...en].flatMap(([key, value]) => {
			const translated = zh.get(key) ?? "";
			return JSON.stringify(placeholders(value)) ===
				JSON.stringify(placeholders(translated))
				? []
				: [key];
		});
		expect(mismatches).toEqual([]);
	});
});
