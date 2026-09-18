const POLICY_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "CONTRIBUTING.md",
];

export function isProjectPolicyPath(path) {
  if (typeof path !== "string") return false;
  const normalized = path.replaceAll("\\", "/");
  return (
    POLICY_PATHS.includes(normalized) ||
    normalized.startsWith("docs/adr/") ||
    normalized.startsWith("docs/agents/") ||
    /(^|\/)(?:commit[-_]?template|\.gitmessage)(?:\.|$)/i.test(normalized)
  );
}

export function selectPolicySnapshot({ changedPaths, parentPolicy, currentPolicy }) {
  const changesPolicy = (Array.isArray(changedPaths) ? changedPaths : []).some(isProjectPolicyPath);
  return changesPolicy ? parentPolicy : currentPolicy;
}
