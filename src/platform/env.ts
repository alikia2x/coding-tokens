import os from "node:os";

export interface OsEnvProvider {
	get(name: string): string | undefined;
	homedir(): string;
	platform(): "darwin" | "linux" | "win32";
}

export class SystemOsEnvProvider implements OsEnvProvider {
	private readonly isWin: boolean;

	constructor() {
		this.isWin = process.platform === "win32";
	}

	get(name: string): string | undefined {
		if (!this.isWin) {
			return process.env[name];
		}
		// Windows: case-insensitive environment lookup
		const upper = name.toUpperCase();
		for (const [key, val] of Object.entries(process.env)) {
			if (key.toUpperCase() === upper) return val;
		}
		return undefined;
	}

	homedir(): string {
		return os.homedir();
	}

	platform(): "darwin" | "linux" | "win32" {
		if (process.platform === "win32") return "win32";
		if (process.platform === "darwin") return "darwin";
		return "linux";
	}
}

export interface MockOsEnvOptions {
	env?: Record<string, string>;
	home?: string;
	platform?: "darwin" | "linux" | "win32";
}

export class MockOsEnvProvider implements OsEnvProvider {
	private readonly env: Map<string, string>;
	private readonly home: string;
	private readonly plat: "darwin" | "linux" | "win32";

	constructor(options: MockOsEnvOptions = {}) {
		this.plat = options.platform ?? "darwin";
		this.home =
			options.home ??
			(this.plat === "win32" ? "C:\\Users\\mockuser" : "/home/mockuser");
		this.env = new Map(Object.entries(options.env ?? {}));
	}

	get(name: string): string | undefined {
		if (this.plat === "win32") {
			const upper = name.toUpperCase();
			for (const [k, v] of this.env.entries()) {
				if (k.toUpperCase() === upper) return v;
			}
			return undefined;
		}
		return this.env.get(name);
	}

	set(name: string, value: string): void {
		this.env.set(name, value);
	}

	delete(name: string): void {
		this.env.delete(name);
	}

	homedir(): string {
		return this.home;
	}

	platform(): "darwin" | "linux" | "win32" {
		return this.plat;
	}
}

export const defaultOsEnvProvider: OsEnvProvider = new SystemOsEnvProvider();
