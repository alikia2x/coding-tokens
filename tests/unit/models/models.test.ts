import { describe, expect, test } from "bun:test";
import { modelProvider, normalizeModelName } from "../../../shared/models";

describe("Models: Model Normalization & Provider Inference (Feature 4)", () => {
	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F4-T1-04: Model name normalization with canonical brand casing", () => {
		expect(normalizeModelName("gpt-4o-2024-08-06")).toBe("GPT-4o");
		expect(normalizeModelName("gpt-4-turbo")).toBe("GPT-4 Turbo");
		expect(normalizeModelName("claude-3.5-sonnet-20241022")).toBe(
			"Claude 3.5 Sonnet",
		);
		expect(normalizeModelName("claude-3-5-sonnet-20241022")).toBe(
			"Claude 3 5 Sonnet",
		);
		expect(normalizeModelName("claude-3-opus-20240229")).toBe("Claude 3 Opus");
		expect(normalizeModelName("claude-3-5-haiku-20241022")).toBe(
			"Claude 3 5 Haiku",
		);
		expect(normalizeModelName("deepseek-chat")).toBe("DeepSeek Chat");
		expect(normalizeModelName("deepseek-reasoner")).toBe("DeepSeek Reasoner");
		expect(normalizeModelName("gemini-1.5-pro")).toBe("Gemini 1.5 Pro");
		expect(normalizeModelName("gemini-2.0-flash")).toBe("Gemini 2.0 Flash");
		expect(normalizeModelName("qwen-2.5-coder-32b")).toBe("Qwen 2.5 Coder 32b");
	});

	test("F4-T1-05: Model provider inference for all major providers", () => {
		// OpenAI
		expect(modelProvider("gpt-4o")).toBe("OpenAI");
		expect(modelProvider("gpt-3.5-turbo")).toBe("OpenAI");
		expect(modelProvider("o1-preview")).toBe("OpenAI");
		expect(modelProvider("o3-mini")).toBe("OpenAI");
		expect(modelProvider("codex-davinci")).toBe("OpenAI");

		// Anthropic
		expect(modelProvider("claude-3-5-sonnet")).toBe("Anthropic");
		expect(modelProvider("claude-3-opus")).toBe("Anthropic");

		// Google
		expect(modelProvider("gemini-1.5-pro")).toBe("Google");
		expect(modelProvider("gemini-2.0-flash-exp")).toBe("Google");
		expect(modelProvider("gemma-2-9b")).toBe("Google");

		// DeepSeek
		expect(modelProvider("deepseek-chat")).toBe("DeepSeek");
		expect(modelProvider("deepseek-reasoner")).toBe("DeepSeek");

		// Xiaomi
		expect(modelProvider("mimo-v1")).toBe("Xiaomi");
		expect(modelProvider("xiaomi-mimo")).toBe("Xiaomi");

		// Alibaba
		expect(modelProvider("qwen-max")).toBe("Alibaba");
		expect(modelProvider("qwq-32b-preview")).toBe("Alibaba");

		// Moonshot
		expect(modelProvider("kimi-latest")).toBe("Moonshot");
		expect(modelProvider("moonshot-v1-8k")).toBe("Moonshot");

		// Zhipu
		expect(modelProvider("glm-4-plus")).toBe("Zhipu");
		expect(modelProvider("chatglm-pro")).toBe("Zhipu");

		// xAI
		expect(modelProvider("grok-2")).toBe("xAI");
		expect(modelProvider("grok-beta")).toBe("xAI");

		// Meta
		expect(modelProvider("llama-3.1-405b")).toBe("Meta");
		expect(modelProvider("meta-llama-3-70b")).toBe("Meta");

		// Mistral
		expect(modelProvider("mistral-large")).toBe("Mistral");
		expect(modelProvider("codestral-latest")).toBe("Mistral");

		// Cohere
		expect(modelProvider("command-r-plus")).toBe("Cohere");
		expect(modelProvider("aya-23")).toBe("Cohere");
	});

	// =========================================================================
	// Tier 2: Boundary & Edge Cases
	// =========================================================================

	test("F4-T2-05: Extreme model slug normalization", () => {
		// Empty and whitespace inputs
		expect(normalizeModelName("")).toBe("Unrecorded model");
		expect(normalizeModelName("   ")).toBe("Unrecorded model");
		expect(normalizeModelName("unknown model")).toBe("Unrecorded model");
		expect(normalizeModelName("UNKNOWN MODEL")).toBe("Unrecorded model");

		// Repeated harness/provider wrappers stripped to canonical model
		expect(normalizeModelName("openai/codex/models/gpt-4o")).toBe("GPT-4o");
		expect(normalizeModelName("anthropic/claude-3.5-sonnet")).toBe(
			"Claude 3.5 Sonnet",
		);
		expect(normalizeModelName("anthropic/claude-3-5-sonnet")).toBe(
			"Claude 3 5 Sonnet",
		);
		expect(normalizeModelName("openrouter/deepseek-ai/deepseek-chat")).toBe(
			"DeepSeek Chat",
		);
		expect(normalizeModelName("commandcode/models/gpt-4o")).toBe("GPT-4o");

		// Tags, hashes, and version suffix stripping
		expect(normalizeModelName("gpt-4o#experimental")).toBe("GPT-4o");
		expect(normalizeModelName("claude-3.5-sonnet@latest")).toBe(
			"Claude 3.5 Sonnet",
		);
		expect(normalizeModelName("claude-3-5-sonnet@latest")).toBe(
			"Claude 3 5 Sonnet",
		);
		expect(normalizeModelName("deepseek-chat-latest")).toBe("DeepSeek Chat");
		expect(normalizeModelName("gpt-4o-trial")).toBe("GPT-4o");
		expect(normalizeModelName("claude-3-haiku-free")).toBe("Claude 3 Haiku");
	});

	test("F4-T2-06: Unrecognized model provider fallback returns null without throwing", () => {
		expect(modelProvider("custom-internal-model-123")).toBeNull();
		expect(modelProvider("random-local-model")).toBeNull();
		expect(modelProvider("")).toBeNull();
		expect(modelProvider("foo-bar-baz")).toBeNull();
	});
});
