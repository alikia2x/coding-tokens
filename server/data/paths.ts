import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { defaultPlatformPathService } from "../../src/platform/paths";
import { defaultHarnessRegistry } from "../../src/providers/registry";
import {
	antigravityRoots,
	existingAntigravityRoots,
} from "../../src/sources/antigravity";
import { expandHome, homeDir } from "../../src/util";

export { antigravityRoots, existingAntigravityRoots };

export function codexHome(): string {
	return process.env.CODEX_HOME
		? path.resolve(expandHome(process.env.CODEX_HOME))
		: path.join(homeDir, ".codex");
}

export function codexSessionRoots(): string[] {
	const root = codexHome();
	return [path.join(root, "sessions"), path.join(root, "archived_sessions")];
}

export function dshRoots(): string[] {
	return process.env.DSH_HOME
		? [path.resolve(expandHome(process.env.DSH_HOME))]
		: [
				path.join(homeDir, ".dsh"),
				path.join(homeDir, "Library/Application Support/dsh-desktop/harness"),
			];
}

export function existingDshRoots(): string[] {
	return dshRoots().filter((root) => existsSync(path.join(root, "sessions")));
}

export function openCodeDataDir(): string {
	return process.env.OPENCODE_DATA_DIR
		? path.resolve(expandHome(process.env.OPENCODE_DATA_DIR))
		: path.join(homeDir, ".local/share/opencode");
}

export function openCodeDbPaths(): string[] {
	if (process.env.OPENCODE_DB)
		return [path.resolve(expandHome(process.env.OPENCODE_DB))];
	try {
		return readdirSync(openCodeDataDir())
			.filter((name) => /^opencode(?:-[^/]*)?\.db$/u.test(name))
			.map((name) => path.join(openCodeDataDir(), name))
			.filter(existsSync);
	} catch {
		return [];
	}
}

export function commandCodeRoot(): string {
	return process.env.COMMANDCODE_HOME
		? path.resolve(expandHome(process.env.COMMANDCODE_HOME))
		: path.join(homeDir, ".commandcode");
}

export function harnessPaths(): Record<string, string[]> {
	const paths: Record<string, string[]> = {
		codex: [codexHome(), ...codexSessionRoots()],
		dsh: dshRoots(),
		opencode: openCodeDbPaths().length
			? openCodeDbPaths()
			: [openCodeDataDir()],
		commandcode: [commandCodeRoot()],
		antigravity: antigravityRoots(),
	};
	for (const provider of defaultHarnessRegistry.getAll()) {
		if (!paths[provider.metadata.id]) {
			paths[provider.metadata.id] = provider.getWatchPaths(
				defaultPlatformPathService,
			);
		}
	}
	return paths;
}
