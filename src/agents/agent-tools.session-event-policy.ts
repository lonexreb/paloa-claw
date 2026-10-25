import type { OpenClawConfig } from "../config/config.js";
import { TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createRuntimeToolMatcher } from "./tool-policy-match.js";
import { normalizeToolPolicyName, readToolAllowlistIntersection } from "./tool-policy-shared.js";

const admitsAllMcp = (entry: string) =>
  entry === "*" || entry === "bundle-mcp" || entry === "group:plugins";
const namespaceOf = (entry: string) => {
  const index = entry.indexOf(TOOL_NAME_SEPARATOR);
  return index > 0 ? entry.slice(0, index + TOOL_NAME_SEPARATOR.length) : undefined;
};
/** Entries that can reach a bundle MCP tool: the markers or any `server__…` name or glob. */
const reachesMcp = (entry: string) => admitsAllMcp(entry) || namespaceOf(entry) !== undefined;

/**
 * One restriction member of the producer's allowlist. Exact names are judged by
 * the shared runtime matcher (the one applyEmbeddedAttemptToolsAllow uses);
 * globs survive only when a member admits all MCP, their whole namespace, or
 * the identical pattern, since no catalog exists when the policy is built.
 */
function member(entries: readonly string[]) {
  const normalized = entries.map(normalizeToolPolicyName);
  const all = normalized.some(admitsAllMcp);
  const matches = createRuntimeToolMatcher(normalized);
  return {
    all,
    candidates: normalized.filter(reachesMcp),
    admitsExact: (name: string) => all || matches(name),
    admitsGlob: (glob: string) =>
      all || normalized.includes(glob) || normalized.includes(`${namespaceOf(glob) ?? ""}*`),
  };
}

/** Pattern-level intersection: an entry survives only when every member admits everything it can admit. */
function intersectMcpCap(allow: readonly string[]): string[] {
  const members = (readToolAllowlistIntersection(allow) ?? [allow]).map(member);
  if (members.every((entry) => entry.all)) {
    return ["bundle-mcp"];
  }
  const candidates = [...new Set(members.flatMap((entry) => entry.candidates))].filter(
    (candidate) => !admitsAllMcp(candidate),
  );
  const globs = candidates.filter(
    (candidate) => candidate.includes("*") && members.every((entry) => entry.admitsGlob(candidate)),
  );
  const coveredByGlob = createRuntimeToolMatcher(globs.length > 0 ? globs : [""]);
  const exact = candidates.filter(
    (candidate) =>
      !candidate.includes("*") &&
      !(globs.length > 0 && coveredByGlob(candidate)) &&
      members.every((entry) => entry.admitsExact(candidate)),
  );
  return [...globs, ...exact];
}

/**
 * Bundle MCP tools materialize after the coding tools, so the default
 * event-source policy would never name them and a turn woken by an exec
 * completion lost the producer run's MCP access (#183589). The ceiling carries
 * the producer's own MCP-reaching cap: the intersection of its runtime
 * allowlist members, else of the session's explicit allowlist, else the
 * `bundle-mcp` marker for an unrestricted run. A cap narrower than all MCP
 * therefore never widens.
 */
export function resolveSessionEventBundleMcpAllow(params: {
  capabilityProfile: ResolvedConversationCapabilityProfile;
  config?: OpenClawConfig;
  runtimeToolAllowlist?: string[];
}): string[] {
  if (Object.keys(params.config?.mcp?.servers ?? {}).length === 0) {
    return [];
  }
  if (params.runtimeToolAllowlist) {
    return intersectMcpCap(params.runtimeToolAllowlist);
  }
  const explicit = params.capabilityProfile.policy.explicitToolAllowlist;
  return explicit && explicit.length > 0 ? intersectMcpCap(explicit) : ["bundle-mcp"];
}
