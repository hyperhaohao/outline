import { Hour } from "@shared/utils/time";
import SecurityAuditRetentionTask from "@server/queues/tasks/SecurityAuditRetentionTask";

/** 单独的 Worker 也调度安全审计保留期；Redis 重复任务 ID 防止多实例重复注册。 */
export async function scheduleSecurityAuditRetention() {
  await new SecurityAuditRetentionTask().schedule(
    { limit: 100000, partition: { partitionIndex: 0, partitionCount: 1 } },
    {
      repeat: { every: Hour.ms },
      jobId: "security-audit-retention",
      removeOnComplete: true,
      removeOnFail: 10,
    }
  );
}
