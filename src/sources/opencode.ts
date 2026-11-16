import { defaultPlatformPathService } from "../platform/paths";
import { readOpenCodeUsageSync } from "../providers/opencode/usage";
import type { SourceResult } from "../types";

export function readOpenCode(): SourceResult {
	return readOpenCodeUsageSync(defaultPlatformPathService);
}
