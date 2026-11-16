import { defaultPlatformPathService } from "../platform/paths";
import {
	type AntigravityBlobMeta,
	antigravityRoots,
	existingAntigravityRoots,
	loadSummaries,
	loadT3AntigravityMeta,
	openSafeReadonlyDatabase,
	parseWorkspaceUri,
	readAntigravityBlobMeta,
	readAntigravitySidecarCwd,
	readAntigravityStepTimestamp,
	type T3AntigravityMeta,
	t3UserDataDirs,
} from "../providers/antigravity/discovery";
import {
	decodeProto,
	type ProtoField,
	protoSub,
	protoText,
} from "../providers/antigravity/proto";
import { readAntigravityUsageSync } from "../providers/antigravity/usage";
import type { SourceResult } from "../types";

export type { AntigravityBlobMeta, ProtoField, T3AntigravityMeta };
export {
	antigravityRoots,
	decodeProto,
	existingAntigravityRoots,
	loadSummaries,
	loadT3AntigravityMeta,
	openSafeReadonlyDatabase,
	parseWorkspaceUri,
	protoSub,
	protoText,
	readAntigravityBlobMeta,
	readAntigravitySidecarCwd,
	readAntigravityStepTimestamp,
	t3UserDataDirs,
};

export function readAntigravity(): SourceResult {
	return readAntigravityUsageSync(defaultPlatformPathService);
}
