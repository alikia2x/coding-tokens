import type { OsEnvProvider } from "./env";
import { defaultOsEnvProvider } from "./env";
import { expandPath, normalizePath, safeBasename } from "./normalizer";

export interface PlatformPathService {
	getHomeDir(): string;
	getConfigDir(appName?: string): string;
	getDataDir(appName?: string): string;
	getCacheDir(appName?: string): string;
	expandPath(rawPath: string): string;
	normalize(filePath: string): string;
	safeBasename(filePath: string): string;
	resolveHarnessPaths(harnessId: string): string[];
	getEnv?(name: string): string | undefined;
}

export function readPathEnv(
	paths: PlatformPathService,
	name: string,
): string | undefined {
	if (typeof paths.getEnv === "function") return paths.getEnv(name);
	const internal = (
		paths as unknown as { env?: { get: (k: string) => string | undefined } }
	).env;
	if (internal) return internal.get(name);
	return process.env[name];
}

export class DefaultPlatformPathService implements PlatformPathService {
	constructor(private readonly env: OsEnvProvider = defaultOsEnvProvider) {}

	getEnv(name: string): string | undefined {
		return this.env.get(name);
	}

	getHomeDir(): string {
		return normalizePath(this.env.homedir());
	}

	private getLinuxConfigDir(): string {
		const xdg = this.env.get("XDG_CONFIG_HOME");
		if (xdg) return normalizePath(xdg);
		return `${this.getHomeDir()}/.config`;
	}

	getConfigDir(appName = "coding-tokens"): string {
		const platform = this.env.platform();
		const home = this.getHomeDir();

		if (platform === "darwin") {
			return `${home}/Library/Application Support/${appName}`;
		}
		if (platform === "win32") {
			const appData = this.env.get("APPDATA");
			if (appData) return normalizePath(`${appData}/${appName}`);
			return `${home}/AppData/Roaming/${appName}`;
		}
		// Linux XDG
		const xdgConfig = this.env.get("XDG_CONFIG_HOME");
		if (xdgConfig) return normalizePath(`${xdgConfig}/${appName}`);
		return `${home}/.config/${appName}`;
	}

	getDataDir(appName = "coding-tokens"): string {
		const platform = this.env.platform();
		const home = this.getHomeDir();

		if (platform === "darwin") {
			return `${home}/Library/Application Support/${appName}`;
		}
		if (platform === "win32") {
			const localAppData = this.env.get("LOCALAPPDATA");
			if (localAppData) return normalizePath(`${localAppData}/${appName}`);
			return `${home}/AppData/Local/${appName}`;
		}
		// Linux XDG
		const xdgData = this.env.get("XDG_DATA_HOME");
		if (xdgData) return normalizePath(`${xdgData}/${appName}`);
		return `${home}/.local/share/${appName}`;
	}

	getCacheDir(appName = "coding-tokens"): string {
		const platform = this.env.platform();
		const home = this.getHomeDir();

		if (platform === "darwin") {
			return `${home}/Library/Caches/${appName}`;
		}
		if (platform === "win32") {
			const localAppData = this.env.get("LOCALAPPDATA");
			if (localAppData) {
				return normalizePath(`${localAppData}/${appName}/cache`);
			}
			return `${home}/AppData/Local/${appName}/cache`;
		}
		// Linux XDG
		const xdgCache = this.env.get("XDG_CACHE_HOME");
		if (xdgCache) return normalizePath(`${xdgCache}/${appName}`);
		return `${home}/.cache/${appName}`;
	}

	expandPath(rawPath: string): string {
		return expandPath(rawPath, this.env);
	}

	normalize(filePath: string): string {
		return normalizePath(filePath);
	}

	safeBasename(filePath: string): string {
		return safeBasename(filePath);
	}

