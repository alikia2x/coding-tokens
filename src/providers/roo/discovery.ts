import type { PlatformPathService } from "../../platform/paths";
import { defaultPlatformPathService } from "../../platform/paths";
import {
	type ClineFamilyTaskHistoryItem,
	discoverClineFamilySessions,
	findClineFamilyTaskHistoryFiles,
	findClineFamilyTasksDirs,
	getClineFamilyRoots,
	getClineFamilySessionFiles,
	ROO_FAMILY_CONFIG,
} from "../shared/cline-family";
import type { SessionDiscoveryItem } from "../types";

export type RooTaskHistoryItem = ClineFamilyTaskHistoryItem;

export function getRooRoots(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	return getClineFamilyRoots(ROO_FAMILY_CONFIG, paths);
}

export function findRooTaskHistoryFiles(roots: string[]): string[] {
	return findClineFamilyTaskHistoryFiles(roots);
}

export function findRooTasksDirs(roots: string[]): string[] {
	return findClineFamilyTasksDirs(roots);
}

export function getRooSessionFiles(
	paths: PlatformPathService = defaultPlatformPathService,
): string[] {
	return getClineFamilySessionFiles(ROO_FAMILY_CONFIG, paths);
}

export async function discoverRooSessions(
	paths: PlatformPathService = defaultPlatformPathService,
): Promise<SessionDiscoveryItem[]> {
	return discoverClineFamilySessions(ROO_FAMILY_CONFIG, paths);
}
