import { readFileSync } from "node:fs";
import path from "node:path";
import type { ElectrobunConfig } from "electrobun";

const pkg = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

function flag(name: string, fallback = false): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return fallback;
	return value === "1" || value === "true" || value === "yes";
}

// Signing is opt-in so local prototype builds stay unsigned.
const codesign = flag("CODESIGN");
const releaseBaseUrl = process.env.RELEASES_BASE_URL?.trim();

const config = {
	app: {
		name: "Coding Tokens",
		identifier: "dev.codingtokens.app",
		version: pkg.version,
		description: "Local token usage reports for coding harnesses",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "desktop/index.ts",
			alias: {
				"@shared": path.resolve("shared"),
			},
		},
		copy: {
			dist: "views/mainview",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			icons: "assets/icon.iconset",
			codesign,
			notarize: codesign && flag("NOTARIZE"),
			createDmg: flag("CREATE_DMG", true),
		},
		linux: {
			bundleCEF: false,
			icon: "assets/icon.png",
		},
		win: {
			bundleCEF: false,
			icon: "assets/icon.ico",
		},
	},
	...(releaseBaseUrl
		? {
				release: {
					baseUrl: releaseBaseUrl,
				},
			}
		: {}),
} satisfies ElectrobunConfig;

export default config;
