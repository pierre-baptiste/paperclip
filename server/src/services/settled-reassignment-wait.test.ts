import { describe, expect, it } from "vitest";
import { canResumeSettledReassignmentWait as eligible } from "./settled-reassignment-wait.js";

function fixture() {
  const wake = { id: "wake", companyId: "company", agentId: "new-owner", status: "deferred_issue_execution",
    source: "assignment", reason: "issue_assigned", payload: { issueId: "task", interruptedRunId: "source",
      executionWait: { reason: "execution_recovery" } } };
  const run = { id: "source", companyId: "company", agentId: "old-owner", runtimeMode: "legacy", status: "cancelled",
    errorCode: "issue_reassigned", contextSnapshot: { issueId: "task" }, resultJson: { reassignmentStopConfirmed: true,
      executionCancellation: { state: "acknowledged" }, workspaceRestoreFailure: null as string | null } };
  const issue = { id: "task", companyId: "company", assigneeAgentId: "new-owner", assigneeUserId: null,
    status: "in_progress", executionRunId: null as string | null, checkoutRunId: null as string | null };
  return { wake, run, issue };
}

describe("settled assignment receipt", () => {
  it("accepts an acknowledged handoff to the current owner", () => {
    const f = fixture(); expect(eligible(f.wake, f.run, f.issue)).toBe(true);
  });
  const rejected: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["operator Stop", f => { f.run.errorCode = "cancelled_by_user"; }],
    ["unacknowledged cancellation", f => { f.run.resultJson.executionCancellation.state = "requested"; }],
    ["missing handoff confirmation", f => { f.run.resultJson.reassignmentStopConfirmed = false; }],
    ["unsafe workspace", f => { f.run.resultJson.workspaceRestoreFailure = "restore_unsafe_archive"; }],
    ["cross-company source", f => { f.run.companyId = "other"; }],
    ["other source task", f => { f.run.contextSnapshot.issueId = "other"; }],
    ["other receipt task", f => { f.wake.payload.issueId = "other"; }],
    ["changed assignee", f => { f.issue.assigneeAgentId = "third-owner"; }],
    ["active execution", f => { f.issue.executionRunId = "successor"; }],
    ["retained checkout", f => { f.issue.checkoutRunId = "successor"; }],
    ["blocked task", f => { f.issue.status = "blocked"; }],
    ["completed task", f => { f.issue.status = "done"; }],
    ["native execution", f => { f.run.runtimeMode = "native"; }],
    ["claimed receipt", f => { f.wake.status = "queued"; }],
    ["source agent's own receipt", f => { f.wake.agentId = "old-owner"; }],
  ];
  it.each(rejected)("preserves %s", (_label, mutate) => {
    const f = fixture(); mutate(f); expect(eligible(f.wake, f.run, f.issue)).toBe(false);
  });
});
