import { describe, expect, it } from "vitest";
import { intersectSessionEventToolsAllow } from "../auto-reply/reply/session-event-target.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionEventBundleMcpAllow } from "./agent-tools.session-event-policy.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";

const withServers: OpenClawConfig = {
  mcp: { servers: { fixture: { url: "http://127.0.0.1:1/mcp" } } },
} as OpenClawConfig;
const codingToolNames = ["read", "exec", "process", "write", "web_search"];

function bundleAllow(config: OpenClawConfig, runtimeToolAllowlist?: string[]) {
  return resolveSessionEventBundleMcpAllow({
    config,
    runtimeToolAllowlist,
    capabilityProfile: resolveConversationCapabilityProfile({ config }),
  });
}

// #183589: the woken turn's toolsAllow is the intersection of its own policy and
// the producer run's event-source policy; without the bundle marker that
// intersection never admits a bundle MCP runtime.
function wokenTurnCreatesBundleMcp(producerToolsAllow: string[]) {
  return shouldCreateBundleMcpRuntimeForAttempt({
    toolsEnabled: true,
    toolsAllow: intersectSessionEventToolsAllow(undefined, producerToolsAllow),
  });
}

describe("resolveSessionEventBundleMcpAllow", () => {
  it("names the bundle marker when the conversation may reach a configured MCP server", () => {
    expect(bundleAllow(withServers)).toEqual(["bundle-mcp"]);
    expect(bundleAllow(withServers, ["read", "exec", "bundle-mcp"])).toEqual(["bundle-mcp"]);
    expect(bundleAllow(withServers, ["read", "fixture__*"])).toEqual(["bundle-mcp"]);
  });

  it("stays silent without MCP servers or when the run's policy excludes bundle tools", () => {
    expect(bundleAllow({} as OpenClawConfig)).toEqual([]);
    expect(bundleAllow(withServers, ["read", "exec"])).toEqual([]);
  });

  it("keeps bundle MCP for a turn woken by an exec completion of a run that had it", () => {
    expect(wokenTurnCreatesBundleMcp(codingToolNames)).toBe(false);
    expect(wokenTurnCreatesBundleMcp([...codingToolNames, ...bundleAllow(withServers)])).toBe(true);
    expect(
      wokenTurnCreatesBundleMcp([
        ...codingToolNames,
        ...bundleAllow(withServers, ["read", "exec"]),
      ]),
    ).toBe(false);
  });
});
