import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import {
  holdSubagentExecution,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";
import { listProjectedSessions } from "./session-utils-list.js";

// #183389: a promoted child stays under its former parent only while a live
// run controlled by that parent owns it. The retained publication must notice
// when that control ends, even though lineage, child activity and durable
// ownership all stay the same.
it("drops a promoted child from its former parent's warm publication once live control ends", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    const formerParent = "agent:main:former-parent";
    const promoted = "agent:main:dashboard:promoted";
    const worker = "agent:main:subagent:worker";
    const now = Date.now();
    seedRow(formerParent, { sessionId: formerParent, updatedAt: now, label: "Former parent" });
    seedRow(promoted, {
      sessionId: promoted,
      updatedAt: now,
      label: "Promoted",
      parentSessionKey: formerParent,
      spawnDepth: 0,
      sidebarRoot: true,
    });
    seedRow(worker, { sessionId: worker, updatedAt: now, spawnedBy: promoted, spawnDepth: 1 });
    const running = (runId: string, childSessionKey: string, requesterSessionKey: string) =>
      createSubagentRunRecord({
        runId,
        childSessionKey,
        requesterSessionKey,
        requesterDisplayKey: requesterSessionKey,
        createdAt: now - 1_000,
        startedAt: now - 1_000,
        ...(childSessionKey === promoted ? { controllerSessionKey: formerParent } : {}),
      });
    const control = running("control-run", promoted, "agent:main:requester");
    const work = running("worker-run", worker, promoted);
    for (const entry of [control, work]) {
      subagentRuns.set(entry.runId, entry);
      subagentRuns.commitOwnership(entry);
    }
    using controlExecution = holdSubagentExecution(control.runId, promoted);
    using _ = holdSubagentExecution(work.runId, worker);
    const projection = await createSessionRowProjection({ cfg });
    try {
      const list = async () =>
        (await listProjectedSessions({ projection, opts: { search: "Former parent", limit: 1 } }))
          .sessions[0];
      expect(await list()).toMatchObject({
        key: formerParent,
        hasActiveSubagentRun: true,
        childSessions: [promoted],
      });
      // The former parent's control ends; the worker keeps the promoted row busy.
      const ended = {
        ...control,
        execution: { ...control.execution, status: "terminal" as const, endedAt: Date.now() },
      };
      subagentRuns.set(ended.runId, ended);
      subagentRuns.commitOwnership(ended);
      controlExecution[Symbol.dispose]();
      const released = await list();
      expect(released?.hasActiveSubagentRun).not.toBe(true);
      expect(released?.childSessions).toBeUndefined();
    } finally {
      projection.dispose();
      subagentRuns.delete(control.runId);
      subagentRuns.delete(work.runId);
    }
  });
});
