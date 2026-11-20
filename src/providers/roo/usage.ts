import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import type { SourceResult } from "../../types";
import {
	ROO_FAMILY_CONFIG,
	readClineFamilyUsageSync,
} from "../shared/cline-family";
import type { SessionDiscoveryItem } from "../types";

export function readRooUsageSync(
	paths: PlatformPathService = defaultPlatformPathService,
	item?: SessionDiscoveryItem,
): SourceResult {
	return readClineFamilyUsageSync(ROO_FAMILY_CONFIG, paths, item);
}
