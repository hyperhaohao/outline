import Router from "@koa/router";
import { z } from "zod";
import { Op, type WhereOptions } from "sequelize";
import { FileOperationFormat, FileOperationState } from "@shared/types";
import { AuthorizationError, InvalidRequestError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { transaction } from "@server/middlewares/transaction";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import {
  Collection,
  Document,
  ExportApproval,
  FileOperation,
  User,
} from "@server/models";
import {
  approvalManifest,
  approvalManifestDigest,
} from "@server/security/exportApprovalManifest";
import {
  approvedExportFormats,
  authorizeApprovalCredential,
  consumePrintApproval,
  loadApprovalUser,
  validatePrintSession,
} from "@server/security/exportApprovalAuthorization";
import { identityFromContext, recordAudit } from "@server/security/audit";
import { getDingTalkIdentity } from "@server/security/dingTalkIdentity";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { notifyExportApproval } from "@server/security/exportApprovalNotifications";
import { validateApprovedFileOperation } from "@server/security/exportApprovalAuthorization";
import { Event } from "@server/models";
import Logger from "@server/logging/Logger";
import { BaseSchema } from "./schema";

const router = new Router();
const schema = BaseSchema.extend({
  body: z.object({
    id: z.uuid().optional(),
    approvalId: z.uuid().optional(),
    resourceId: z.uuid().optional(),
    resourceType: z.enum(["document", "collection"]).optional(),
    action: z.enum(["export", "print"]).optional(),
    format: z.enum(FileOperationFormat).optional(),
    includeChildDocuments: z.boolean().default(false),
    reason: z.string().trim().min(1).max(1000).optional(),
    response: z.string().trim().max(1000).optional(),
    expectedManifestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    printSession: z.string().min(32).max(100).optional(),
    status: z
      .enum([
        "pending",
        "approved",
        "rejected",
        "cancelled",
        "revoked",
        "expired",
        "invalidated",
        "consumed",
      ])
      .optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    mine: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(25),
  }),
});
type ApprovalContext = APIContext<z.infer<typeof schema>>;

router.post(
  "exportApprovals.preview",
  auth(),
  validate(schema),
  async (ctx: ApprovalContext) => {
    const { resourceId, resourceType, includeChildDocuments } = ctx.input.body;
    if (!resourceId || !resourceType) {
      throw InvalidRequestError("请选择资料范围");
    }
    const manifest = await approvalManifest(
      ctx.state.auth.user,
      resourceType,
      resourceId,
      includeChildDocuments
    );
    ctx.body = {
      data: { manifest, manifestDigest: approvalManifestDigest(manifest) },
    };
  }
);

/** API只返回申请信息和版本清单，不向列表泄露凭据或打印会话摘要。 */
async function presentApproval(approval: ExportApproval) {
  const requester = await User.findByPk(approval.userId);
  return {
    id: approval.id,
    userId: approval.userId,
    requesterName: requester?.name,
    resourceId: approval.resourceId,
    resourceType: approval.resourceType,
    action: approval.action,
    format: approval.format,
    includeChildDocuments: approval.includeChildDocuments,
    reason: approval.reason,
    manifest: approval.manifest,
    documentCount: approval.manifest.length,
    status:
      approval.expiresAt &&
      approval.expiresAt.getTime() <= Date.now() &&
      ["approved", "consumed"].includes(approval.status)
        ? "expired"
        : approval.status,
    responderId: approval.responderId,
    response: approval.response,
    respondedAt: approval.respondedAt,
    expiresAt: approval.expiresAt,
    consumedAt: approval.consumedAt,
    fileOperationId: approval.fileOperationId,
    createdAt: approval.createdAt,
  };
}

/** 审批审计由服务端取得钉钉绑定，审计失败不允许放行操作。 */
async function auditApproval(
  ctx: ApprovalContext,
  approval: ExportApproval,
  action: string
) {
  const identity = identityFromContext(ctx);
  if (!identity) {
    throw AuthorizationError();
  }
  identity.dingTalkIdentity = await getDingTalkIdentity(identity.user);
  await recordAudit(
    identity,
    {
      operation: `exportApproval.${action}`,
      result: "complete",
      targetIds: [approval.id, approval.resourceId],
      documentCount: approval.manifest.length,
    },
    true
  );
}

router.post(
  "exportApprovals.create",
  auth(),
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  validate(schema),
  transaction(),
  async (ctx: ApprovalContext) => {
    const { user } = ctx.state.auth;
    const { resourceId, resourceType, action, reason, includeChildDocuments } =
      ctx.input.body;
    if (
      !resourceId ||
      !resourceType ||
      !action ||
      !reason ||
      (action === "print" &&
        (resourceType !== "document" || includeChildDocuments))
    ) {
      throw InvalidRequestError(
        "请填写用途，并选择明确的导出范围或单篇打印文档"
      );
    }
    const format = action === "print" ? null : ctx.input.body.format;
    if (
      action === "export" &&
      (!format || !approvedExportFormats.includes(format))
    ) {
      throw InvalidRequestError("请选择当前社区版支持的导出格式");
    }
    const manifest = await approvalManifest(
      user,
      resourceType,
      resourceId,
      includeChildDocuments,
      ctx.state.transaction
    );
    const manifestDigest = approvalManifestDigest(manifest);
    if (
      ctx.input.body.expectedManifestDigest &&
      ctx.input.body.expectedManifestDigest !== manifestDigest
    ) {
      throw InvalidRequestError("资料范围已变化，请刷新清单后重新提交");
    }
    // 同一申请人串行创建，打印format为null时也不会出现并发重复申请。
    await User.findByPk(user.id, {
      transaction: ctx.state.transaction,
      lock: ctx.state.transaction.LOCK.NO_KEY_UPDATE,
      rejectOnEmpty: true,
    });
    const [approval, created] = await ExportApproval.findOrCreate({
      where: {
        teamId: user.teamId,
        userId: user.id,
        resourceId,
        resourceType,
        action,
        format: format ?? null,
        includeChildDocuments,
        manifestDigest,
        status: "pending",
      },
      defaults: { reason, manifest },
      transaction: ctx.state.transaction,
    });
    if (created) {
      await notifyExportApproval(ctx, approval, true);
    }
    await auditApproval(ctx, approval, "create");
    ctx.body = { data: await presentApproval(approval) };
  }
);

router.post(
  "exportApprovals.list",
  auth(),
  validate(schema),
  async (ctx: ApprovalContext) => {
    const { user } = ctx.state.auth;
    const { status, offset, limit } = ctx.input.body;
    if (user.isGuest) {
      throw AuthorizationError();
    }
    const statusWhere: WhereOptions<ExportApproval> =
      status === "expired"
        ? {
            status: ["approved", "consumed"],
            expiresAt: { [Op.lte]: new Date() },
          }
        : status && ["approved", "consumed"].includes(status)
          ? { status, expiresAt: { [Op.gt]: new Date() } }
          : status
            ? { status }
            : {};
    const { rows, count } = await ExportApproval.findAndCountAll({
      where: {
        teamId: user.teamId,
        ...(!user.isAdmin || ctx.input.body.mine ? { userId: user.id } : {}),
        ...statusWhere,
      },
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      offset,
      limit,
    });
    ctx.body = {
      data: await Promise.all(rows.map(presentApproval)),
      pagination: { total: count, offset, limit },
    };
  }
);

for (const action of [
  "info",
  "approve",
  "reject",
  "cancel",
  "revoke",
  "execute",
  "finishPrint",
  "retry",
] as const) {
  router.post(
    `exportApprovals.${action}`,
    auth(),
    rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
    validate(schema),
    transaction(),
    async (ctx: ApprovalContext) => {
      const { user } = ctx.state.auth;
      const id = ctx.input.body.id ?? ctx.input.body.approvalId;
      if (!id) {
        throw InvalidRequestError("缺少申请编号");
      }
      const approval = await ExportApproval.findByPk(id, {
        transaction: ctx.state.transaction,
        lock: ctx.state.transaction.LOCK.UPDATE,
        rejectOnEmpty: true,
      });
      if (
        approval.teamId !== user.teamId ||
        user.isGuest ||
        (!user.isAdmin && approval.userId !== user.id)
      ) {
        throw AuthorizationError();
      }
      if (action === "info") {
        ctx.body = { data: await presentApproval(approval) };
        return;
      }
      if (["approve", "reject", "revoke"].includes(action) && !user.isAdmin) {
        throw AuthorizationError("只有工作区管理员可以审核");
      }
      if (action === "approve") {
        if (approval.status !== "pending") {
          throw InvalidRequestError("该申请已处理");
        }
        const requester = await loadApprovalUser(approval.userId);
        const current = await approvalManifest(
          requester,
          approval.resourceType,
          approval.resourceId,
          approval.includeChildDocuments,
          ctx.state.transaction
        );
        if (approvalManifestDigest(current) !== approval.manifestDigest) {
          await approval.update(
            { status: "invalidated" },
            { transaction: ctx.state.transaction }
          );
        } else {
          await approval.update(
            {
              status: "approved",
              responderId: user.id,
              respondedAt: new Date(),
              response: ctx.input.body.response ?? null,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
            { transaction: ctx.state.transaction }
          );
        }
      } else if (action === "reject") {
        if (approval.status !== "pending" || !ctx.input.body.response) {
          throw InvalidRequestError("待审申请必须填写驳回原因");
        }
        await approval.update(
          {
            status: "rejected",
            responderId: user.id,
            respondedAt: new Date(),
            response: ctx.input.body.response,
          },
          { transaction: ctx.state.transaction }
        );
      } else if (action === "cancel") {
        if (
          approval.userId !== user.id ||
          !["pending", "approved"].includes(approval.status)
        ) {
          throw AuthorizationError();
        }
        await approval.update(
          { status: "cancelled" },
          { transaction: ctx.state.transaction }
        );
      } else if (action === "revoke") {
        await approval.update(
          {
            status: "revoked",
            printSessionDigest: null,
            printSessionExpiresAt: null,
          },
          { transaction: ctx.state.transaction }
        );
      } else if (action === "retry") {
        await authorizeApprovalCredential(ctx, approval.resourceType);
        if (approval.userId !== user.id || !approval.fileOperationId) {
          throw AuthorizationError();
        }
        const operation = await FileOperation.findByPk(
          approval.fileOperationId,
          {
            transaction: ctx.state.transaction,
            lock: ctx.state.transaction.LOCK.UPDATE,
            rejectOnEmpty: true,
          }
        );
        await validateApprovedFileOperation(user, operation);
        if (operation.state === "error") {
          await operation.update(
            { state: FileOperationState.Creating, error: null },
            { transaction: ctx.state.transaction }
          );
          ctx.state.transaction.afterCommit(() => {
            void Event.schedule({
              name: "fileOperations.create",
              modelId: operation.id,
              actorId: user.id,
              userId: user.id,
              teamId: user.teamId,
            }).catch(async () => {
              await operation.update(
                {
                  state: FileOperationState.Error,
                  error: "任务排队失败，请稍后重试原任务",
                },
                { transaction: null, hooks: false }
              );
              Logger.error(
                "审批导出原任务重试排队失败",
                new Error("Queue scheduling failed"),
                { fileOperationId: operation.id }
              );
            });
          });
        }
      } else if (action === "finishPrint") {
        if (
          !(await validatePrintSession(
            user,
            approval.resourceId,
            approval.id,
            ctx.input.body.printSession
          ))
        ) {
          throw AuthorizationError();
        }
        await approval.update(
          { printSessionDigest: null, printSessionExpiresAt: new Date() },
          { transaction: ctx.state.transaction }
        );
      } else if (action === "execute") {
        if (approval.userId !== user.id) {
          throw AuthorizationError();
        }
        if (approval.action === "print") {
          const printSession = await consumePrintApproval(ctx, approval);
          await auditApproval(ctx, approval, "printPreview");
          ctx.body = {
            data: { approval: await presentApproval(approval), printSession },
          };
          return;
        }
        if (approval.fileOperationId && approval.status === "consumed") {
          await authorizeApprovalCredential(ctx, approval.resourceType);
          const operation = await FileOperation.findByPk(
            approval.fileOperationId,
            { rejectOnEmpty: true }
          );
          await validateApprovedFileOperation(user, operation);
          ctx.body = {
            data: {
              approval: await presentApproval(approval),
              fileOperationId: approval.fileOperationId,
            },
          };
          return;
        }
        if (!approval.format) {
          throw InvalidRequestError("缺少已批准格式");
        }
        const resource =
          approval.resourceType === "document"
            ? await Document.findByPk(approval.resourceId, {
                userId: user.id,
                rejectOnEmpty: true,
                transaction: ctx.state.transaction,
              })
            : await Collection.findByPk(approval.resourceId, {
                userId: user.id,
                rejectOnEmpty: true,
                transaction: ctx.state.transaction,
              });
        ctx.input.body.approvalId = approval.id;
        ctx.input.body.includeChildDocuments = approval.includeChildDocuments;
        const operation =
          resource instanceof Document
            ? await FileOperation.createExport(ctx, {
                document: resource,
                format: approval.format,
              })
            : await FileOperation.createExport(ctx, {
                collection: resource,
                team: user.team,
                format: approval.format,
              });
        await auditApproval(ctx, approval, "execute");
        ctx.body = {
          data: {
            approval: await presentApproval(approval),
            fileOperationId: operation.id,
          },
        };
        return;
      }
      if (["approve", "reject", "revoke"].includes(action)) {
        await notifyExportApproval(ctx, approval, false);
      }
      await auditApproval(ctx, approval, action);
      ctx.body = { data: await presentApproval(approval) };
    }
  );
}

export default router;
