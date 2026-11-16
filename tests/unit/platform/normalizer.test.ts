import { describe, expect, test } from "bun:test";
import { MockOsEnvProvider } from "../../../src/platform/env";
import {
	expandPath,
	normalizePath,
	pathToUri,
	safeBasename,
	uriToPath,
} from "../../../src/platform/normalizer";

describe("Platform: Path Normalization & Windows Safety (Feature 2)", () => {
	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F2-T1-01: Backslash to forward slash normalization", () => {
		expect(normalizePath("foo\\bar\\baz")).toBe("foo/bar/baz");
		expect(normalizePath("C:\\Users\\alice\\AppData")).toBe(
			"C:/Users/alice/AppData",
		);
		expect(normalizePath("nested\\dir\\file.txt")).toBe("nested/dir/file.txt");
	});

	test("F2-T1-02: Windows drive letter capitalization", () => {
		expect(normalizePath("c:/Users/alice")).toBe("C:/Users/alice");
		expect(normalizePath("c:/users/alice")).toBe("C:/users/alice");
		expect(normalizePath("d:\\projects\\repo")).toBe("D:/projects/repo");
		expect(normalizePath("z:/workspace")).toBe("Z:/workspace");
		expect(normalizePath("c:")).toBe("C:/");
		expect(normalizePath("C:/")).toBe("C:/");
	});

	test("F2-T1-03: Redundant slash collapsing with UNC preservation", () => {
		expect(normalizePath("/foo///bar//baz/")).toBe("/foo/bar/baz");
		expect(normalizePath("///root///dir")).toBe("/root/dir");
		expect(normalizePath("//server/share/folder")).toBe(
			"//server/share/folder",
		);
		expect(normalizePath("//server//share///dir//file.txt")).toBe(
			"//server/share/dir/file.txt",
		);
	});

	test("F2-T1-04: Dot and double-dot relative segment resolution", () => {
		expect(normalizePath("/foo/bar/../baz")).toBe("/foo/baz");
		expect(normalizePath("foo/./bar/./baz")).toBe("foo/bar/baz");
		expect(normalizePath("C:/Users/alice/../bob")).toBe("C:/Users/bob");
		expect(normalizePath("/a/b/c/../../d")).toBe("/a/d");
		expect(normalizePath("../../relative")).toBe("../../relative");
		expect(normalizePath("./current/path")).toBe("current/path");
	});

	test("F2-T1-05: Safe basename extraction across separators", () => {
		expect(safeBasename("/Users/alice/project")).toBe("project");
		expect(safeBasename("C:\\Users\\alice\\my-repo")).toBe("my-repo");
		expect(safeBasename("/foo/bar/baz/")).toBe("baz");
		expect(safeBasename("C:\\foo\\bar\\baz\\")).toBe("baz");
		expect(safeBasename("simple.txt")).toBe("simple.txt");
	});

	test("F2-T1-06: Bidirectional URI conversion (pathToUri & uriToPath)", () => {
		// POSIX
		const posixPath = "/Users/alice/my project/repo";
		const posixUri = pathToUri(posixPath);
		expect(posixUri).toBe("file:///Users/alice/my%20project/repo");
		expect(uriToPath(posixUri)).toBe(posixPath);

		// Windows
		const winPath = "C:/Users/alice/Documents/file.txt";
		const winUri = pathToUri(winPath);
		expect(winUri).toBe("file:///C:/Users/alice/Documents/file.txt");
		expect(uriToPath(winUri)).toBe(winPath);

		// UNC
		const uncUri = "file://server/share/folder";
		expect(uriToPath(uncUri)).toBe("//server/share/folder");
	});

	// =========================================================================
	// Tier 2: Boundary & Corner Cases
	// =========================================================================

	test('F2-T2-01: Stripping Windows illegal characters in safeBasename (< > : " | ? * \\x00-\\x1F)', () => {
		expect(safeBasename("project<test>:part*")).toBe("projecttestpart");
		expect(safeBasename('my?file"|name')).toBe("myfilename");
		expect(safeBasename("file\x00\x1Fname.txt")).toBe("filename.txt");
		expect(safeBasename("  cleaned  ")).toBe("cleaned");
		expect(safeBasename('<<<>>>:::"""|||???***')).toBe("");
		expect(safeBasename('<<<bad>>>:::"""|||???***')).toBe("bad");
	});

	test("F2-T2-02: Handling malformed percent-encoded URIs without throwing", () => {
		expect(uriToPath("file:///test%80")).toBe("/test%80");
		expect(uriToPath("file:///test%ZZ")).toBe("/test%ZZ");
		expect(uriToPath("file:///C:/Users/test%80")).toBe("C:/Users/test%80");
		expect(uriToPath("file://server/share/test%80")).toBe(
			"//server/share/test%80",
		);
		// Raw non-URI strings pass through normalized
		expect(uriToPath("/Users/alice/plain/path")).toBe(
			"/Users/alice/plain/path",
		);
		expect(uriToPath("C:\\Users\\alice\\plain")).toBe("C:/Users/alice/plain");
	});

	test("F2-T2-03: Root and trailing slashes edge cases in normalizePath", () => {
		expect(normalizePath("")).toBe("");
		expect(normalizePath("/")).toBe("/");
		expect(normalizePath("///")).toBe("/");
		expect(normalizePath("C:/")).toBe("C:/");
		expect(normalizePath("C:\\")).toBe("C:/");
		expect(normalizePath("//")).toBe("//");
		expect(normalizePath("/a/b/c/")).toBe("/a/b/c");
	});

	test("F2-T2-04: expandPath handles home directory ~, Windows %VAR%, and POSIX $VAR", () => {
		// Darwin / POSIX ~ expansion
		const darwinEnv = new MockOsEnvProvider({
			platform: "darwin",
			home: "/Users/alice",
		});
		expect(expandPath("~", darwinEnv)).toBe("/Users/alice");
		expect(expandPath("~/projects/repo", darwinEnv)).toBe(
			"/Users/alice/projects/repo",
		);
		expect(expandPath("~\\projects\\repo", darwinEnv)).toBe(
			"/Users/alice/projects/repo",
		);

		// Windows %VAR% expansion
		const winEnv = new MockOsEnvProvider({
			platform: "win32",
			home: "C:\\Users\\alice",
			env: {
				APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
				LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
			},
		});
		expect(expandPath("%APPDATA%/Code/User", winEnv)).toBe(
			"C:/Users/alice/AppData/Roaming/Code/User",
		);
		expect(expandPath("%LOCALAPPDATA%\\opencode", winEnv)).toBe(
			"C:/Users/alice/AppData/Local/opencode",
		);
		expect(expandPath("%UNKNOWN_VAR%/test", winEnv)).toBe("%UNKNOWN_VAR%/test");

		// POSIX $VAR and ${VAR} expansion
		const linuxEnv = new MockOsEnvProvider({
			platform: "linux",
			home: "/home/bob",
			env: {
				XDG_DATA_HOME: "/home/bob/.local/share",
				CUSTOM: "custom_path",
			},
		});
		expect(expandPath("$XDG_DATA_HOME/opencode", linuxEnv)).toBe(
			"/home/bob/.local/share/opencode",
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test of literal ${VAR}
		expect(expandPath("${CUSTOM}/sessions", linuxEnv)).toBe(
			"custom_path/sessions",
		);
		expect(expandPath("$NONEXISTENT/dir", linuxEnv)).toBe("$NONEXISTENT/dir");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test of literal ${VAR}
		expect(expandPath("${NONEXISTENT}/dir", linuxEnv)).toBe(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test of literal ${VAR}
			"${NONEXISTENT}/dir",
		);
	});

	test("F2-T2-05: UNC share root traversal protection prevents relative segments from escaping root", () => {
		expect(normalizePath("//server/share/../../escaped")).toBe(
			"//server/share/escaped",
		);
		expect(normalizePath("//server/share/../..")).toBe("//server/share");
		expect(normalizePath("//server/share/../")).toBe("//server/share");
		expect(normalizePath("//server/share/..")).toBe("//server/share");
		expect(normalizePath("\\\\server\\share\\..\\..\\escaped")).toBe(
			"//server/share/escaped",
		);
		expect(normalizePath("\\\\server\\share\\..\\..")).toBe("//server/share");
		expect(normalizePath("//server/share/sub/../../escaped")).toBe(
			"//server/share/escaped",
		);
		expect(normalizePath("//server/share/a/b/../../c/d/../e")).toBe(
			"//server/share/c/e",
		);
	});
});
