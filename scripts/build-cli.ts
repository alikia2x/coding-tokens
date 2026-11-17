#!/usr/bin/env bun
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const ENTRYPOINT = path.join(ROOT, "src", "cli.ts");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");

function platformLabel(platform: NodeJS.Platform): string {
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "win";
	return platform;
}

function binaryFilename(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	const ext = platform === "win32" ? ".exe" : "";
	return `coding-tokens-cli-${platformLabel(platform)}-${arch}${ext}`;
}

mkdirSync(ARTIFACTS_DIR, { recursive: true });
const outFile = path.join(ARTIFACTS_DIR, binaryFilename());

console.log(`Building standalone CLI binary: ${outFile}`);
const proc = Bun.spawnSync(
	["bun", "build", ENTRYPOINT, "--compile", "--outfile", outFile],
	{
		cwd: ROOT,
		stdout: "inherit",
		stderr: "inherit",
	},
);

if (proc.exitCode !== 0) {
	console.error(`Failed to build CLI binary (exit code ${proc.exitCode})`);
	process.exit(proc.exitCode || 1);
}

const sizeMb = (statSync(outFile).size / (1024 * 1024)).toFixed(2);
console.log(`CLI binary ready: ${outFile} (${sizeMb} MB)`);
