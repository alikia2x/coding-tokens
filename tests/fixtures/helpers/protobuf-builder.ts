/**
 * Protobuf wire-format generator for Antigravity and Windsurf mock blobs.
 * Adheres strictly to Protocol Buffers Encoding Specification:
 * - Wire Type 0: Varint (int32, int64, uint32, bool, enum)
 * - Wire Type 1: 64-bit fixed (fixed64, double)
 * - Wire Type 2: Length-delimited (string, bytes, embedded messages)
 * - Wire Type 5: 32-bit fixed (fixed32, float)
 */

export function protoVarint(
	fieldNumber: number,
	value: number | bigint,
): Uint8Array {
	const bytes: number[] = [];
	let tag = (fieldNumber << 3) | 0;
	while (tag >= 128) {
		bytes.push((tag & 127) | 128);
		tag >>>= 7;
	}
	bytes.push(tag);

	let v = BigInt.asUintN(64, BigInt(value));
	while (v >= 128n) {
		bytes.push(Number(v & 127n) | 128);
		v >>= 7n;
	}
	bytes.push(Number(v));
	return new Uint8Array(bytes);
}

export function protoBytes(
	fieldNumber: number,
	content: Uint8Array | string,
): Uint8Array {
	const payload =
		typeof content === "string" ? new TextEncoder().encode(content) : content;
	const header: number[] = [];
	let tag = (fieldNumber << 3) | 2;
	while (tag >= 128) {
		header.push((tag & 127) | 128);
		tag >>>= 7;
	}
	header.push(tag);

	let len = payload.length;
	while (len >= 128) {
		header.push((len & 127) | 128);
		len >>>= 7;
	}
	header.push(len);

	const out = new Uint8Array(header.length + payload.length);
	out.set(header, 0);
	out.set(payload, header.length);
	return out;
}

export function protoConcat(...parts: (Uint8Array | undefined)[]): Uint8Array {
	const validParts = parts.filter(
		(p): p is Uint8Array => p !== undefined && p.length > 0,
	);
	const total = validParts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of validParts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/**
 * Builds an Antigravity trajectory_metadata_blob payload.
 */
export function buildAntigravityTrajectoryMetadata(options: {
	conversationId?: string;
	cwd?: string;
	parentId?: string;
	isSubagent?: boolean;
	workerName?: string;
}): Uint8Array {
	const parts: Uint8Array[] = [];

	if (options.parentId) {
		parts.push(protoBytes(5, options.parentId));
	}
	if (options.conversationId) {
		parts.push(protoBytes(6, options.conversationId));
	}
	if (options.cwd) {
		const uri = options.cwd.startsWith("file://")
			? options.cwd
			: `file://${options.cwd}`;
		parts.push(protoBytes(7, uri));
	}
	if (options.workerName) {
		const workerPayload = protoConcat(
			protoBytes(1, "worker"),
			protoBytes(2, options.workerName),
		);
		parts.push(protoBytes(8, workerPayload));
	}
	if (options.isSubagent) {
		parts.push(protoVarint(17, 1));
	}

	return protoConcat(...parts);
}

/**
 * Builds an Antigravity step timestamp metadata payload.
 */
export function buildAntigravityTimestampMeta(
	timestampSec = 1773500000,
): Uint8Array {
	return protoBytes(
		1,
		protoConcat(protoVarint(1, timestampSec), protoVarint(2, 0)),
	);
}

/**
 * Builds an Antigravity step_payload block.
 */
export function buildAntigravityStepPayload(options: {
	userRequest?: string;
	instructionWrapper?: boolean;
}): Uint8Array {
	const text = options.userRequest ?? "Hello Antigravity";
	const content = options.instructionWrapper
		? `<t3_code_instructions>instructions</t3_code_instructions><user_request>${text}</user_request>`
		: text;
	return protoBytes(19, protoBytes(2, content));
}

/**
 * Builds an Antigravity gen_metadata row payload containing token metrics.
 */
export function buildAntigravityGenMetadata(options: {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	reasoningTokens?: number;
	requestId?: string;
	lastStepIndex?: number;
	subagentType?: string;
}): Uint8Array {
	const kvPair = (k: string, v: string) =>
		protoBytes(20, protoConcat(protoBytes(1, k), protoBytes(2, v)));

	const f4Parts: Uint8Array[] = [
		protoVarint(2, options.inputTokens),
		protoVarint(3, options.outputTokens),
	];

	if (options.cacheReadTokens !== undefined) {
		f4Parts.push(protoVarint(5, options.cacheReadTokens));
	}
	f4Parts.push(protoVarint(6, 24)); // enum flag
	if (options.reasoningTokens !== undefined) {
		f4Parts.push(protoVarint(9, options.reasoningTokens));
	}

	const f4 = protoConcat(...f4Parts);

	const f1Parts: Uint8Array[] = [
		protoBytes(4, f4),
		protoBytes(19, options.model),
		kvPair("request_id", options.requestId ?? "req-ag-default"),
		kvPair("last_step_index", String(options.lastStepIndex ?? 0)),
	];

	if (options.subagentType) {
		f1Parts.push(kvPair("subagent_type", options.subagentType));
	}

	const f1 = protoConcat(...f1Parts);
	return protoBytes(1, f1);
}

/**
 * Builds a Windsurf chat_state Protobuf wire blob.
 */
export function buildWindsurfChatStateBlob(options: {
	conversationId?: string;
	model?: string;
	prompt?: string;
	completion?: string;
	inputTokens?: number;
	outputTokens?: number;
	timestamp?: number;
}): Uint8Array {
	const interactionParts: Uint8Array[] = [];

	if (options.prompt) {
		interactionParts.push(protoBytes(1, options.prompt));
	}
	if (options.completion) {
		interactionParts.push(protoBytes(2, options.completion));
	}
	if (options.timestamp) {
		interactionParts.push(protoVarint(3, options.timestamp));
	}
	if (options.inputTokens !== undefined || options.outputTokens !== undefined) {
		const tokenParts = [
			protoVarint(1, options.inputTokens ?? 0),
			protoVarint(2, options.outputTokens ?? 0),
		];
		interactionParts.push(protoBytes(4, protoConcat(...tokenParts)));
	}

	const rootParts: Uint8Array[] = [
		protoBytes(1, options.conversationId ?? "windsurf-sess-default"),
		protoBytes(2, options.model ?? "claude-3-5-sonnet"),
	];

	if (interactionParts.length > 0) {
		rootParts.push(protoBytes(3, protoConcat(...interactionParts)));
	}

	return protoConcat(...rootParts);
}
