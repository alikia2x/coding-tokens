import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import type { SourceResult } from "../../types";
import {
	CLINE_FAMILY_CONFIG,
	readClineFamilyUsageSync,
} from "../shared/cline-family";
import type { SessionDiscoveryItem } from "../types";

export function readClineUsageSync(
	paths: PlatformPathService = defaultPlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	return readClineFamilyUsageSync(CLINE_FAMILY_CONFIG, paths, item);
}
