import { defaultPlatformPathService } from "../platform/paths";
import { readCommandCodeUsageSync } from "../providers/commandcode/usage";
import type { SourceResult } from "../types";

export function readCommandCode(): SourceResult {
	return readCommandCodeUsageSync(defaultPlatformPathService);
}
