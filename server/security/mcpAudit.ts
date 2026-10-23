import type { CallToolResult } from "@modelcontextprotocol/server";
import AuthenticationHelper from "@shared/helpers/AuthenticationHelper";
import { recordAudit, type AuditIdentity } from "./audit";
import { measureBodies, recordRead } from "./readRisk";

/** 工具和底层 API scope 的映射，预检未注册或凭据无权调用的工具。 */
export const toolScopes: Record<string, string> = {
  list_documents: "documents.list",
  list_collection_documents: "collections.documents",
  create_document: "documents.create",
  update_document: "documents.update",
  move_document: "documents.move",
  delete_document: "documents.delete",
  restore_document: "documents.restore",
  list_collections: "collections.list",
  create_collection: "collections.create",
  update_collection: "collections.update",
  delete_collection: "collections.delete",
  list_comments: "comments.list",
  create_comment: "comments.create",
  update_comment: "comments.update",
  delete_comment: "comments.delete",
  list_templates: "templates.list",
  list_users: "users.list",
  create_attachment: "attachments.create",
};

/** fetch 根据资源类型执行具体 scope 预检，不能借其他可读资源扩大权限。 */
export function allowedTool(name: string, scopes: string[], resource?: string) {
  if (name === "fetch") {
    const method = {
      document: "documents.info",
      collection: "collections.info",
      user: "users.info",
      attachment: "attachments.info",
      template: "templates.info",
    }[resource ?? ""];
    return method && AuthenticationHelper.canAccess(method, scopes)
      ? "allowed"
      : "credential_scope";
  }
  // 历史差异工具同时读取修订目录与正文，两个作用域缺一不可。
  if (name === "get_document_changes") {
    return ["revisions.list", "revisions.info"].every((method) =>
      AuthenticationHelper.canAccess(method, scopes)
    )
      ? "allowed"
      : "credential_scope";
  }
  const method = Object.hasOwn(toolScopes, name) ? toolScopes[name] : undefined;
  return !method
    ? "unknown_tool"
    : AuthenticationHelper.canAccess(method, scopes)
      ? "allowed"
      : "credential_scope";
}

/** 统计工具返回正文，不持久化响应或签名地址；权限错误只返回通用追踪信息。 */
export async function auditToolResult(
  identity: AuditIdentity,
  name: string,
  args: unknown,
  result: CallToolResult
) {
  const input =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const targets: string[] = [];
  let bytes = 0;
  // 差异是明文返回的历史正文，同样计入用户级跨凭据读取风险。
  if (name === "get_document_changes" && typeof input.id === "string") {
    targets.push(input.id);
  }
  for (const block of result.content) {
    if (block.type !== "text") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(block.text);
      const measured = measureBodies(parsed);
      targets.push(...measured.ids);
      bytes += measured.bytes;
      if (name === "fetch" && parsed && typeof parsed === "object") {
        const item = parsed as { id?: unknown; document?: { id?: unknown } };
        const id = item.document?.id ?? item.id;
        if (typeof id === "string") {
          targets.push(id);
        }
      }
    } catch {
      if (
        name === "get_document_changes" ||
        (name === "fetch" &&
          (input.resource === "document" || input.resource === "template"))
      ) {
        bytes += Buffer.byteLength(block.text);
      }
    }
  }
  if (result.isError) {
    const denied = result.content.some(
      (block) =>
        block.type === "text" &&
        /authorization|forbidden|scope|access.*denied/i.test(block.text)
    );
    await recordAudit(identity, {
      operation: name,
      result: denied ? "denied" : "failed",
      reason: denied ? "resource_permission" : "tool_failed",
      riskType: denied ? "permission_denied" : undefined,
    });
    if (denied) {
      return {
        ...result,
        content: [
          {
            type: "text" as const,
            text: `无权执行此操作。追踪编号：${identity.traceId}`,
          },
        ],
      };
    }
  } else if (
    bytes ||
    (name === "fetch" &&
      ["document", "template"].includes(String(input.resource)))
  ) {
    await recordRead(identity, name, targets, bytes);
  } else if (name === "fetch" && input.resource === "attachment") {
    await recordAudit(identity, {
      operation: "attachment.download_link",
      result: "complete",
      targetIds: targets,
    });
  }
  return result;
}
