import CleanupOldEventsTask from "./CleanupOldEventsTask";

/** 复用原有 365 天清理与分批逻辑，只处理安全审计事件。 */
export default class SecurityAuditRetentionTask extends CleanupOldEventsTask {
  /** 独立审计调度不应清理其他业务事件。 */
  protected get eventName(): string {
    return "security.audit";
  }
}
