import type { SessionListRowContext } from "./session-utils-contracts.js";
import { resolveSessionChildController, resolveSessionChildOwners } from "./session-utils-core.js";
import { projectGatewaySessionRunState } from "./session-utils-display.js";
import type { projectSessionRowChildLinks } from "./session-utils-projection.js";

/**
 * A promoted sidebar root keeps its lineage (ownership and tool access are
 * unchanged) but left this navigation subtree, so only a live controller on the
 * row still shows it there or folds its activity into the row.
 */
export function isChildPromotedAwayFrom(
  rowKey: string,
  key: string,
  entry: NonNullable<ReturnType<typeof projectSessionRowChildLinks>>[number]["entry"],
): boolean {
  return entry.sidebarRoot === true && resolveSessionChildController(key, entry) !== rowKey;
}

/** Child links a presented row lists, and whether any of them is still running. */
export function presentSessionRowChildren(params: {
  rowKey: string;
  childLinks: Readonly<ReturnType<typeof projectSessionRowChildLinks>> | undefined;
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
    if (isChildPromotedAwayFrom(rowKey, key, entry)) {
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
