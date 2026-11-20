import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type PlatformType = "darwin" | "linux" | "win32";

export interface OsEnvProvider {
	get(name: string): string | undefined;
	homedir(): string;
	platform(): PlatformType;
}

export class MockOsEnvProvider implements OsEnvProvider {
	private readonly envVars: Map<string, string>;
	private readonly currentPlatform: PlatformType;
	private readonly homeDirectory: string;

	constructor(options: {
		platform: PlatformType;
		homeDir: string;
		env?: Record<string, string | undefined>;
	}) {
		this.currentPlatform = options.platform;
		this.homeDirectory = options.homeDir;
		this.envVars = new Map<string, string>();

		if (options.env) {
			for (const [key, value] of Object.entries(options.env)) {
				if (value !== undefined) {
					this.set(key, value);
				}
			}
		}
	}

	get(name: string): string | undefined {
		if (this.currentPlatform === "win32") {
			// Windows environment variable lookup is case-insensitive
			const upper = name.toUpperCase();
			for (const [k, v] of this.envVars.entries()) {
				if (k.toUpperCase() === upper) {
					return v;
				}
			}
			return undefined;
		}
		return this.envVars.get(name);
	}

	set(name: string, value: string): void {
		if (this.currentPlatform === "win32") {
			this.delete(name);
		}
		this.envVars.set(name, value);
	}

	delete(name: string): void {
		if (this.currentPlatform === "win32") {
			const upper = name.toUpperCase();
			for (const k of Array.from(this.envVars.keys())) {
				if (k.toUpperCase() === upper) {
					this.envVars.delete(k);
				}
			}
		} else {
			this.envVars.delete(name);
		}
	}

	homedir(): string {
		return this.homeDirectory;
	}

	platform(): PlatformType {
		return this.currentPlatform;
	}

	all(): Record<string, string> {
		return Object.fromEntries(this.envVars.entries());
	}
}

export interface SandboxEnvironment {
	readonly platform: PlatformType;
	readonly rootDir: string;
	readonly homeDir: string;
	readonly configDir: string;
	readonly dataDir: string;
	readonly cacheDir: string;
	readonly provider: MockOsEnvProvider;
	cleanup(): void;
}

/**
 * Creates a mock OsEnvProvider with standard OS-specific environment variables.
 */
export function createMockEnv(
	platform: PlatformType,
	baseDir: string,
	overrides?: Record<string, string | undefined>,
): MockOsEnvProvider {
	const username = "testuser";
	let homeDir = "";
	const env: Record<string, string | undefined> = {};

	switch (platform) {
		case "darwin": {
			homeDir = path.join(baseDir, "Users", username);
			env.HOME = homeDir;
			env.USER = username;
			env.TMPDIR = path.join(baseDir, "tmp");
			break;
		}
		case "linux": {
			homeDir = path.join(baseDir, "home", username);
			env.HOME = homeDir;
			env.USER = username;
			env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
			env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
			env.XDG_CACHE_HOME = path.join(homeDir, ".cache");
			env.XDG_STATE_HOME = path.join(homeDir, ".local", "state");
			env.TMPDIR = path.join(baseDir, "tmp");
			break;
		}
		case "win32": {
			// Keep cross-platform safe paths under baseDir
			homeDir = path.join(baseDir, "Users", username);
			env.USERPROFILE = homeDir;
			env.APPDATA = path.join(homeDir, "AppData", "Roaming");
			env.LOCALAPPDATA = path.join(homeDir, "AppData", "Local");
			env.PROGRAMDATA = path.join(baseDir, "ProgramData");
			env.TEMP = path.join(homeDir, "AppData", "Local", "Temp");
			env.TMP = env.TEMP;
			env.HOMEDRIVE = "C:";
			env.HOMEPATH = `\\Users\\${username}`;
			break;
		}
	}

	if (overrides) {
		if (platform === "win32") {
			for (const overrideKey of Object.keys(overrides)) {
				const upper = overrideKey.toUpperCase();
				for (const defaultKey of Object.keys(env)) {
					if (
						defaultKey.toUpperCase() === upper &&
						defaultKey !== overrideKey
					) {
						delete env[defaultKey];
					}
				}
			}
		}
		Object.assign(env, overrides);
	}

	return new MockOsEnvProvider({
		platform,
		homeDir,
		env,
	});
}

/**
 * Creates an isolated, real on-disk sandbox directory structure mimicking the target platform.
 * Does not mutate global process.env or touch host home directories.
 */
export function createSandboxEnvironment(
	platform: PlatformType,
	prefix = "ct-sandbox-",
): SandboxEnvironment {
	const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
	const username = "testuser";
	let homeDir = "";
	let configDir = "";
	let dataDir = "";
	let cacheDir = "";

	switch (platform) {
		case "darwin": {
			homeDir = path.join(rootDir, "Users", username);
			configDir = path.join(homeDir, "Library", "Application Support");
			dataDir = configDir;
			cacheDir = path.join(homeDir, "Library", "Caches");
			break;
		}
		case "linux": {
			homeDir = path.join(rootDir, "home", username);
			configDir = path.join(homeDir, ".config");
			dataDir = path.join(homeDir, ".local", "share");
			cacheDir = path.join(homeDir, ".cache");
			break;
		}
		case "win32": {
			homeDir = path.join(rootDir, "Users", username);
			configDir = path.join(homeDir, "AppData", "Roaming");
			dataDir = path.join(homeDir, "AppData", "Local");
			cacheDir = path.join(homeDir, "AppData", "Local", "Temp");
			break;
		}
	}

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(cacheDir, { recursive: true });

	const provider = createMockEnv(platform, rootDir);

	return {
		platform,
		rootDir,
		homeDir,
		configDir,
		dataDir,
		cacheDir,
		provider,
		cleanup() {
			try {
				rmSync(rootDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup failures on Windows/temp locks
			}
		},
	};
}

/**
 * Runs a test function within a temporary isolated sandbox, automatically cleaning up afterwards.
 */
export async function withSandboxEnvironment<T>(
	platform: PlatformType,
	fn: (sandbox: SandboxEnvironment) => Promise<T> | T,
): Promise<T> {
	const sandbox = createSandboxEnvironment(platform);
	try {
		return await fn(sandbox);
	} finally {
		sandbox.cleanup();
	}
}
