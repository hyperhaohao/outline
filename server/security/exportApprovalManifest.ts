import { createHash } from "node:crypto";
import type { Transaction } from "sequelize";
import type { ExportApprovalDocument } from "@shared/types/exportApprovals";
import { AuthorizationError, InvalidRequestError } from "@server/errors";
import type { User } from "@server/models";
import { Collection, Document } from "@server/models";
import { authorize } from "@server/policies";
import { isPersonalSupervisor } from "@server/policies/utils";

/** 申请只依据原始阅读权限生成清单；分享链接上下文永远不能授予申请资格。 */
export async function approvalManifest(
  user: User,
  resourceType: "document" | "collection",
  resourceId: string,
  includeChildren: boolean,
  transaction?: Transaction
): Promise<ExportApprovalDocument[]> {
  if (
    user.isGuest ||
    user.isSuspended ||
    user.deletedAt ||
    user.team.isSuspended
  ) {
    throw AuthorizationError();
  }
  let ids: string[];
  if (resourceType === "document") {
    const root = await Document.findByPk(resourceId, {
      userId: user.id,
      transaction,
      rejectOnEmpty: true,
    });
    authorize(user, "read", root);
    if (isPersonalSupervisor(user, root.collection)) {
      throw AuthorizationError();
    }
    ids = [
      root.id,
      ...(includeChildren
        ? await root.findAllChildDocumentIds({ archivedAt: null })
        : []),
    ];
  } else {
    const collection = await Collection.findByPk(resourceId, {
      userId: user.id,
      transaction,
      rejectOnEmpty: true,
    });
    authorize(user, "readDocument", collection);
    if (isPersonalSupervisor(user, collection)) {
      throw AuthorizationError();
    }
    const rows = await Document.findAll({
      where: { collectionId: collection.id, archivedAt: null },
      transaction,
    });
    ids = rows.filter((row) => !!row.publishedAt).map((row) => row.id);
  }
  if (!ids.length || ids.length > 10000) {
    throw InvalidRequestError("请选择1至10000篇明确的资料范围");
  }
  const manifest: ExportApprovalDocument[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const document = await Document.findByPk(id, {
      userId: user.id,
      transaction,
      rejectOnEmpty: true,
    });
    authorize(user, "read", document);
    if (!document.isActive || isPersonalSupervisor(user, document.collection)) {
      throw AuthorizationError();
    }
    manifest.push({
      id: document.id,
      revision: document.revisionCount,
      updatedAt: document.updatedAt.toISOString(),
      title: document.title,
    });
  }
  return manifest;
}

/** 使用排序后的完整清单摘要，标题、版本或集合范围变化都会使原申请失效。 */
export function approvalManifestDigest(
  manifest: ExportApprovalDocument[]
): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
