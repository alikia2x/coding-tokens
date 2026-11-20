import { existsSync } from "node:fs";
import path from "node:path";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { getOpenCodeDbPaths } from "../../src/providers/opencode/discovery";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import {
	antigravityRoots,
	existingAntigravityRoots,
} from "../../src/sources/antigravity";

export { antigravityRoots, existingAntigravityRoots };

export function codexHome(): string {
	return (
		defaultPlatformPathService.resolveHarnessPaths("codex")[0] ??
		path.join(defaultPlatformPathService.getHomeDir(), ".codex")
	);
}

export function codexSessionRoots(): string[] {
	return defaultPlatformPathService.resolveHarnessPaths("codex").slice(1);
}

export function dshRoots(): string[] {
	return defaultPlatformPathService.resolveHarnessPaths("dsh");
}

export function existingDshRoots(): string[] {
	return dshRoots().filter((root) => existsSync(path.join(root, "sessions")));
}

export function openCodeDataDir(): string {
	return (
		defaultPlatformPathService.resolveHarnessPaths("opencode")[0] ??
		path.join(defaultPlatformPathService.getHomeDir(), ".local/share/opencode")
	);
}

export function openCodeDbPaths(): string[] {
	return getOpenCodeDbPaths(defaultPlatformPathService);
}

export function commandCodeRoot(): string {
	return (
		defaultPlatformPathService.resolveHarnessPaths("commandcode")[0] ??
		path.join(defaultPlatformPathService.getHomeDir(), ".commandcode")
	);
}

export function harnessPaths(): Record<string, string[]> {
	const paths: Record<string, string[]> = {};
	for (const provider of defaultHarnessRegistry.getAll()) {
		const id = provider.metadata.id;
		const watchPaths = provider.getWatchPaths(defaultPlatformPathService);
		paths[id] = watchPaths.length
			? watchPaths
			: defaultPlatformPathService.resolveHarnessPaths(id);
	}
	return paths;
}
