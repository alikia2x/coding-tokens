import type { HarnessId } from "../../shared/types";
import type { PlatformPathService } from "../platform/paths";
import { defaultPlatformPathService } from "../platform/paths";
import { AiderProvider } from "./aider";
import { AntigravityProvider } from "./antigravity";
import { ClaudeProvider } from "./claude";
import { ClineProvider } from "./cline";
import { CodexProvider } from "./codex";
import { CommandCodeProvider } from "./commandcode";
import { ContinueProvider } from "./continue";
import { CopilotProvider } from "./copilot";
import { CursorProvider } from "./cursor";
import { DshProvider } from "./dsh";
import { GooseProvider } from "./goose";
import { OpenCodeProvider } from "./opencode";
import { OpenHandsProvider } from "./openhands";
import { RooProvider } from "./roo";
import type { HarnessProvider } from "./types";
import { WindsurfProvider } from "./windsurf";

export interface HarnessRegistry {
	register(provider: HarnessProvider): void;
	unregister(id: HarnessId): boolean;
	get(id: HarnessId): HarnessProvider | undefined;
	getAll(): HarnessProvider[];
	getAvailable(paths: PlatformPathService): Promise<HarnessProvider[]>;
	has(id: HarnessId): boolean;
	clear(): void;
	reset(): void;
}

export class DefaultHarnessRegistry implements HarnessRegistry {
	private readonly providers = new Map<string, HarnessProvider>();

	constructor() {
		this.reset();
	}

	register(provider: HarnessProvider): void {
		const key = provider.metadata.id.toLowerCase();
		this.providers.set(key, provider);
	}

	unregister(id: HarnessId): boolean {
		const key = id.toLowerCase();
		return this.providers.delete(key);
	}

	get(id: HarnessId): HarnessProvider | undefined {
		const key = id.toLowerCase();
		return this.providers.get(key);
	}

	getAll(): HarnessProvider[] {
		return Array.from(this.providers.values());
	}

	async getAvailable(
		paths: PlatformPathService = defaultPlatformPathService,
	): Promise<HarnessProvider[]> {
		const all = this.getAll();
		const results = await Promise.all(
			all.map(async (provider) => {
				try {
					const available = await provider.isAvailable(paths);
					return available ? provider : null;
				} catch {
					return null;
				}
			}),
		);
		return results.filter((p): p is HarnessProvider => p !== null);
	}

	has(id: HarnessId): boolean {
		const key = id.toLowerCase();
		return this.providers.has(key);
	}

	clear(): void {
		this.providers.clear();
	}

	reset(): void {
		this.providers.clear();
		this.register(new CodexProvider());
		this.register(new DshProvider());
		this.register(new OpenCodeProvider());
		this.register(new CommandCodeProvider());
		this.register(new AntigravityProvider());
		this.register(new ClaudeProvider());
		this.register(new ClineProvider());
		this.register(new RooProvider());
		this.register(new ContinueProvider());
		this.register(new CursorProvider());
		this.register(new WindsurfProvider());
		this.register(new CopilotProvider());
		this.register(new AiderProvider());
		this.register(new GooseProvider());
		this.register(new OpenHandsProvider());
	}
}

export const defaultHarnessRegistry = new DefaultHarnessRegistry();

export function getDefaultHarnessRegistry(): HarnessRegistry {
	return defaultHarnessRegistry;
}

export function registerHarness(provider: HarnessProvider): void {
	defaultHarnessRegistry.register(provider);
}

export function unregisterHarness(id: HarnessId): boolean {
	return defaultHarnessRegistry.unregister(id);
}

export function getHarness(id: HarnessId): HarnessProvider | undefined {
	return defaultHarnessRegistry.get(id);
}

export function getAllHarnesses(): HarnessProvider[] {
	return defaultHarnessRegistry.getAll();
}

export function getAvailableHarnesses(
	paths: PlatformPathService = defaultPlatformPathService,
): Promise<HarnessProvider[]> {
	return defaultHarnessRegistry.getAvailable(paths);
}

// Aliases for provider naming convention
export const getProvider = getHarness;
export const getAllProviders = getAllHarnesses;
export const getAvailableProviders = getAvailableHarnesses;
export const registerProvider = registerHarness;
export const unregisterProvider = unregisterHarness;
