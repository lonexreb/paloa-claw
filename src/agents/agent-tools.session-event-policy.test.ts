import { describe, expect, it } from "vitest";
import { intersectSessionEventToolsAllow } from "../auto-reply/reply/session-event-target.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionEventBundleMcpAllow } from "./agent-tools.session-event-policy.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import {
  applyEmbeddedAttemptToolsAllow,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";

const withServers: OpenClawConfig = {
  mcp: {
    servers: {
      fixture: { url: "http://127.0.0.1:1/mcp" },
      admin: { url: "http://127.0.0.1:2/mcp" },
    },
  },
} as OpenClawConfig;
const codingToolNames = ["read", "exec", "process", "write", "web_search"];
const mcpTool = (name: string) => ({ name, pluginId: "bundle-mcp" });
const materializedMcpTools = [
  mcpTool("fixture__read"),
  mcpTool("fixture__write"),
  mcpTool("admin__reset"),
];

function ceiling(config: OpenClawConfig, runtimeToolAllowlist?: string[]) {
  return resolveSessionEventBundleMcpAllow({
    config,
    runtimeToolAllowlist,
    capabilityProfile: resolveConversationCapabilityProfile({ config }),
  });
}

// #183589: the woken turn's toolsAllow is the intersection of its own policy and
// the producer run's event-source policy; the MCP tools it can materialize are
// whatever that intersection admits after plugin-group expansion.
function wokenTurn(producerToolsAllow: string[]) {
  const toolsAllow = intersectSessionEventToolsAllow(undefined, producerToolsAllow);
  return {
    createsBundleMcp: shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true, toolsAllow }),
    mcpTools: applyEmbeddedAttemptToolsAllow(materializedMcpTools, toolsAllow, {
      toolMeta: (tool) => ({ pluginId: tool.pluginId }),
    }).map((tool) => tool.name),
  };
}

describe("resolveSessionEventBundleMcpAllow", () => {
  it("keeps a server-scoped producer cap server-scoped", () => {
    const woken = wokenTurn([...codingToolNames, ...ceiling(withServers, ["exec", "fixture__*"])]);
    expect(ceiling(withServers, ["exec", "fixture__*"])).toEqual(["fixture__*"]);
    expect(woken.createsBundleMcp).toBe(true);
    expect(woken.mcpTools).toEqual(["fixture__read", "fixture__write"]);
  });

  it("keeps an exact-name policy exact", () => {
    const exact: OpenClawConfig = {
      ...withServers,
      tools: { allow: ["exec", "fixture__read"] },
    } as OpenClawConfig;
    expect(ceiling(exact)).toEqual(["fixture__read"]);
    expect(wokenTurn([...codingToolNames, ...ceiling(exact)]).mcpTools).toEqual(["fixture__read"]);
    expect(ceiling(withServers, ["exec", "fixture__read"])).toEqual(["fixture__read"]);
  });

  it("retains full MCP for an unrestricted producer", () => {
    expect(ceiling(withServers)).toEqual(["bundle-mcp"]);
    expect(ceiling(withServers, ["*"])).toEqual(["bundle-mcp"]);
    expect(wokenTurn([...codingToolNames, ...ceiling(withServers)]).mcpTools).toEqual(
      materializedMcpTools.map((tool) => tool.name),
    );
  });

  it("yields nothing without servers or when the producer cap excludes bundle tools", () => {
    expect(ceiling({} as OpenClawConfig)).toEqual([]);
    expect(ceiling(withServers, ["read", "exec"])).toEqual([]);
    const woken = wokenTurn([...codingToolNames, ...ceiling(withServers, ["read", "exec"])]);
    expect(woken.createsBundleMcp).toBe(false);
    expect(woken.mcpTools).toEqual([]);
  });

  it("documents the base-shaped producer policy that lost MCP on every exec wake", () => {
    expect(wokenTurn(codingToolNames).createsBundleMcp).toBe(false);
  });
});
