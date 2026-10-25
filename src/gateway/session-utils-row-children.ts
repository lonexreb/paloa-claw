import type { SessionListRowContext } from "./session-utils-contracts.js";
import { resolveSessionChildController, resolveSessionChildOwners } from "./session-utils-core.js";
import { projectGatewaySessionRunState } from "./session-utils-display.js";
import type { projectSessionRowChildLinks } from "./session-utils-projection.js";

/** Child links a presented row lists, and whether any of them is still running. */
export function presentSessionRowChildren(params: {
  rowKey: string;
  childLinks: Readonly<ReturnType<typeof projectSessionRowChildLinks>>;
  excludedChildKeys?: ReadonlySet<string>;
  now: number;
  rowContext: Pick<
    SessionListRowContext,
    "subagentRuns" | "projectedAgentRuns" | "projectedSubagentActivity"
  >;
}): { childSessions: string[] | undefined; hasActiveChild: boolean } {
  const { rowKey, now, rowContext } = params;
  let hasActiveChild = false;
  const children = params.childLinks?.flatMap(({ key, parsedKey, entry }) => {
    if (params.excludedChildKeys?.has(key)) {
      return [];
    }
    // A promoted sidebar root keeps its lineage (ownership and tool access are
    // unchanged) but left this navigation subtree, so only a live controller
    // still shows it here or folds its activity into this row.
    if (entry.sidebarRoot === true && resolveSessionChildController(key, entry) !== rowKey) {
      return [];
    }
    const childActive = projectGatewaySessionRunState({ key, entry, parsedKey, now, rowContext })
      .fields.hasActiveSubagentRun;
    if (
      !resolveSessionChildOwners({
        key,
        entry,
        parsedKey,
        now,
        subagentRuns: rowContext.subagentRuns,
        hasActiveRun: childActive,
      }).includes(rowKey)
    ) {
      return [];
    }
    if (childActive) {
      hasActiveChild = true;
    }
    return [key];
  });
  return { childSessions: children?.length ? children : undefined, hasActiveChild };
}
