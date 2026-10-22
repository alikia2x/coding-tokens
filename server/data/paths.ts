import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { HarnessName } from "@shared/types";
import { expandHome, homeDir } from "../../src/util";

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

export function antigravityRoots(): string[] {
	return process.env.ANTIGRAVITY_HOME
		? [path.resolve(expandHome(process.env.ANTIGRAVITY_HOME))]
		: [
				path.join(homeDir, ".gemini/antigravity"),
				path.join(homeDir, ".antigravity"),
			];
}

export function existingAntigravityRoots(): string[] {
	return antigravityRoots().filter((root) =>
		existsSync(path.join(root, "conversations")),
	);
}

export function harnessPaths(): Record<HarnessName, string[]> {
	const paths: Record<HarnessName, string[]> = {
		codex: [codexHome(), ...codexSessionRoots()],
		dsh: dshRoots(),
		opencode: openCodeDbPaths().length
			? openCodeDbPaths()
			: [openCodeDataDir()],
		commandcode: [commandCodeRoot()],
		antigravity: antigravityRoots(),
	};
	return paths;
}
