import type { OpenClawConfig } from "../config/config.js";
import { TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { normalizeToolPolicyName, readToolAllowlistIntersection } from "./tool-policy-shared.js";

const hasWildcardToolAllowlist = (allow: readonly string[]) =>
  allow.some((entry) => normalizeToolPolicyName(entry) === "*");

/** Allowlist entries that can reach bundle MCP tools rather than a named core tool. */
function isMcpAllowlistEntry(entry: string): boolean {
  return (
    entry === "bundle-mcp" ||
    entry === "group:plugins" ||
    entry.includes(TOOL_NAME_SEPARATOR) ||
    entry.includes("*")
  );
}

function mcpEntriesOf(allow: readonly string[]): string[] {
  const restrictions = readToolAllowlistIntersection(allow) ?? [allow];
  // An intersection of caps is only as wide as its narrowest member.
  return restrictions
    .map((restriction) =>
      hasWildcardToolAllowlist(restriction)
        ? ["bundle-mcp"]
        : restriction.filter(isMcpAllowlistEntry),
    )
    .reduce((narrowest, entries) => (entries.length < narrowest.length ? entries : narrowest));
}

/**
 * Bundle MCP tools materialize after the coding tools, so the default
 * event-source policy would never name them and a turn woken by an exec
 * completion lost the producer run's MCP access (#183589). The ceiling carries
 * the producer's own MCP-reaching cap: its runtime allowlist entries that reach
 * bundle tools (`fixture__*`, `fixture__read`, `bundle-mcp`), else the session's
 * explicit allowlist entries, else the `bundle-mcp` marker for an unrestricted
 * run. A cap narrower than all MCP therefore never widens to every server.
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
    return mcpEntriesOf(params.runtimeToolAllowlist);
  }
  const explicit = params.capabilityProfile.policy.explicitToolAllowlist;
  return explicit && explicit.length > 0 ? mcpEntriesOf(explicit) : ["bundle-mcp"];
}
