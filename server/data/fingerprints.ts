import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type { HarnessName } from "@shared/types";
import { walkFiles } from "../../src/util";
import {
	codexSessionRoots,
	commandCodeRoot,
	existingAntigravityRoots,
	existingDshRoots,
	openCodeDbPaths,
} from "./paths";

const INDEX_VERSION = 10;

function stamp(filePath: string): string {
	try {
		const stat = statSync(filePath);
		return `${filePath}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return `${filePath}:missing`;
	}
}

function hashFiles(files: string[]): string {
	const hash = createHash("sha256");
	for (const file of [...files].sort()) hash.update(stamp(file));
	return hash.digest("hex");
}

function filesFor(harness: HarnessName): string[] {
	if (harness === "codex")
		return codexSessionRoots().flatMap((root) =>
			walkFiles(
				root,
				(_filePath, name) =>
					name.startsWith("rollout-") && /\.jsonl(?:\.zst)?$/u.test(name),
			),
		);
	if (harness === "dsh")
		return existingDshRoots().flatMap((root) =>
			walkFiles(
				path.join(root, "sessions"),
				(_filePath, name) =>
					name.startsWith("session") && name.endsWith(".jsonl.zstd"),
			),
		);
	if (harness === "opencode") return openCodeDbPaths();
	if (harness === "commandcode") {
		const root = path.join(commandCodeRoot(), "projects");
		return walkFiles(
			root,
			(_filePath, name) =>
				name.endsWith(".jsonl") &&
				!name.endsWith(".checkpoints.jsonl") &&
				!name.endsWith(".prompts.jsonl"),
		);
	}
	return existingAntigravityRoots().flatMap((root) =>
		walkFiles(path.join(root, "conversations"), (_filePath, name) =>
			name.endsWith(".db"),
		),
	);
}

export function sourceFingerprint(harness: HarnessName): string {
	const files = filesFor(harness);
	return `v${INDEX_VERSION}:${files.length}:${hashFiles(files)}`;
}
