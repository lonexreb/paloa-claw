import type { OpenClawConfig } from "../config/config.js";
import { TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";

/**
 * Bundle MCP tools materialize after the coding tools, so the default
 * event-source policy would never name them. Keep the bundle marker whenever
 * this run may reach a configured MCP server, so a turn woken by an exec
 * completion keeps the producer run's MCP access instead of losing it to the
 * producer-policy intersection (#183589). Final tool policy still decides which
 * server tools the woken turn can call.
 */
export function resolveSessionEventBundleMcpAllow(params: {
  capabilityProfile: ResolvedConversationCapabilityProfile;
  config?: OpenClawConfig;
  runtimeToolAllowlist?: string[];
}): string[] {
  const servers = Object.keys(params.config?.mcp?.servers ?? {});
  if (servers.length === 0) {
    return [];
  }
  const namespaces = servers.map((server) => `${server.toLowerCase()}${TOOL_NAME_SEPARATOR}`);
  const runtimeAdmits = shouldCreateBundleMcpRuntimeForAttempt({
    toolsEnabled: true,
    toolsAllow: params.runtimeToolAllowlist,
    resolveConfiguredMcpNamespaces: () => namespaces,
  });
  // Probe with a server-shaped tool name: session policies match bundle tools by
  // `server__tool` name or the `bundle-mcp` marker, not by the marker name itself.
  const sessionAdmits = servers.some((server) =>
    isConversationToolAllowed(params.capabilityProfile, `${server}${TOOL_NAME_SEPARATOR}probe`, {
      pluginId: "bundle-mcp",
    }),
  );
  return runtimeAdmits && sessionAdmits ? ["bundle-mcp"] : [];
}
