const wrappers = new Set([
	"command-code",
	"commandcode",
	"codex",
	"dsh",
	"antigravity",
	"openai",
	"anthropic",
	"google",
	"deepseek-ai",
	"deepseek-official",
	"openrouter",
	"models",
	"model",
	"chat",
]);

const acronyms = new Set([
	"gpt",
	"api",
	"cli",
	"dsh",
	"mcp",
	"llm",
	"asr",
	"tts",
	"ocr",
	"ui",
	"id",
	"ai",
	"gpu",
	"cpu",
	"json",
	"http",
	"sql",
	"rag",
	"vad",
	"sft",
	"rl",
	"glm",
	"moe",
	"lora",
]);

const brandCasing: Record<string, string> = {
	mimo: "MiMo",
	deepseek: "DeepSeek",
	opencode: "OpenCode",
	codex: "Codex",
	gemini: "Gemini",
	claude: "Claude",
	llama: "Llama",
	qwen: "Qwen",
	kimi: "Kimi",
	grok: "Grok",
	mistral: "Mistral",
	codestral: "Codestral",
	sonnet: "Sonnet",
	opus: "Opus",
	haiku: "Haiku",
	flash: "Flash",
	pro: "Pro",
	air: "Air",
	mini: "Mini",
	nano: "Nano",
	sol: "Sol",
	luna: "Luna",
	astra: "Astra",
	argon: "Argon",
	contributor: "Contributor",
	daybreak: "Daybreak",
	blue: "Blue",
};

function titleWord(word: string): string {
	const lower = word.toLowerCase();
	if (brandCasing[lower]) return brandCasing[lower];
	if (acronyms.has(lower)) return lower.toUpperCase();
	if (/^v\d/iu.test(word)) return `V${word.slice(1)}`;
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function displayFromSlug(slug: string): string {
	let text = slug
		.toLowerCase()
		.replace(/_/gu, "-")
		.replace(/#[^/]+$/u, "")
		.replace(/@[^/]+$/u, "")
		.trim();
	for (let guard = 0; guard < 4; guard += 1) {
		const before = text;
		text = text
			.replace(
				/(?:[\s_-]+(?:latest|stable|preview|trial|free|thinking|high|medium|low|experimental|exp))$/iu,
				"",
			)
			.replace(/(?:[\s_-]+(?:20\d{2}(?:[-_.]?\d{2}){1,2}|\d{6,}|\d{4}))$/iu, "")
			.trim();
		if (text === before) break;
	}
	const rawParts = text.split(/[\s-]+/u).filter(Boolean);
	if (!rawParts.length) return "Unrecorded model";
	const parts = rawParts.map(titleWord);
	if (parts[0] === "GPT" && parts[1] && /^\d/iu.test(parts[1] ?? "")) {
		const [gpt, version, ...rest] = parts;
		return [`${gpt}-${version}`, ...rest].join(" ");
	}
	return parts.join(" ");
}

export function normalizeModelName(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "unknown model")
		return "Unrecorded model";
	let segments = trimmed.split("/").filter(Boolean);
	while (segments.length > 1 && wrappers.has((segments[0] ?? "").toLowerCase()))
		segments = segments.slice(1);
	if (segments.length > 1) {
		const last = segments.at(-1) ?? "";
		if (!last || wrappers.has(last.toLowerCase()))
			segments = segments.slice(0, -1);
	}
	const slug = segments.at(-1) ?? trimmed;
	return displayFromSlug(slug);
}

export function modelProvider(model: string): string | null {
	const value = model.toLowerCase();
	const rules: Array<[RegExp, string]> = [
		[/^(?:gpt-|o[1-4](?:\b|$)|codex)/u, "OpenAI"],
		[/^claude/u, "Anthropic"],
		[/^(?:gemini|gemma)/u, "Google"],
		[/^deepseek/u, "DeepSeek"],
		[/^(?:mimo|xiaomi)/u, "Xiaomi"],
		[/^(?:qwen|qwq)/u, "Alibaba"],
		[/^(?:kimi|moonshot)/u, "Moonshot"],
		[/^(?:glm|chatglm)/u, "Zhipu"],
		[/^grok/u, "xAI"],
		[/^(?:llama|meta-llama)/u, "Meta"],
		[/^(?:mistral|codestral)/u, "Mistral"],
		[/^(?:command-r|aya)/u, "Cohere"],
	];
	for (const [pattern, provider] of rules) {
		if (pattern.test(value)) return provider;
	}
	return null;
}
