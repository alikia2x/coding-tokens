import type { OsEnvProvider } from "./env";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filename specification forbids ASCII control codes 0x00 through 0x1F
const WINDOWS_INVALID_CHARS = /[<>:"|?*\x00-\x1F]/g;
const WINDOWS_DRIVE_REGEX = /^[a-zA-Z]:/;

/**
 * Normalizes any path into a canonical form with forward slashes,
 * canonical uppercase drive letter on Windows, collapsed redundant slashes,
 * and resolved relative segments (. and ..).
 */
export function normalizePath(filePath: string): string {
	if (!filePath) return "";

	// Replace all backslashes with forward slashes
	let normalized = filePath.replace(/\\/g, "/");

	// Handle Windows drive letters: "c:/..." -> "C:/..."
	if (WINDOWS_DRIVE_REGEX.test(normalized)) {
		normalized = (normalized[0]?.toUpperCase() ?? "") + normalized.slice(1);
	}

	// Remove duplicate slashes (preserve leading // for UNC)
	const isUnc = normalized.startsWith("//") && !normalized.startsWith("///");
	normalized = normalized.replace(/\/{2,}/g, "/");
	if (isUnc && !normalized.startsWith("//")) {
		normalized = `/${normalized}`;
	}

	// Protect UNC share roots (//server/share) from segment reduction
	if (isUnc) {
		const uncMatch = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:$|\/(.*))/);
		if (
			uncMatch &&
			uncMatch[1] !== "." &&
			uncMatch[1] !== ".." &&
			uncMatch[2] !== "." &&
			uncMatch[2] !== ".."
		) {
			const uncRoot = `//${uncMatch[1]}/${uncMatch[2]}`;
			const rest = uncMatch[3] ?? "";
			const segments = rest.split("/");
			const resolved: string[] = [];

			for (const segment of segments) {
				if (segment === "" || segment === ".") {
					continue;
				}
				if (segment === "..") {
					if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
						resolved.pop();
					}
					// Relative traversal cannot pop above the UNC share root
				} else {
					resolved.push(segment);
				}
			}

			return resolved.length > 0 ? `${uncRoot}/${resolved.join("/")}` : uncRoot;
		}
	}

	// Resolve . and .. segments
	const isDrive = WINDOWS_DRIVE_REGEX.test(normalized);
	const isPosixAbsolute = normalized.startsWith("/");
	const isAbsolute = isPosixAbsolute || isDrive;

	let drivePrefix = "";
	let workPath = normalized;
	if (isDrive) {
		drivePrefix = normalized.slice(0, 2); // e.g. "C:"
		workPath = normalized.slice(2); // e.g. "/foo/bar"
	}

	const segments = workPath.split("/");
	const resolved: string[] = [];

	for (const segment of segments) {
		if (segment === "" || segment === ".") {
			continue;
		}
		if (segment === "..") {
			if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
				resolved.pop();
			} else if (!isAbsolute) {
				resolved.push("..");
			}
		} else {
			resolved.push(segment);
		}
	}

	const body = resolved.join("/");
	if (isDrive) {
		if (body.length > 0) {
			return `${drivePrefix}/${body}`;
		}
		return `${drivePrefix}/`;
	}

	if (isPosixAbsolute) {
		const prefix = isUnc ? "//" : "/";
		return `${prefix}${body}`.replace(/\/+$/, "") || prefix;
	}

	return body || (isAbsolute ? "/" : ".");
}

/**
 * Extracts a safe basename across platforms, handling both / and \
 * and stripping illegal Windows characters.
 */
export function safeBasename(filePath: string): string {
	if (!filePath) return "";
	// Strip trailing slashes
	const clean = filePath.replace(/[/\\]+$/, "");
	const segments = clean.split(/[/\\]/);
	const last = segments[segments.length - 1] || "";
	return last.replace(WINDOWS_INVALID_CHARS, "").trim();
}

/**
 * Converts a file:/// URI to a normalized filesystem path.
 */
export function uriToPath(uri: string): string {
	if (!uri.startsWith("file://")) return normalizePath(uri);
	try {
		const parsed = new URL(uri);
		let pathname: string;
		try {
			pathname = decodeURIComponent(parsed.pathname);
		} catch {
			pathname = parsed.pathname;
		}
		if (parsed.host && parsed.host !== "localhost") {
			pathname = `//${parsed.host}${pathname}`;
		} else if (/^\/[a-zA-Z]:/.test(pathname)) {
			// On Windows, URL pathname starts with leading slash before drive letter: "/C:/path"
			pathname = pathname.slice(1);
		}
		return normalizePath(pathname);
	} catch {
		// Fallback for malformed URLs
		let raw = uri.replace(/^file:\/\//, "");
		if (/^\/[a-zA-Z]:/.test(raw)) raw = raw.slice(1);
		try {
			return normalizePath(decodeURIComponent(raw));
		} catch {
			return normalizePath(raw);
		}
	}
}

/**
 * Converts a filesystem path to a file:/// URI.
 */
export function pathToUri(filePath: string): string {
	const normalized = normalizePath(filePath);
	const safeEncoded = (p: string) =>
		encodeURI(p).replace(/#/g, "%23").replace(/\?/g, "%3F");
	if (WINDOWS_DRIVE_REGEX.test(normalized)) {
		return `file:///${safeEncoded(normalized)}`;
	}
	return `file://${safeEncoded(normalized.startsWith("/") ? normalized : `/${normalized}`)}`;
}

/**
 * Expands ~, %ENV%, and $ENV in paths using the provided OsEnvProvider.
 */
export function expandPath(rawPath: string, env: OsEnvProvider): string {
	if (!rawPath) return "";

	let result = rawPath;

	// Expand ~ and ~/ or ~\
	const home = normalizePath(env.homedir());
	if (result === "~") {
		result = home;
	} else if (result.startsWith("~/") || result.startsWith("~\\")) {
		result = `${home}/${result.slice(2)}`;
	}

	// Expand %VAR%
	result = result.replace(/%([A-Za-z0-9_]+)%/g, (_match, varName) => {
		const val = env.get(varName);
		return val !== undefined ? normalizePath(val) : `%${varName}%`;
	});

	// Expand $VAR and ${VAR}
	result = result.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(match, b1, b2) => {
			const varName = b1 || b2;
			const val = env.get(varName);
			return val !== undefined ? normalizePath(val) : match;
		},
	);

	return normalizePath(result);
}
