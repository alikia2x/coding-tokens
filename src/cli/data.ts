import { store } from "../../server/data/store";
import { defaultPlatformPathService } from "../platform/paths";
import { resolveDatabasePath } from "../services/storage";
import { CLI_NAME, CliUsageError } from "./args";
import { createSpinner, type Style } from "./terminal";

export interface StoreRunOptions {
	dbPath?: string;
	fresh?: boolean;
	quiet?: boolean;
	json?: boolean;
	noColor?: boolean;
}

export async function withCliStore<T>(
	options: StoreRunOptions,
	fn: (s: typeof store) => Promise<T>,
): Promise<T> {
	const resolvedDbPath = options.dbPath
		? defaultPlatformPathService.normalize(
				defaultPlatformPathService.expandPath(options.dbPath),
			)
		: resolveDatabasePath({});

	const spinner = createSpinner({
		quiet: options.quiet,
		json: options.json,
		noColor: options.noColor,
	});
	spinner.start("Indexing local sessions...");
	try {
		store.configure({
			dbPath: resolvedDbPath,
			useIndexWorker: false,
			skipAutoPricingRefresh: true,
		});
		await store.start();
		if (options.fresh) {
			spinner.update("Refreshing index...");
			await store.refresh();
		}
		await store.ensureReady();
		spinner.stop();
		return await fn(store);
	} finally {
		spinner.stop();
		store.close();
	}
}

export function resolveSessionKey(s: typeof store, input: string): string {
	const raw = input.trim();
	if (!raw) {
		throw new CliUsageError("Session ID cannot be empty", {
			hint: `Run "${CLI_NAME} sessions" to list available sessions`,
		});
	}

	if (s.sessionEntry(raw)) {
		return raw;
	}

	const entries = [...s.catalogEntries().keys()];
	const exactIdMatches = entries.filter((key) => {
		const sep = key.indexOf(":");
		return sep > 0 && key.slice(sep + 1) === raw;
	});
	if (exactIdMatches.length === 1 && exactIdMatches[0]) {
		return exactIdMatches[0];
	}
	if (exactIdMatches.length > 1) {
		throw new CliUsageError(
			`Multiple sessions share ID "${raw}": ${exactIdMatches.slice(0, 5).join(", ")}`,
			{ hint: "Pass the full harness:sessionId key to disambiguate" },
		);
	}

	const lower = raw.toLowerCase();
	const prefixMatches = entries.filter((key) => {
		const sep = key.indexOf(":");
		const sessionId = sep > 0 ? key.slice(sep + 1) : key;
		return (
			key.toLowerCase().startsWith(lower) ||
			sessionId.toLowerCase().startsWith(lower)
		);
	});

	if (prefixMatches.length === 1 && prefixMatches[0]) {
		return prefixMatches[0];
	}
	if (prefixMatches.length > 1) {
		const preview = prefixMatches.slice(0, 5).join(", ");
		const extra =
			prefixMatches.length > 5 ? ` and ${prefixMatches.length - 5} more` : "";
		throw new CliUsageError(
			`Session prefix "${raw}" is ambiguous (${preview}${extra})`,
			{ hint: "Provide a longer prefix or full harness:sessionId key" },
		);
	}

	throw new CliUsageError(`Session not found: ${raw}`, {
		hint: `Run "${CLI_NAME} sessions" to list sessions or search by keyword`,
	});
}

export function printWarnings(
	warnings: readonly string[],
	style: Style,
	quiet = false,
): void {
	if (quiet || warnings.length === 0) return;
	const unique = [...new Set(warnings)];
	for (const warning of unique) {
		console.error(`${style.yellow("Warning:")} ${warning}`);
	}
}
