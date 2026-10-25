import { expect, it } from "vitest";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import * as subagents from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createResidentSessionRowReader } from "./session-row-projection.test-support.js";
import { resolveSessionChildOwners } from "./session-utils-core.js";

// #183389: promoting a forked conversation to the sidebar top level keeps its
// transcript lineage (parentSessionKey) but must stop its subtree's activity
// from making the former parent look busy.
it.each([
  ["promoted", true],
  ["nested", false],
] as const)(
  "%s dashboard child with an active subagent marks only its own ancestors busy",
  async (_label, promoted) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      await subagents.resetSubagentRegistryForTests({ persist: false });
      const reader = createResidentSessionRowReader();
      const formerParent = "agent:main:dashboard:former-parent";
      const child = "agent:main:dashboard:promoted-child";
      const worker = "agent:main:subagent:worker";
      const runId = "worker-run";
      const now = Date.now();
      let claim: string | undefined;
      try {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: formerParent, env },
          { sessionId: "former-parent", updatedAt: now, status: "done" },
        );
        const childEntry = {
          sessionId: "promoted-child",
          updatedAt: now,
          parentSessionKey: formerParent,
          spawnDepth: 0,
          ...(promoted ? { sidebarRoot: true } : {}),
        };
        await replaceSessionEntry({ agentId: "main", sessionKey: child, env }, childEntry);
        await replaceSessionEntry(
          { agentId: "main", sessionKey: worker, env },
          { sessionId: "worker", updatedAt: now, spawnedBy: child, spawnDepth: 1 },
        );
        subagents.seedSubagentRunForReadTest({
          runId,
          childSessionKey: worker,
          requesterSessionKey: child,
          createdAt: now,
          startedAt: now,
          cleanup: "keep",
        });
        claim = claimAgentRunContext(
          runId,
          { sessionKey: worker, sessionId: "worker", agentId: "main" },
          { trackOwner: true, ownsContext: true },
        );
        expect(await reader.row(child)).toMatchObject({
          hasActiveSubagentRun: true,
          childSessions: [worker],
        });
        const former = await reader.row(formerParent);
        if (promoted) {
          expect(former?.hasActiveSubagentRun).not.toBe(true);
          expect(former?.childSessions).toBeUndefined();
        } else {
          expect(former).toMatchObject({ hasActiveSubagentRun: true, childSessions: [child] });
        }
        // Promotion changes placement only: the former parent still owns the
        // child for tree-scoped session tools and exact access.
        expect(
          resolveSessionChildOwners({
            key: child,
            entry: childEntry,
            now,
            subagentRuns: buildSubagentSessionListReadIndex(now),
          }),
        ).toEqual([formerParent]);
      } finally {
        releaseAgentRunContext(runId, claim);
        await reader.dispose();
        await subagents.resetSubagentRegistryForTests({ persist: false });
      }
    });
  },
);
