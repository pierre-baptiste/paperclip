import { and, asc, eq, isNull, lte, sql, inArray } from "drizzle-orm";
import { agentWakeupRequests, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getExecutionBlocker } from "./execution-blocker.js";
import { parseObject, readNonEmptyString } from "../modules/wake-queue/domain/values.js";

type Wake = Pick<typeof agentWakeupRequests.$inferSelect, "id" | "companyId" | "agentId" | "status" | "source" | "reason" | "payload">;
type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "runtimeMode" | "status" | "errorCode" | "contextSnapshot" | "resultJson">;
type Issue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "assigneeAgentId" | "assigneeUserId" | "status" | "executionRunId" | "checkoutRunId">;

export function canResumeSettledReassignmentWait(wake: Wake | undefined, run: Run | undefined, issue: Issue | null | undefined): boolean {
  if (!wake || !run || !issue) return false;
  const payload = parseObject(wake.payload);
  const context = parseObject(payload._paperclipWakeContext);
  const result = parseObject(run.resultJson);
  const sourceId = readNonEmptyString(context.interruptedRunId) ?? readNonEmptyString(payload.interruptedRunId);
  return wake.status === "deferred_issue_execution" && wake.source === "assignment" && wake.reason === "issue_assigned" &&
    parseObject(payload.executionWait).reason === "execution_recovery" && payload.issueId === issue.id &&
    wake.companyId === issue.companyId && run.companyId === issue.companyId && wake.agentId === issue.assigneeAgentId &&
    !issue.assigneeUserId && ["todo", "in_progress"].includes(issue.status) && !issue.executionRunId && !issue.checkoutRunId &&
    sourceId === run.id && run.contextSnapshot?.issueId === issue.id && run.agentId !== wake.agentId &&
    run.runtimeMode === "legacy" && run.status === "cancelled" && run.errorCode === "issue_reassigned" &&
    result.reassignmentStopConfirmed === true && parseObject(result.executionCancellation).state === "acknowledged" &&
    !result.workspaceRestoreFailure;
}

export async function resumeSettledReassignmentWaits(db: Db,
  promote: (run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">, wakeId: string) => Promise<void>,
): Promise<void> {
  const cutoff = new Date(Date.now() - 30_000);
  const waits = await db.select({ wake: agentWakeupRequests, issue: issues }).from(agentWakeupRequests)
    .innerJoin(issues, and(eq(issues.companyId, agentWakeupRequests.companyId),
      sql`${issues.id}::text = ${agentWakeupRequests.payload}->>'issueId'`, eq(issues.assigneeAgentId, agentWakeupRequests.agentId)))
    .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
    .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.source, "assignment"),
      eq(agentWakeupRequests.reason, "issue_assigned"),
      sql`${agentWakeupRequests.payload}->'executionWait'->>'reason' = 'execution_recovery'`,
      sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
      isNull(issues.executionRunId), isNull(issues.checkoutRunId), inArray(issues.status, ["todo", "in_progress"]),
      lte(agentWakeupRequests.updatedAt, cutoff)))
    .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
  for (const { wake, issue } of waits) {
    const [claimed] = await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
      eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, wake.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"), lte(agentWakeupRequests.updatedAt, cutoff),
    )).returning({ id: agentWakeupRequests.id });
    if (!claimed) continue;
    const payload = parseObject(wake.payload);
    const sourceId = readNonEmptyString(parseObject(payload._paperclipWakeContext).interruptedRunId) ?? readNonEmptyString(payload.interruptedRunId);
    if (!sourceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId)) continue;
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, sourceId), eq(heartbeatRuns.companyId, wake.companyId)));
    if (!canResumeSettledReassignmentWait(wake, run, issue) || !run || await getExecutionBlocker(db, issue.companyId, issue.id)) continue;
    await promote(run, wake.id);
  }
}
