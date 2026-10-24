import { Op, type Transaction } from "sequelize";
import { FileOperationState, ImportState } from "@shared/types";
import {
  Collection,
  Document,
  FileOperation,
  Import,
  UserMembership,
  GroupMembership,
} from "@server/models";
import { AuthorizationError, ValidationError } from "@server/errors";
import { authorize } from "@server/policies";
import { identityFromContext, recordAudit } from "@server/security/audit";
import type { APIContext } from "@server/types";

/** 仅记录清理判断和授权快照；不包含文档正文或身份凭据。 */
export interface LegacyPersonalInspection {
  id: string;
  name: string;
  teamId: string;
  eligible: boolean;
  reason: string;
  counts: {
    documents: number;
    drafts: number;
    archived: number;
    deleted: number;
    unfinishedTasks: number;
  };
  userMemberships: ReturnType<UserMembership["toJSON"]>[];
  groupMemberships: ReturnType<GroupMembership["toJSON"]>[];
}

/** 核对全部状态文档和未完成任务；队列状态无法确认时一律保留。 */
export async function inspectLegacyPersonalSpace(
  collection: Collection,
  pendingCollectionIds: readonly string[] | undefined,
  transaction?: Transaction
): Promise<LegacyPersonalInspection> {
  const documents = await Document.unscoped().findAll({
    where: { teamId: collection.teamId, collectionId: collection.id },
    attributes: ["id", "publishedAt", "archivedAt", "deletedAt"],
    paranoid: false,
    transaction,
  });
  const [operations, imports, userMemberships, groupMemberships] =
    await Promise.all([
      FileOperation.count({
        where: {
          teamId: collection.teamId,
          state: [FileOperationState.Creating, FileOperationState.Uploading],
          [Op.or]: [
            { collectionId: collection.id },
            { collectionId: null, documentId: null },
          ],
        },
        transaction,
      }),
      Import.count({
        where: {
          teamId: collection.teamId,
          state: [
            ImportState.Created,
            ImportState.InProgress,
            ImportState.Processed,
          ],
        },
        transaction,
      }),
      UserMembership.findAll({
        where: { collectionId: collection.id },
        transaction,
      }),
      GroupMembership.findAll({
        where: { collectionId: collection.id },
        transaction,
      }),
    ]);
  const counts = {
    documents: documents.length,
    drafts: documents.filter((d) => !d.publishedAt).length,
    archived: documents.filter((d) => !!d.archivedAt).length,
    deleted: documents.filter((d) => !!d.deletedAt).length,
    unfinishedTasks:
      operations +
      imports +
      (pendingCollectionIds?.filter((id) => id === collection.id).length ?? 0),
  };
  const reason =
    collection.ownerId ||
    !collection.name.startsWith("个人空间｜") ||
    collection.deletedAt ||
    collection.archivedAt
      ? "not_active_legacy_personal_space"
      : documents.length
        ? "contains_documents_including_drafts_archives_or_trash"
        : pendingCollectionIds === undefined
          ? "queue_state_unverified"
          : counts.unfinishedTasks
            ? "unfinished_tasks_or_imports"
            : "empty_verified";
  return {
    id: collection.id,
    name: collection.name,
    teamId: collection.teamId,
    eligible: reason === "empty_verified",
    reason,
    counts,
    userMemberships: userMemberships.map((m) => m.toJSON()),
    groupMemberships: groupMemberships.map((m) => m.toJSON()),
  };
}

/** 维护停写期间在同一事务重查，复用集合软删除和逐项应用事件。 */
export async function removeEmptyLegacyPersonalSpace(
  ctx: APIContext,
  id: string,
  pendingCollectionIds: readonly string[] | undefined
) {
  if (!ctx.state.auth.user.isAdmin) {
    throw AuthorizationError();
  }
  const { transaction } = ctx.state;
  if (!transaction) {
    throw ValidationError(
      "Cleanup requires a transaction and a write maintenance window"
    );
  }

  // 清理期间同时阻止并发新建文档；生产运行前仍须确认已停写。
  await Collection.sequelize!.query(
    "LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE",
    { transaction }
  );
  await Collection.unscoped().findOne({
    where: { id, teamId: ctx.state.auth.user.teamId },
    transaction,
    rejectOnEmpty: true,
    lock: transaction.LOCK.UPDATE,
  });
  const collection = await Collection.findByPk(id, {
    userId: ctx.state.auth.user.id,
    transaction,
    rejectOnEmpty: true,
  });
  authorize(ctx.state.auth.user, "delete", collection);
  const inspection = await inspectLegacyPersonalSpace(
    collection,
    pendingCollectionIds,
    transaction
  );
  if (!inspection.eligible) {
    throw ValidationError(`Legacy collection retained: ${inspection.reason}`);
  }
  const identity = identityFromContext(ctx);
  if (!identity) {
    throw AuthorizationError();
  }
  await recordAudit(
    identity,
    {
      operation: "personal.legacy_cleanup",
      result: "attempt",
      targetIds: [id],
    },
    true
  );
  await collection.destroyWithCtx(ctx);
  return { ...inspection, deletedAt: collection.deletedAt };
}

/** 仅恢复本次记录的空集合，不回放文档或覆盖后续授权变更。 */
export async function restoreEmptyLegacyPersonalSpace(
  ctx: APIContext,
  inspection: LegacyPersonalInspection,
  expectedDeletedAt: string
) {
  if (
    !ctx.state.auth.user.isAdmin ||
    ctx.state.auth.user.teamId !== inspection.teamId ||
    !inspection.eligible
  ) {
    throw AuthorizationError();
  }
  const collection = await Collection.findByPk(inspection.id, {
    paranoid: false,
    transaction: ctx.state.transaction,
    rejectOnEmpty: true,
  });
  if (
    collection.ownerId ||
    !collection.deletedAt ||
    !collection.name.startsWith("个人空间｜")
  ) {
    throw ValidationError("Collection no longer matches the cleanup record");
  }
  if (new Date(collection.deletedAt).toISOString() !== expectedDeletedAt) {
    throw ValidationError(
      "Deletion timestamp differs from the cleanup receipt"
    );
  }
  const count = await Document.unscoped().count({
    where: { collectionId: collection.id },
    paranoid: false,
    transaction: ctx.state.transaction,
  });
  if (count) {
    throw ValidationError(
      "Collection has documents; manual reconciliation required"
    );
  }
  const identity = identityFromContext(ctx);
  if (!identity) {
    throw AuthorizationError();
  }
  await recordAudit(
    identity,
    {
      operation: "personal.legacy_restore",
      result: "attempt",
      targetIds: [collection.id],
    },
    true
  );
  await collection.restoreWithCtx(ctx);
  return collection;
}
