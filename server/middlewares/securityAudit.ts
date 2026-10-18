import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { Next } from "koa";
import type { AppContext } from "@server/types";
import { identityFromContext, recordAudit } from "@server/security/audit";
import { measureBodies, recordRead } from "@server/security/readRisk";

/** 事务外记录失败与响应量；只提取固定元数据，绝不持久化请求或正文。 */
export default function securityAudit() {
  return async (ctx: AppContext, next: Next) => {
    ctx.state.securityTraceId = randomUUID();
    ctx.set("X-Request-Trace-Id", ctx.state.securityTraceId);
    const operation = ctx.path.split("/").pop() ?? "unknown";
    try {
      await next();
      const identity = identityFromContext(ctx);
      if (!identity) {
        return;
      }
      if (ctx.state.exportAttempt) {
        const body = ctx.body as
          | { data?: { fileOperation?: { id: string } } }
          | undefined;
        if (ctx.body instanceof Readable) {
          let bytes = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              callback(null, chunk);
            },
          });
          const source = ctx.body;
          source.on("error", (error) => counter.destroy(error));
          ctx.body = source.pipe(counter);
          ctx.res.once(
            "finish",
            () =>
              void recordAudit(identity, {
                operation,
                result: "complete",
                returnedBytes: bytes,
                targetIds: requestTargets(ctx),
              })
          );
          ctx.res.once("close", () => {
            if (!ctx.res.writableFinished) {
              source.destroy();
              void recordAudit(identity, {
                operation,
                result: "failed",
                reason: "response_interrupted",
                returnedBytes: bytes,
              });
            }
          });
        } else {
          await recordAudit(
            identity,
            {
              operation,
              result: body?.data?.fileOperation ? "queued" : "complete",
              targetIds: [
                ...requestTargets(ctx),
                ...(body?.data?.fileOperation
                  ? [body.data.fileOperation.id]
                  : []),
              ],
              returnedBytes:
                typeof ctx.body === "string"
                  ? Buffer.byteLength(ctx.body)
                  : body && typeof body.data === "string"
                    ? Buffer.byteLength(body.data)
                    : Buffer.isBuffer(ctx.body)
                      ? ctx.body.length
                      : 0,
            },
            true
          );
        }
      } else if (identity.channel === "api") {
        const measurement = measureBodies(ctx.body);
        if (measurement.ids.length) {
          await recordRead(
            identity,
            operation,
            measurement.ids,
            measurement.bytes
          );
        } else if (
          operation === "attachments.redirect" ||
          operation === "attachments.info"
        ) {
          await recordAudit(identity, {
            operation,
            result: "complete",
            targetIds: requestTargets(ctx),
          });
        }
      }
    } catch (error) {
      const identity = identityFromContext(ctx);
      const status =
        error && typeof error === "object" && "status" in error
          ? Number(error.status)
          : 500;
      if (
        identity &&
        !ctx.state.exportAttempt &&
        [
          "documents.export",
          "collections.export",
          "collections.export_all",
        ].includes(operation)
      ) {
        ctx.state.exportAttempt = true;
        await recordAudit(
          identity,
          { operation, result: "attempt", targetIds: requestTargets(ctx) },
          true
        );
      }
      if (
        identity &&
        (ctx.state.exportAttempt || status === 403 || status === 404)
      ) {
        await recordAudit(
          identity,
          {
            operation,
            result: status < 500 ? "denied" : "failed",
            targetIds: requestTargets(ctx),
            reason:
              ctx.state.auditReason ??
              (status < 500 ? "resource_permission" : "operation_failed"),
            riskType:
              status < 500
                ? ctx.state.auditReason === "credential_scope"
                  ? "credential_scope"
                  : "permission_denied"
                : undefined,
          },
          !!ctx.state.exportAttempt
        );
      }
      if (status === 403 && ctx.state.exportAttempt && error instanceof Error) {
        error.message = `无权执行此操作。追踪编号：${ctx.state.securityTraceId}`;
      }
      throw error;
    }
  };
}

/** 只保存 UUID 或短资源标识，含标题的 slug 不进入审计记录。 */
export function requestTargets(ctx: AppContext): string[] {
  const body = ctx.request.body as Record<string, unknown> | undefined;
  const id = body?.id ?? ctx.query?.id;
  return typeof id === "string" &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id
    ) ||
      /^[a-zA-Z0-9]{10,14}$/.test(id))
    ? [id]
    : [];
}

/** 认证完成后先持久化导出尝试，失败时不能进入业务执行。 */
export async function beginExportAudit(ctx: AppContext) {
  if (ctx.state.exportAttempt) {
    return;
  }
  if (
    ![
      "documents.export",
      "collections.export",
      "collections.export_all",
    ].includes(ctx.path?.split("/").pop() ?? "")
  ) {
    return;
  }
  const identity = identityFromContext(ctx);
  if (identity) {
    ctx.state.exportAttempt = true;
    await recordAudit(
      identity,
      {
        operation: ctx.path.split("/").pop()!,
        result: "attempt",
        targetIds: requestTargets(ctx),
      },
      true
    );
  }
}
