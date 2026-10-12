import Router from "koa-router";
import { Op, type WhereOptions, type WhereAttributeHashValue } from "sequelize";
import { z } from "zod";
import { AuthenticationType, UserRole } from "@shared/types";
import auth from "@server/middlewares/authentication";
import validate from "@server/middlewares/validate";
import { Document, Event } from "@server/models";
import { authorize, can } from "@server/policies";
import { presentPolicies } from "@server/presenters";
import { identityFromContext, recordAudit } from "@server/security/audit";
import type { APIContext } from "@server/types";
import { BaseSchema } from "./schema";

const router = new Router();
const contextSchema = BaseSchema.extend({
  body: z.object({
    documentId: z.string().uuid(),
    accessTrace: z.string().uuid().optional(),
  }),
});
const printSchema = BaseSchema.extend({
  body: z.object({
    documentId: z.string().uuid(),
    result: z.enum(["allowed", "denied"]),
  }),
});
const listSchema = BaseSchema.extend({
  body: z.object({
    after: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
    userId: z.string().uuid().optional(),
    channel: z.enum(["web", "api", "mcp", "worker"]).optional(),
    operation: z.string().max(100).optional(),
    result: z
      .enum(["attempt", "allowed", "denied", "complete", "queued", "failed"])
      .optional(),
    riskType: z
      .enum([
        "bulk_read",
        "permission_denied",
        "unknown_tool",
        "credential_scope",
      ])
      .optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }),
});

router.post(
  "securityAudit.context",
  auth({ type: AuthenticationType.APP }),
  validate(contextSchema),
  async (ctx: APIContext<z.infer<typeof contextSchema>>) => {
    const { user } = ctx.state.auth;
    const document = await Document.findByPk(ctx.input.body.documentId, {
      userId: user.id,
      rejectOnEmpty: true,
    });
    authorize(user, "read", document);
    const identity = identityFromContext(ctx)!;
    const existing =
      ctx.input.body.accessTrace &&
      (await Event.findOne({
        where: {
          name: "security.audit",
          actorId: user.id,
          teamId: user.teamId,
          data: {
            [Op.contains]: {
              traceId: ctx.input.body.accessTrace,
              operation: "document.view",
              targetIds: [document.id],
            },
          } as unknown as WhereAttributeHashValue<Event["data"]>,
        },
      }));
    const recorded =
      !!existing ||
      (await recordAudit(identity, {
        operation: "document.view",
        result: "complete",
        targetIds: [document.id],
        documentCount: 1,
      }));
    ctx.body = {
      policies: presentPolicies(user, [document]),
      data: {
        traceId: existing
          ? ctx.input.body.accessTrace
          : recorded
            ? identity.traceId
            : undefined,
        name: user.name,
        account: user.email ?? user.id,
        canPrint: !!can(user, "download", document),
      },
    };
  }
);

router.post(
  "securityAudit.print",
  auth({ type: AuthenticationType.APP }),
  validate(printSchema),
  async (ctx: APIContext<z.infer<typeof printSchema>>) => {
    const { documentId, result } = ctx.input.body;
    const document = await Document.findByPk(documentId, {
      userId: ctx.state.auth.user.id,
      rejectOnEmpty: true,
    });
    authorize(ctx.state.auth.user, "read", document);
    await recordAudit(identityFromContext(ctx)!, {
      operation: "browser.print",
      result,
      targetIds: [documentId],
      clientReported: true,
      reason: "client_reported",
    });
    ctx.body = { success: true };
  }
);

router.post(
  "securityAudit.list",
  auth({ role: UserRole.Admin }),
  validate(listSchema),
  async (ctx: APIContext<z.infer<typeof listSchema>>) => {
    const {
      after,
      before,
      userId,
      channel,
      operation,
      result,
      riskType,
      offset,
      limit,
    } = ctx.input.body;
    const where: WhereOptions<Event> = {
      name: "security.audit",
      teamId: ctx.state.auth.user.teamId,
    };
    if (userId) {
      where.actorId = userId;
    }
    if (after || before) {
      where.createdAt = {
        ...(after ? { [Op.gte]: new Date(after) } : {}),
        ...(before ? { [Op.lte]: new Date(before) } : {}),
      };
    }
    const data = {
      ...(channel ? { channel } : {}),
      ...(operation ? { operation } : {}),
      ...(result ? { result } : {}),
      ...(riskType ? { riskType } : {}),
    };
    if (Object.keys(data).length) {
      // Sequelize 的 JSONB contains 类型未覆盖对象值，数据库仍使用参数化 JSONB 条件。
      where.data = {
        [Op.contains]: data,
      } as unknown as WhereAttributeHashValue<Event["data"]>;
    }
    const { rows, count } = await Event.findAndCountAll({
      where,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
      offset,
      limit,
    });
    ctx.body = {
      data: rows.map((event) => ({
        id: event.id,
        time: event.createdAt,
        userId: event.actorId,
        ip: event.ip,
        ...event.data,
      })),
      pagination: { total: count, offset, limit },
    };
  }
);

export default router;
