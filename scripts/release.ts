#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function usage(message?: string): never {
	if (message) console.error(`release: ${message}\n`);
	console.error(
		[
			"Usage: bun run release <major|minor|patch|x.y.z> [--dry-run] [--skip-changelog]",
			"",
			"Bumps package.json, folds the CHANGELOG [Unreleased] section into the new",
			"version, and prints the commit/tag commands. It never touches git.",
		].join("\n"),
	);
	process.exit(1);
}

function parsePart(value: string | undefined): number {
	const part = Number(value ?? "0");
	if (!Number.isInteger(part) || part < 0) usage("invalid version number");
	return part;
}

function bump(current: string, target: string): string {
	const [core] = current.split("-", 1);
	const [major = "0", minor = "0", patch = "0"] = (core ?? "0.0.0").split(".");
	if (target === "major") return `${parsePart(major) + 1}.0.0`;
	if (target === "minor")
		return `${parsePart(major)}.${parsePart(minor) + 1}.0`;
	if (target === "patch") {
		return `${parsePart(major)}.${parsePart(minor)}.${parsePart(patch) + 1}`;
	}
	if (!SEMVER.test(target)) usage(`"${target}" is not a semver version`);
	return target;
}

function withReleasedEntry(
	source: string,
	version: string,
	date: string,
): string {
	const header = "## [Unreleased]";
	const start = source.indexOf(header);
	if (start === -1) throw new Error(`CHANGELOG.md is missing "${header}"`);

	const bodyStart = start + header.length;
	const nextHeading = source.indexOf("\n## [", bodyStart);
	const body = source
		.slice(bodyStart, nextHeading === -1 ? undefined : nextHeading)
		.trim();
	const rest = nextHeading === -1 ? "" : source.slice(nextHeading + 1);

	const entry = `## [${version}] - ${date}\n\n${body || "- No user-facing changes recorded."}\n\n`;
	return `${source.slice(0, start)}${header}\n\n${entry}${rest}`;
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const skipChangelog = argv.includes("--skip-changelog");
const target = argv.find((arg) => !arg.startsWith("-"));

if (!target) usage("missing version argument");

const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as {
	version: string;
};
const current = pkg.version;
const next = bump(current, target);
const date = new Date().toISOString().slice(0, 10);

if (next === current) usage(`version is already ${current}`);

const changelog = skipChangelog
	? null
	: withReleasedEntry(readFileSync(CHANGELOG_PATH, "utf8"), next, date);

console.log(`Coding Tokens ${current} -> ${next}`);
if (dryRun) {
	console.log(`would update ${path.relative(ROOT, PACKAGE_PATH)}`);
	if (changelog)
		console.log(`would add "## [${next}] - ${date}" to CHANGELOG.md`);
	console.log("dry run: no files written");
	process.exit(0);
}

pkg.version = next;
writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, "\t")}\n`);
if (changelog) writeFileSync(CHANGELOG_PATH, changelog);

console.log("\nNext steps:");
console.log("  1. Review the changelog entry and commit the bump");
console.log(`  2. git tag -a v${next} -m "v${next}"`);
console.log(`  3. git push origin main v${next}`);
console.log(
	"\nPushing the tag runs the release workflow: build, sign, notarize, publish.",
);
