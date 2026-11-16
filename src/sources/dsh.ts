import { defaultPlatformPathService } from "../platform/paths";
import { readDshUsageSync } from "../providers/dsh/usage";
import type { SourceResult } from "../types";

export function readDsh(): SourceResult {
	return readDshUsageSync(defaultPlatformPathService);
}
