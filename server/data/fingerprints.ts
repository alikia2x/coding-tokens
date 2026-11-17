import type { HarnessName } from "@shared/types";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import { computeFilesFingerprint } from "../../src/providers/utils";

export async function sourceFingerprint(harness: HarnessName): Promise<string> {
	const provider = defaultHarnessRegistry.get(harness);
	if (!provider) {
		return computeFilesFingerprint([]);
	}
	return provider.computeFingerprint(defaultPlatformPathService);
}
