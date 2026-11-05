import { createHash, randomBytes } from "node:crypto";
import type { Transaction } from "sequelize";
import { z } from "zod";
import { AuthenticationType, FileOperationFormat } from "@shared/types";
import { AuthorizationError, InvalidRequestError } from "@server/errors";
import type { Collection, FileOperation } from "@server/models";
import {
  ApiKey,
  OAuthAuthentication,
  Document,
  ExportApproval,
  Team,
  User,
} from "@server/models";
import type { APIContext } from "@server/types";
import {
  approvalManifest,
  approvalManifestDigest,
} from "./exportApprovalManifest";

/** 每个阶段重新校验有效期及原始资源权限；不能把审批ID当作独立的下载凭据。 */
export async function validateExportApproval(
  user: User,
  approval: ExportApproval,
  allowConsumed = false,
  transaction?: Transaction
): Promise<void> {
  if (
    approval.userId !== user.id ||
    approval.teamId !== user.teamId ||
    user.isSuspended ||
    user.deletedAt ||
    !approval.expiresAt ||
    approval.expiresAt.getTime() <= Date.now() ||
    !["approved", ...(allowConsumed ? ["consumed"] : [])].includes(
      approval.status
    )
  ) {
    throw AuthorizationError("审批无效、已失效或不属于当前账号");
  }
  const manifest = await approvalManifest(
    user,
    approval.resourceType,
    approval.resourceId,
    approval.includeChildDocuments,
    transaction
  );
  if (approvalManifestDigest(manifest) !== approval.manifestDigest) {
    throw AuthorizationError("资料版本、范围或阅读权限已变化，请重新申请");
  }
}

/** 验证后台导出任务绑定的审批和精确清单，拒绝未审批旧归档与格式替换。 */
export async function validateApprovedFileOperation(
  user: User,
  operation: FileOperation
): Promise<ExportApproval> {
  const approval = operation.options?.approvalId
    ? await ExportApproval.findByPk(operation.options.approvalId)
    : null;
  if (
    !approval ||
    approval.action !== "export" ||
    approval.fileOperationId !== operation.id ||
    approval.format !== operation.format ||
    approval.status !== "consumed"
  ) {
    throw AuthorizationError("请先提交导出申请并获得管理员批准");
  }
  await validateExportApproval(user, approval, true);
  const expected = approval.manifest.map((item) => item.id).sort();
  const actual = [...(operation.options?.exportedDocumentIds ?? [])].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw AuthorizationError("实际导出内容超出审批范围");
  }
  return approval;
}

/** 锁定已批准记录并领取一次打印预览；短期预览会话绑定账号和单篇文档。 */
export async function consumePrintApproval(
  ctx: APIContext,
  approval: ExportApproval
): Promise<string> {
  if (
    process.env.RUIMA_SAFE_MODE === "true" ||
    ctx.state.auth.type !== AuthenticationType.APP ||
    approval.action !== "print" ||
    approval.resourceType !== "document" ||
    approval.manifest.length !== 1
  ) {
    throw InvalidRequestError("打印审批仅适用于当前单篇文档");
  }
  await validateExportApproval(
    ctx.state.auth.user,
    approval,
    false,
    ctx.state.transaction
  );
  const session = randomBytes(32).toString("base64url");
  await approval.update(
    {
      status: "consumed",
      consumedAt: new Date(),
      printSessionDigest: hashPrintSession(session),
      printSessionExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
    { transaction: ctx.state.transaction }
  );
  return session;
}

/** 打印前和上下文刷新都复核会话，不持久放开文档download策略。 */
export async function validatePrintSession(
  user: User,
  documentId: string,
  approvalId?: string,
  session?: string
): Promise<boolean> {
  if (!approvalId || !session) {
    return false;
  }
  const approval = await ExportApproval.findByPk(approvalId);
  if (
    !approval ||
    approval.action !== "print" ||
    approval.resourceId !== documentId ||
    approval.printSessionDigest !== hashPrintSession(session) ||
    !approval.printSessionExpiresAt ||
    approval.printSessionExpiresAt.getTime() <= Date.now()
  ) {
    return false;
  }
  await validateExportApproval(user, approval, true);
  return true;
}

/** 会话随机值仅保存摘要，不能从数据库恢复可用的打印会话。 */
function hashPrintSession(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Worker及下载阶段加载实时身份；不继承创建任务时的角色快照。 */
export async function loadApprovalUser(userId: string): Promise<User> {
  return User.findByPk(userId, {
    include: [{ model: Team, as: "team", required: true }],
    rejectOnEmpty: true,
  });
}

/** 首期只批准当前社区版支持的可下载格式，不通过审批解锁商业版PDF导出。 */
export const approvedExportFormats = [
  FileOperationFormat.HTMLZip,
  FileOperationFormat.MarkdownZip,
  FileOperationFormat.TextBundleZip,
  FileOperationFormat.OKFZip,
  FileOperationFormat.JSON,
];

/** 审批接口不能扩展程序凭据的导出scope，执行及下载还必须具备原导出接口权限。 */
export async function authorizeApprovalCredential(
  ctx: APIContext,
  resourceType: "document" | "collection"
): Promise<void> {
  if (ctx.state.auth.type === AuthenticationType.APP) {
    return;
  }
  const credentialId = ctx.state.credentialId;
  const credential = credentialId
    ? ((await ApiKey.findByPk(credentialId)) ??
      (await OAuthAuthentication.findByPk(credentialId)))
    : null;
  if (
    !credential ||
    credential.userId !== ctx.state.auth.user.id ||
    !credential.canAccess(
      `/api/${resourceType === "document" ? "documents" : "collections"}.export`
    )
  ) {
    throw AuthorizationError("当前程序凭据没有该资料的导出scope");
  }
}

/** 创建任务前锁定单次批准；所有创建入口都必须通过此函数，不能只依赖网页校验。 */
export async function prepareApprovedExport(
  ctx: APIContext,
  resource: Document | Collection | undefined,
  format: FileOperationFormat
): Promise<ExportApproval | undefined> {
  const user = ctx.state.auth.user;
  if (resource) {
    await authorizeApprovalCredential(
      ctx,
      resource instanceof Document ? "document" : "collection"
    );
  }
  const requestedApproval = z
    .object({ approvalId: z.uuid().optional() })
    .safeParse(ctx.input?.body ?? {});
  if (
    user.isAdmin &&
    requestedApproval.success &&
    !requestedApproval.data.approvalId
  ) {
    return undefined;
  }
  if (!resource || !ctx.state.transaction) {
    throw AuthorizationError("非管理员导出必须在事务中领取单次审批");
  }
  const input = z
    .object({
      approvalId: z.uuid(),
      includeChildDocuments: z.boolean().default(false),
    })
    .safeParse(ctx.input.body);
  if (!input.success) {
    throw AuthorizationError("请先提交导出申请，等待知识库管理员审核");
  }
  const approval = await ExportApproval.findByPk(input.data.approvalId, {
    transaction: ctx.state.transaction,
    lock: ctx.state.transaction.LOCK.UPDATE,
  });
  if (
    !approval ||
    approval.action !== "export" ||
    approval.resourceId !== resource.id ||
    approval.resourceType !==
      (resource instanceof Document ? "document" : "collection") ||
    approval.format !== format
  ) {
    throw AuthorizationError("导出请求与批准的资料或格式不一致");
  }
  if (
    resource instanceof Document &&
    input.data.includeChildDocuments !== approval.includeChildDocuments
  ) {
    throw AuthorizationError("子文档范围与审批不一致");
  }
  await validateExportApproval(user, approval, false, ctx.state.transaction);
  return approval;
}
