import { describe, expect, test } from "bun:test";
import { modelProvider, normalizeModelName } from "../../shared/models";

describe("normalizeModelName", () => {
	test("strips wrapper and provider prefixes", () => {
		expect(
			normalizeModelName("command-code/deepseek/deepseek-v4.1-flash"),
		).toBe("DeepSeek V4.1 Flash");
	});

	test("merges date and free suffixes", () => {
		expect(normalizeModelName("DeepSeek V4.1 Flash 1017")).toBe(
			"DeepSeek V4.1 Flash",
		);
		expect(normalizeModelName("MiMo-V2.6-Flash Free")).toBe("MiMo V2.6 Flash");
	});

	test("keeps readable names for internal models", () => {
		expect(normalizeModelName("codex-auto-review")).toBe("Codex Auto Review");
		expect(normalizeModelName("gemini-4-argon-trial")).toBe("Gemini 4 Argon");
		expect(normalizeModelName("gemini-4-argon-s")).toBe("Gemini 4 Argon");
		expect(normalizeModelName("gemini-3.8-flash-n")).toBe("Gemini 3.8 Flash");
	});

	test("falls back for missing models", () => {
		expect(normalizeModelName("Unknown model")).toBe("Unrecorded model");
	});
});

describe("modelProvider", () => {
	test("infers providers from canonical names", () => {
		expect(modelProvider("GPT-6.1 Sol")).toBe("OpenAI");
		expect(modelProvider("DeepSeek V4.1 Flash")).toBe("DeepSeek");
		expect(modelProvider("Gemini 3.8 Flash")).toBe("Google");
		expect(modelProvider("Codex Auto Review")).toBe("OpenAI");
	});
});
