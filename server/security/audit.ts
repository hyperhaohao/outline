import { randomUUID } from "node:crypto";
import httpErrors from "http-errors";
import { AuthenticationType } from "@shared/types";
import Logger from "@server/logging/Logger";
import { Event, type User } from "@server/models";
import type { AppContext } from "@server/types";
import { normalizeIp } from "@server/utils/ip";

/** 审计仅接收白名单元数据，不接受正文、凭据或完整请求。 */
export interface AuditIdentity {
  user: User;
  channel: "web" | "api" | "mcp" | "worker";
  traceId: string;
  credentialId?: string;
  clientId?: string;
  ip?: string;
}

/** 审计结果描述，目标仅保存标识，避免无权资源信息泄露。 */
export interface AuditOperation {
  operation: string;
  result: "attempt" | "allowed" | "denied" | "complete" | "queued" | "failed";
  targetIds?: string[];
  reason?: string;
  riskType?: string;
  documentCount?: number;
  returnedBytes?: number;
  clientReported?: boolean;
}

/** 从可信的认证状态生成审计身份；追踪编号只能由服务端生成。 */
export function identityFromContext(
  ctx: AppContext
): AuditIdentity | undefined {
  const user = ctx.state.auth?.user ?? ctx.state.auditUser;
  if (!user) {
    return undefined;
  }
  return {
    user,
    traceId: ctx.state.securityTraceId ?? randomUUID(),
    channel: ctx.originalUrl.startsWith("/mcp")
      ? "mcp"
      : (ctx.state.auth?.type ?? ctx.state.auditAuthType) ===
          AuthenticationType.APP
        ? "web"
        : "api",
    credentialId: ctx.state.credentialId,
    clientId: ctx.state.auditClientId,
    ip: ctx.request.ip,
  };
}

/** 将后台任务需要的来源字段列入白名单，禁止把 User 或整个请求序列化。 */
export function exportAuditOrigin(ctx: AppContext) {
  const identity = identityFromContext(ctx);
  return identity
    ? {
        traceId: identity.traceId,
        credentialId: identity.credentialId,
        clientId: identity.clientId,
        channel: identity.channel,
      }
    : undefined;
}

/** 独立提交事件，业务事务回滚不能撤销记录；导出审计失败时关闭操作。 */
export async function recordAudit(
  identity: AuditIdentity,
  operation: AuditOperation,
  required = false
): Promise<boolean> {
  try {
    await Event.create(
      {
        name: "security.audit",
        teamId: identity.user.teamId,
        actorId: identity.user.id,
        ip: normalizeIp(identity.ip),
        data: {
          role: identity.user.role,
          channel: identity.channel,
          traceId: identity.traceId,
          credentialId: identity.credentialId,
          clientId: identity.clientId,
          operation: operation.operation,
          result: operation.result,
          targetIds: operation.targetIds?.slice(0, 1000),
          reason: operation.reason,
          riskType: operation.riskType,
          documentCount: operation.documentCount ?? 0,
          returnedBytes: operation.returnedBytes ?? 0,
          clientReported: operation.clientReported ?? false,
        },
      },
      { transaction: null, hooks: false }
    );
    return true;
  } catch (error) {
    Logger.error(
      "安全审计写入失败",
      error instanceof Error ? error : new Error("Audit failed"),
      {
        traceId: identity.traceId,
        operation: operation.operation,
      }
    );
    if (required) {
      throw httpErrors(
        503,
        `审计服务不可用，操作未执行。追踪编号：${identity.traceId}`
      );
    }
    return false;
  }
}
