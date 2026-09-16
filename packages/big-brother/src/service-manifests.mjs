import { isAbsolute } from "node:path";

const DEFAULT_RESTART_SECONDS = 10;
const LABEL = /^[A-Za-z0-9._-]+$/;

/**
 * Render a launchd property-list for the foreground watch service.
 * The interface accepts paths and an env-file reference, never secret values.
 */
export function renderLaunchdPlist(options) {
	const service = normalizeServiceOptions(options);
	const entries = [
		keyValue("Label", stringValue(service.label)),
		keyValue(
			"ProgramArguments",
			arrayValue([service.executable, "watch", "--config", service.configPath]),
		),
		keyValue("WorkingDirectory", stringValue(service.workingDirectory)),
		keyValue("EnvironmentVariables", dictValue([
			keyValue("PATH", stringValue(service.path)),
			keyValue("BIG_BROTHER_ENV_FILE", stringValue(service.envFile)),
		])),
		keyValue("RunAtLoad", "<true/>", true),
		keyValue("KeepAlive", "<true/>", true),
		keyValue("ThrottleInterval", `<integer>${service.restartSeconds}</integer>`, true),
	];
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${entries.join("\n")}\n</dict>\n</plist>\n`;
}

/** Render a systemd unit for the foreground watch service. */
export function renderSystemdUnit(options) {
	const service = normalizeServiceOptions(options);
	return `[Unit]
Description=Big Brother repository watch service (${service.label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[service.executable, "watch", "--config", service.configPath].map(escapeSystemdWord).join(" ")}
WorkingDirectory=${escapeSystemdWord(service.workingDirectory)}
Environment=PATH=${escapeSystemdWord(service.path)}
Environment=BIG_BROTHER_ENV_FILE=${escapeSystemdWord(service.envFile)}
Restart=on-failure
RestartSec=${service.restartSeconds}

[Install]
WantedBy=default.target
`;
}

function normalizeServiceOptions(options) {
	if (!options || typeof options !== "object") throw new Error("service options must be an object");
	const label = options.label ?? "com.big-brother.watch";
	if (typeof label !== "string" || !LABEL.test(label)) throw new Error("label must contain only letters, numbers, dots, underscores, or hyphens");
	for (const field of ["executable", "configPath", "workingDirectory", "envFile"]) {
		if (typeof options[field] !== "string" || !isAbsolute(options[field])) throw new Error(`${field} must be an absolute path`);
	}
	const path = options.path ?? process.env.PATH;
	if (typeof path !== "string" || path.length === 0) throw new Error("path must be a non-empty PATH value");
	const restartSeconds = options.restartSeconds ?? DEFAULT_RESTART_SECONDS;
	if (!Number.isInteger(restartSeconds) || restartSeconds < 1) throw new Error("restartSeconds must be a positive integer");
	return { ...options, label, path, restartSeconds };
}

function keyValue(key, value, raw = false) {
	return `\t<key>${escapeXml(key)}</key>\n\t${raw ? value : value}`;
}

function stringValue(value) {
	return `<string>${escapeXml(value)}</string>`;
}

function arrayValue(values) {
	return `<array>\n${values.map((value) => `\t\t<string>${escapeXml(value)}</string>`).join("\n")}\n\t</array>`;
}

function dictValue(entries) {
	return `<dict>\n${entries.map((entry) => `\t\t${entry}`).join("\n")}\n\t</dict>`;
}

function escapeXml(value) {
	return value.replace(/[&<>'"]/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"'": "&apos;",
		'"': "&quot;",
	}[character]));
}

function escapeSystemdWord(value) {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replace(/[\t\n ]/g, (character) => `\\x${character.codePointAt(0).toString(16).padStart(2, "0")}`);
}
