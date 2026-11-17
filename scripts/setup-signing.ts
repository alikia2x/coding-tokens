#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface SigningIdentity {
	hash: string;
	label: string;
	teamId: string | null;
	kind: "developer_id" | "apple_dev" | "other";
}

function runSecurity(args: string[]): { ok: boolean; stdout: string } {
	const proc = Bun.spawnSync(["security", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: proc.exitCode === 0,
		stdout: proc.stdout.toString("utf8"),
	};
}

function parseIdentities(output: string): SigningIdentity[] {
	const identities: SigningIdentity[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/u.exec(line);
		if (!match) continue;
		const hash = match[1] ?? "";
		const label = match[2] ?? "";
		const teamMatch = /\(([A-Z0-9]{10})\)\s*$/u.exec(label);
		const teamId = teamMatch?.[1] ?? null;
		const kind = label.startsWith("Developer ID Application:")
			? "developer_id"
			: label.startsWith("Apple Development:")
				? "apple_dev"
				: "other";
		identities.push({ hash, label, teamId, kind });
	}
	return identities;
}

function generateCsr(email: string | null): {
	dir: string;
	keyPath: string;
	csrPath: string;
} {
	const dir = path.join(os.homedir(), ".coding-tokens-signing");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const keyPath = path.join(dir, "developer-id.key");
	const csrPath = path.join(dir, "DeveloperID.certSigningRequest");

	if (!existsSync(keyPath)) {
		const genKey = Bun.spawnSync(
			["openssl", "genrsa", "-out", keyPath, "2048"],
			{ stdout: "inherit", stderr: "inherit" },
		);
		if (genKey.exitCode !== 0) {
			throw new Error("Failed to generate RSA private key via openssl");
		}
	}

	const subject = `/emailAddress=${email ?? "developer@example.com"}/CN=Coding Tokens Developer ID/C=US`;
	const genCsr = Bun.spawnSync(
		[
			"openssl",
			"req",
			"-new",
			"-key",
			keyPath,
			"-out",
			csrPath,
			"-subj",
			subject,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (genCsr.exitCode !== 0) {
		throw new Error("Failed to generate CSR via openssl");
	}
	return { dir, keyPath, csrPath };
}

function exportP12Base64(p12Path: string): string {
	const bytes = readFileSync(p12Path);
	const encoded = bytes.toString("base64");
	const outPath = `${p12Path}.b64`;
	writeFileSync(outPath, encoded, { encoding: "utf8", mode: 0o600 });
	return outPath;
}

if (process.platform !== "darwin") {
	console.log(
		"Apple Developer ID signing setup is only available on macOS. On CI, Linux and Windows builds do not require Apple secrets.",
	);
	process.exit(0);
}

const args = process.argv.slice(2);
const wantCsr = args.includes("--csr");
const p12FlagIndex = args.indexOf("--p12");
const p12Path =
	p12FlagIndex >= 0 ? (args[p12FlagIndex + 1] ?? undefined) : undefined;

if (p12Path) {
	if (!existsSync(p12Path)) {
		console.error(`File not found: ${p12Path}`);
		process.exit(1);
	}
	const outPath = exportP12Base64(p12Path);
	console.log(`Wrote base64 certificate payload to: ${outPath}`);
	console.log(`Upload it with:\n  gh secret set MACOS_CERT_P12 < "${outPath}"`);
	process.exit(0);
}

const { stdout } = runSecurity(["find-identity", "-v", "-p", "codesigning"]);
const identities = parseIdentities(stdout);
const devId = identities.find((item) => item.kind === "developer_id");
const appleDev = identities.find((item) => item.kind === "apple_dev");
const detectedTeamId = devId?.teamId ?? appleDev?.teamId ?? "YOUR_TEAM_ID";
const emailMatch = appleDev?.label.match(/:\s*([^\s(]+@[^\s)]+)/u);
const detectedEmail = emailMatch?.[1] ?? null;

console.log("Coding Tokens macOS Signing Setup\n");
console.log(`Detected Team ID: ${detectedTeamId}`);
if (detectedEmail) {
	console.log(`Detected Apple ID email: ${detectedEmail}`);
}

if (devId) {
	console.log(
		`\nFound Developer ID Application certificate:\n  ${devId.label}`,
	);
	console.log(
		"\nNext steps:\n" +
			"1. Export both the certificate and its private key from Keychain Access as DeveloperID.p12.\n" +
			"2. Convert it to single-line base64:\n" +
			"   bun run setup:signing -- --p12 /path/to/DeveloperID.p12\n" +
			"3. Create an App-Specific Password at https://account.apple.com (Sign-In and Security -> App-Specific Passwords).\n" +
			"4. Set all 7 GitHub Actions secrets:\n" +
			"   gh secret set MACOS_CERT_P12 < /path/to/DeveloperID.p12.b64\n" +
			"   gh secret set MACOS_CERT_PASSWORD\n" +
			"   gh secret set MACOS_KEYCHAIN_PASSWORD\n" +
			`   gh secret set MACOS_DEVELOPER_ID --body "${devId.label}"\n` +
			`   gh secret set APPLE_TEAM_ID --body "${detectedTeamId}"\n` +
			`   gh secret set APPLE_ID${detectedEmail ? ` --body "${detectedEmail}"` : ""}\n` +
			"   gh secret set APPLE_APP_SPECIFIC_PASSWORD",
	);
	process.exit(0);
}

console.log(
	"\nNo 'Developer ID Application' certificate found in your login keychain.",
);
if (appleDev) {
	console.log(
		`Note: Found '${appleDev.label}', which is for local development only (not distribution).`,
	);
}

if (wantCsr) {
	const csr = generateCsr(detectedEmail);
	console.log(`\nGenerated private key: ${csr.keyPath}`);
	console.log(`Generated CSR:         ${csr.csrPath}`);
	console.log(
		"\nFollow these steps to finish setup:\n" +
			"1. Open https://developer.apple.com/account/resources/certificates/add\n" +
			"2. Choose 'Developer ID Application' (G2 Sub-CA) and upload the CSR above.\n" +
			"3. Download the .cer file and convert + combine it with your private key into a .p12:\n" +
			`   openssl x509 -in developerID_application.cer -inform DER -out "${csr.dir}/cert.pem"\n` +
			`   openssl pkcs12 -export -out "${csr.dir}/DeveloperID.p12" -inkey "${csr.keyPath}" -in "${csr.dir}/cert.pem"\n` +
			`4. Run: bun run setup:signing -- --p12 "${csr.dir}/DeveloperID.p12"\n` +
			"5. Create an App-Specific Password at https://account.apple.com and upload all 7 secrets via gh secret set.",
	);
} else {
	console.log(
		"\nRun with --csr to generate a Certificate Signing Request and private key automatically:\n" +
			"  bun run setup:signing -- --csr",
	);
}
