import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	CLINE_FAMILY_CONFIG,
	type ClineFamilyTaskHistoryItem,
	discoverClineFamilySessions,
	findClineFamilyTaskHistoryFiles,
	findClineFamilyTasksDirs,
	getClineFamilyRoots,
	getClineFamilySessionFiles,
} from "../shared/cline-family";
import type { SessionDiscoveryItem } from "../types";

export type ClineTaskHistoryItem = ClineFamilyTaskHistoryItem;

export function getClineRoots(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	return getClineFamilyRoots(CLINE_FAMILY_CONFIG, paths);
}

export function findClineTaskHistoryFiles(roots: string[]): string[] {
	return findClineFamilyTaskHistoryFiles(roots);
}

export function findClineTasksDirs(roots: string[]): string[] {
	return findClineFamilyTasksDirs(roots);
}

export function getClineSessionFiles(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	return getClineFamilySessionFiles(CLINE_FAMILY_CONFIG, paths);
}

export async function discoverClineSessions(
	paths: PlatformPathService = defaultPlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	return discoverClineFamilySessions(CLINE_FAMILY_CONFIG, paths);
}
