import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCommandCode } from "./commandcode";
import { readOpenCode } from "./opencode";

const directories: string[] = [];
const original = {
	OPENCODE_DATA_DIR: process.env.OPENCODE_DATA_DIR,
	OPENCODE_DB: process.env.OPENCODE_DB,
	COMMANDCODE_HOME: process.env.COMMANDCODE_HOME,
};

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "coding-tokens-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	if (original.OPENCODE_DATA_DIR === undefined)
		delete process.env.OPENCODE_DATA_DIR;
	else process.env.OPENCODE_DATA_DIR = original.OPENCODE_DATA_DIR;
	if (original.OPENCODE_DB === undefined) delete process.env.OPENCODE_DB;
	else process.env.OPENCODE_DB = original.OPENCODE_DB;
	if (original.COMMANDCODE_HOME === undefined)
		delete process.env.COMMANDCODE_HOME;
	else process.env.COMMANDCODE_HOME = original.COMMANDCODE_HOME;
});

function openCodeDatabase(directory: string): void {
	const db = new Database(path.join(directory, "opencode.db"));
	db.exec(`
		CREATE TABLE session_v2 (
			id TEXT PRIMARY KEY,
			directory TEXT,
			model TEXT,
			time_created INTEGER,
			title TEXT
		);
		CREATE TABLE session_message (
			id TEXT PRIMARY KEY,
			session_id TEXT,
			type TEXT,
			data TEXT,
			time_created INTEGER,
			seq INTEGER
		);
	`);
	db.query(
		"INSERT INTO session_v2 (id, directory, model, time_created, title) VALUES (?, ?, ?, ?, ?)",
	).run("session", "/tmp/project", "provider/model", 1, "Session");
	const insert = db.query(
		"INSERT INTO session_message (id, session_id, type, data, time_created, seq) VALUES (?, ?, ?, ?, ?, ?)",
	);
	insert.run(
		"empty",
		"session",
		"assistant",
		JSON.stringify({
			model: { providerID: "provider", id: "model" },
			tokens: {
				input: 0,
				output: 0,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			},
		}),
		2,
		1,
	);
	insert.run(
		"used",
		"session",
		"assistant",
		JSON.stringify({
			model: { providerID: "provider", id: "model" },
			tokens: {
				input: 50,
				output: 10,
				reasoning: 0,
				cache: { read: 5, write: 0 },
			},
		}),
		3,
		2,
	);
	db.close();
}

describe("zero-usage records", () => {
	test("drops all-zero OpenCode assistant messages", () => {
		const directory = temporaryDirectory();
		openCodeDatabase(directory);
		process.env.OPENCODE_DATA_DIR = directory;
		delete process.env.OPENCODE_DB;

		const result = readOpenCode();

		expect(result.records.map((record) => record.messageId)).toEqual(["used"]);
	});

	test("drops all-zero Command Code assistant messages", () => {
		const home = temporaryDirectory();
		const project = path.join(home, "projects", "project");
		mkdirSync(project, { recursive: true });
		const rows = [
			{ type: "session", id: "session", cwd: "/tmp/project", timestamp: 1 },
			{
				type: "message",
				id: "empty",
				timestamp: 2,
				message: { role: "assistant" },
				usage: { inputTokens: 0, outputTokens: 0, reasoning: 0 },
			},
			{
				type: "message",
				id: "used",
				timestamp: 3,
				message: { role: "assistant" },
				usage: { inputTokens: 7, outputTokens: 2 },
			},
		];
		writeFileSync(
			path.join(project, "session.jsonl"),
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		process.env.COMMANDCODE_HOME = home;

		const result = readCommandCode();

		expect(result.records.map((record) => record.messageId)).toEqual(["used"]);
	});
});
