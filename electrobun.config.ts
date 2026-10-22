import path from "node:path";
import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Coding Tokens",
		identifier: "dev.codingtokens.app",
		version: "0.2.0",
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
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
