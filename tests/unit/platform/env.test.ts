import { describe, expect, test } from "bun:test";
import {
	defaultOsEnvProvider,
	MockOsEnvProvider,
	SystemOsEnvProvider,
} from "../../../src/platform/env";
import {
	createMockEnv,
	MockOsEnvProvider as FixtureMockOsEnvProvider,
} from "../../fixtures/helpers/mock-env";

describe("Platform: Environment Abstraction (OsEnvProvider) (Features 1 & 2)", () => {
	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("SystemOsEnvProvider returns host platform and homedir", () => {
		const sys = new SystemOsEnvProvider();
		expect(["darwin", "linux", "win32"]).toContain(sys.platform());
		expect(sys.homedir().length).toBeGreaterThan(0);
		expect(defaultOsEnvProvider).toBeInstanceOf(SystemOsEnvProvider);
	});

	test("MockOsEnvProvider simulates darwin environment by default", () => {
		const mock = new MockOsEnvProvider({
			env: { USER: "alice", SHELL: "/bin/zsh" },
			home: "/Users/alice",
		});
		expect(mock.platform()).toBe("darwin");
		expect(mock.homedir()).toBe("/Users/alice");
		expect(mock.get("USER")).toBe("alice");
		expect(mock.get("SHELL")).toBe("/bin/zsh");
		expect(mock.get("NONEXISTENT")).toBeUndefined();
	});

	test("MockOsEnvProvider simulates linux XDG environment", () => {
		const mock = new MockOsEnvProvider({
			platform: "linux",
			home: "/home/bob",
			env: {
				XDG_CONFIG_HOME: "/home/bob/.config",
				XDG_DATA_HOME: "/home/bob/.local/share",
			},
		});
		expect(mock.platform()).toBe("linux");
		expect(mock.homedir()).toBe("/home/bob");
		expect(mock.get("XDG_CONFIG_HOME")).toBe("/home/bob/.config");
		expect(mock.get("XDG_DATA_HOME")).toBe("/home/bob/.local/share");
	});

	test("MockOsEnvProvider simulates win32 with standard environment variables", () => {
		const mock = new MockOsEnvProvider({
			platform: "win32",
			home: "C:\\Users\\charlie",
			env: {
				APPDATA: "C:\\Users\\charlie\\AppData\\Roaming",
				LOCALAPPDATA: "C:\\Users\\charlie\\AppData\\Local",
				Path: "C:\\Windows;C:\\Windows\\System32",
			},
		});
		expect(mock.platform()).toBe("win32");
		expect(mock.homedir()).toBe("C:\\Users\\charlie");
		expect(mock.get("APPDATA")).toBe("C:\\Users\\charlie\\AppData\\Roaming");
		expect(mock.get("LOCALAPPDATA")).toBe("C:\\Users\\charlie\\AppData\\Local");
	});

	test("createMockEnv helper properly initializes OS specific defaults", () => {
		const darwin = createMockEnv("darwin", "/base");
		expect(darwin.get("HOME")).toBe("/base/Users/testuser");
		expect(darwin.platform()).toBe("darwin");

		const linux = createMockEnv("linux", "/base");
		expect(linux.get("XDG_CONFIG_HOME")).toBe("/base/home/testuser/.config");
		expect(linux.platform()).toBe("linux");

		const win = createMockEnv("win32", "C:/base");
		expect(win.get("USERPROFILE")).toBe("C:/base/Users/testuser");
		expect(win.platform()).toBe("win32");
	});

	// =========================================================================
	// Tier 2: Boundary & Corner Cases
	// =========================================================================

	test("win32 case-insensitive get, set, and delete operations", () => {
		const mock = new MockOsEnvProvider({
			platform: "win32",
			home: "C:\\Users\\test",
			env: {
				Path: "C:\\Windows",
			},
		});

		// Case-insensitive retrieval
		expect(mock.get("path")).toBe("C:\\Windows");
		expect(mock.get("PATH")).toBe("C:\\Windows");
		expect(mock.get("Path")).toBe("C:\\Windows");

		// Mutation operations
		mock.set("CustomVar", "12345");
		expect(mock.get("customvar")).toBe("12345");
		expect(mock.get("CUSTOMVAR")).toBe("12345");
		mock.delete("CustomVar");
		expect(mock.get("customvar")).toBeUndefined();
	});

	test("fixture MockOsEnvProvider supports win32 case-insensitive overwrite and all()", () => {
		const fixtureMock = new FixtureMockOsEnvProvider({
			platform: "win32",
			homeDir: "C:\\Users\\fixture",
			env: {
				MixedCaseVar: "initial-value",
			},
		});

		// Overwrite with different case
		fixtureMock.set("MIXEDCASEVAR", "updated-value");
		expect(fixtureMock.get("mixedcasevar")).toBe("updated-value");
		expect(fixtureMock.all().MIXEDCASEVAR).toBe("updated-value");

		// Delete with different case
		fixtureMock.delete("mixedCASEvar");
		expect(fixtureMock.get("MixedCaseVar")).toBeUndefined();
	});

	test("POSIX platforms preserve case-sensitive environment lookup", () => {
		const mock = new MockOsEnvProvider({
			platform: "linux",
			home: "/home/user",
			env: {
				MyVar: "case1",
				myvar: "case2",
			},
		});

		expect(mock.get("MyVar")).toBe("case1");
		expect(mock.get("myvar")).toBe("case2");
		expect(mock.get("MYVAR")).toBeUndefined();

		mock.delete("MyVar");
		expect(mock.get("MyVar")).toBeUndefined();
		expect(mock.get("myvar")).toBe("case2");
	});

	test("handles undefined and empty variable lookups gracefully", () => {
		const mock = new MockOsEnvProvider({
			platform: "darwin",
			home: "/Users/user",
			env: {
				EMPTY_VAR: "",
			},
		});

		expect(mock.get("EMPTY_VAR")).toBe("");
		expect(mock.get("")).toBeUndefined();
		expect(mock.get("UNKNOWN")).toBeUndefined();
	});
});
