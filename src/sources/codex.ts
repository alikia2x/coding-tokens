import { defaultPlatformPathService } from "../platform/paths";
import { readCodexUsageSync } from "../providers/codex/usage";
import type { SourceResult } from "../types";

export function readCodex(): SourceResult {
	return readCodexUsageSync(defaultPlatformPathService);
}
