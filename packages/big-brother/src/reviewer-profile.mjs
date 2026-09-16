import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const DEFAULT_RESOURCE_ROOT = fileURLToPath(new URL("../resources", import.meta.url));

/**
 * Build the Big Brother-owned Prime resource profile.
 *
 * Repository documents are supplied as review evidence by the control plane;
 * they are deliberately not discovered as Prime context files. This keeps a
 * watched repository from silently replacing Big Brother's runtime doctrine.
 */
export function createReviewerProfile({ resourceRoot = DEFAULT_RESOURCE_ROOT, execution = "static-read-only" } = {}) {
	if (execution !== "static-read-only") {
		throw new Error(`unsupported reviewer execution profile: ${execution}`);
	}

	const root = resolve(resourceRoot);
	return Object.freeze({
		name: "big-brother-static-reviewer",
		execution,
		systemPromptPath: join(root, "system-prompt.md"),
		skillPaths: Object.freeze([join(root, "skills", "commit-review")]),
		// These flags are passed to the Prime CLI/RPC adapter. The adapter reads
		// systemPromptPath and passes its contents as --system-prompt.
		runtimeArgs: Object.freeze([
			"--no-context-files",
			"--no-extensions",
			"--no-prompt-templates",
			"--no-themes",
			"--no-tools",
		]),
		allowRlm: false,
	});
}

export async function loadReviewerResources(profile = createReviewerProfile()) {
	const [systemPrompt, ...skillContents] = await Promise.all([
		readFile(profile.systemPromptPath, "utf8"),
		...profile.skillPaths.map((skillPath) => readFile(join(skillPath, "SKILL.md"), "utf8")),
	]);
	return Object.freeze({
		profile,
		// Prime omits skill text from a custom prompt when all tools are disabled.
		// Embed the selected skill explicitly so the static profile still has an
		// effective procedure; skillPaths remain available to a future adapter.
		systemPrompt: [systemPrompt, ...skillContents.map((content) => `\n\n# Loaded Big Brother skill\n\n${content}`)].join(""),
		skillPaths: profile.skillPaths,
	});
}