	resolveHarnessPaths(harnessId: string): string[] {
		const platform = this.env.platform();
		const home = this.getHomeDir();
		const id = harnessId.toLowerCase();

		switch (id) {
			case "codex": {
				const envHome = this.env.get("CODEX_HOME");
				const root = envHome ? this.expandPath(envHome) : `${home}/.codex`;
				return [root, `${root}/sessions`, `${root}/archived_sessions`];
			}
			case "dsh": {
				const envHome = this.env.get("DSH_HOME");
				if (envHome) return [this.expandPath(envHome)];
				if (platform === "darwin") {
					return [
						`${home}/.dsh`,
						`${home}/Library/Application Support/dsh-desktop/harness`,
					];
				}
				if (platform === "win32") {
					const appData = this.env.get("APPDATA") ?? `${home}/AppData/Roaming`;
					return [
						`${home}/.dsh`,
						normalizePath(`${appData}/dsh-desktop/harness`),
					];
				}
				const dataHome =
					this.env.get("XDG_DATA_HOME") ?? `${home}/.local/share`;
				return [
					`${home}/.dsh`,
					normalizePath(`${dataHome}/dsh-desktop/harness`),
				];
			}
			case "opencode": {
				const envDb = this.env.get("OPENCODE_DB");
				if (envDb) return [this.expandPath(envDb)];
				const envData = this.env.get("OPENCODE_DATA_DIR");
				if (envData) return [this.expandPath(envData)];
				if (platform === "win32") {
					const localAppData =
						this.env.get("LOCALAPPDATA") ?? `${home}/AppData/Local`;
					return [
						normalizePath(`${localAppData}/opencode`),
						`${home}/.local/share/opencode`,
					];
				}
				if (platform === "darwin") {
					return [
						`${home}/Library/Application Support/opencode`,
						`${home}/.local/share/opencode`,
					];
				}
				const dataHome =
					this.env.get("XDG_DATA_HOME") ?? `${home}/.local/share`;
				return [normalizePath(`${dataHome}/opencode`)];
			}
			case "commandcode": {
				const envHome = this.env.get("COMMANDCODE_HOME");
				const root = envHome
					? this.expandPath(envHome)
					: `${home}/.commandcode`;
				return [root, `${root}/projects`];
			}
			case "antigravity": {
				const envHome = this.env.get("ANTIGRAVITY_HOME");
				if (envHome) return [this.expandPath(envHome)];
				const roots = [`${home}/.gemini/antigravity`, `${home}/.antigravity`];
				const t3Dir = this.env.get("T3_USER_DATA_DIR")
					? this.expandPath(this.env.get("T3_USER_DATA_DIR") as string)
					: `${home}/.t3/userdata`;
				roots.push(t3Dir);
				return roots;
			}
			case "claude": {
				const envDir = this.env.get("CLAUDE_CONFIG_DIR");
				return [envDir ? this.expandPath(envDir) : `${home}/.claude`];
			}
			case "aider": {
				const envHome = this.env.get("AIDER_HOME");
				const root = envHome
					? this.expandPath(envHome)
					: this.expandPath("~/.aider");
				return [root, this.expandPath("~/.aider.conf.yml")];
			}
			case "cline": {
				const linuxConfig = this.getLinuxConfigDir();
				const vsCodeStorage =
					platform === "darwin"
						? `${home}/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev`
						: platform === "win32"
							? normalizePath(
									`${this.env.get("APPDATA") ?? `${home}/AppData/Roaming`}/Code/User/globalStorage/saoudrizwan.claude-dev`,
								)
							: `${linuxConfig}/Code/User/globalStorage/saoudrizwan.claude-dev`;
				return [`${home}/.cline`, vsCodeStorage];
			}
			case "roo": {
				const linuxConfig = this.getLinuxConfigDir();
				const vsCodeStorage =
					platform === "darwin"
						? `${home}/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline`
						: platform === "win32"
							? normalizePath(
									`${this.env.get("APPDATA") ?? `${home}/AppData/Roaming`}/Code/User/globalStorage/rooveterinaryinc.roo-cline`,
								)
							: `${linuxConfig}/Code/User/globalStorage/rooveterinaryinc.roo-cline`;
				return [vsCodeStorage];
			}
			case "continue": {
				return [`${home}/.continue`];
			}
			case "cursor": {
				const linuxConfig = this.getLinuxConfigDir();
				const cursorUser =
					platform === "darwin"
						? `${home}/Library/Application Support/Cursor/User`
						: platform === "win32"
							? normalizePath(
									`${this.env.get("APPDATA") ?? `${home}/AppData/Roaming`}/Cursor/User`,
								)
							: `${linuxConfig}/Cursor/User`;
				return [
					`${cursorUser}/globalStorage`,
					`${cursorUser}/workspaceStorage`,
				];
			}
			case "copilot": {
				const linuxConfig = this.getLinuxConfigDir();
				const codeUser =
					platform === "darwin"
						? `${home}/Library/Application Support/Code/User`
						: platform === "win32"
							? normalizePath(
									`${this.env.get("APPDATA") ?? `${home}/AppData/Roaming`}/Code/User`,
								)
							: `${linuxConfig}/Code/User`;
				return [`${codeUser}/workspaceStorage`];
			}
			case "windsurf": {
				const linuxConfig = this.getLinuxConfigDir();
				const windsurfUser =
					platform === "darwin"
						? `${home}/Library/Application Support/Windsurf/User`
						: platform === "win32"
							? normalizePath(
									`${this.env.get("APPDATA") ?? `${home}/AppData/Roaming`}/Windsurf/User`,
								)
							: `${linuxConfig}/Windsurf/User`;
				return [
					`${home}/.codeium`,
					`${home}/.windsurf`,
					`${windsurfUser}/globalStorage`,
					`${windsurfUser}/workspaceStorage`,
				];
			}
			case "goose": {
				return [`${home}/.local/share/goose`, `${home}/.goose`];
			}
			case "openhands": {
				return [`${home}/.openhands`, `${home}/.openhands-state`];
			}
			default:
				return [];
		}
	}
}

export const defaultPlatformPathService: PlatformPathService =
	new DefaultPlatformPathService();
