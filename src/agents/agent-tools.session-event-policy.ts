import type { OpenClawConfig } from "../config/config.js";
import { TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { normalizeToolPolicyName, readToolAllowlistIntersection } from "./tool-policy-shared.js";

const admitsAllMcp = (entry: string) =>
  entry === "*" || entry === "bundle-mcp" || entry === "group:plugins";
const namespaceOf = (entry: string) => {
  const index = entry.indexOf(TOOL_NAME_SEPARATOR);
  return index > 0 ? entry.slice(0, index + TOOL_NAME_SEPARATOR.length) : undefined;
};
const isNamespaceGlob = (entry: string) => {
  const namespace = namespaceOf(entry);
  return namespace !== undefined && entry === `${namespace}*`;
};

/** One restriction member of the producer's allowlist, read through the same names the handoff expands. */
function memberAdmission(member: readonly string[]) {
  const entries = member.map(normalizeToolPolicyName);
  const all = entries.some(admitsAllMcp);
  const namespaces = new Set(entries.filter(isNamespaceGlob).map((entry) => namespaceOf(entry)!));
  const exact = new Set(
    entries.filter((entry) => namespaceOf(entry) !== undefined && !entry.includes("*")),
  );
  return {
    all,
    namespaces,
    exact,
    admitsNamespace: (namespace: string) => all || namespaces.has(namespace),
    admitsExact: (name: string) =>
      all || namespaces.has(namespaceOf(name) ?? "") || exact.has(name),
  };
}

/**
 * Pattern-level intersection of the producer's allowlist members: an entry
 * survives only when every member admits it. A namespace glob needs every
 * member to admit the whole namespace; an exact name needs every member to
 * admit that name; the bundle marker needs every member to admit all MCP.
 * A member with no MCP-reaching entry empties the result.
 */
function intersectMcpCap(allow: readonly string[]): string[] {
  const members = (readToolAllowlistIntersection(allow) ?? [allow]).map(memberAdmission);
  if (members.every((member) => member.all)) {
    return ["bundle-mcp"];
  }
  const namespaces = [...new Set(members.flatMap((member) => [...member.namespaces]))].filter(
    (namespace) => members.every((member) => member.admitsNamespace(namespace)),
  );
  const exact = [...new Set(members.flatMap((member) => [...member.exact]))].filter(
    (name) =>
      !namespaces.includes(namespaceOf(name) ?? "") &&
      members.every((member) => member.admitsExact(name)),
  );
  return [...namespaces.map((namespace) => `${namespace}*`), ...exact];
}

/**
 * Bundle MCP tools materialize after the coding tools, so the default
 * event-source policy would never name them and a turn woken by an exec
 * completion lost the producer run's MCP access (#183589). The ceiling carries
 * the producer's own MCP-reaching cap: the intersection of its runtime
 * allowlist members (`fixture__*`, `fixture__read`, `bundle-mcp`), else of the
 * session's explicit allowlist, else the `bundle-mcp` marker for an unrestricted
 * run. A cap narrower than all MCP therefore never widens.
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
