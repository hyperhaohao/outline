import { Document, type Attachment, type User } from "@server/models";
import { AuthorizationError } from "@server/errors";
import { authorize } from "@server/policies";
import { identityFromContext, recordAudit, type AuditIdentity } from "./audit";
import { recordRead } from "./readRisk";
import type { APIContext } from "@server/types";

/** 个人附件必须继承所在文档权限，不能沿用普通附件的工作区共享规则。 */
export async function authorizePersonalAttachment(
  user: User | undefined,
  attachment: Attachment,
  identity?: AuditIdentity
) {
  if (!attachment.documentId) {
    return;
  }
  const document = await Document.findByPk(attachment.documentId, {
    userId: user?.id,
    includeContent: false,
    includeViews: false,
    paranoid: false,
  });
  if (!document?.collection?.isPersonal) {
    return;
  }
  if (!user) {
    throw AuthorizationError();
  }
  authorize(user, "read", document);
  if (identity && user?.isAdmin && document.collection.ownerId !== user.id) {
    await recordRead(identity, "personal.attachment.read", [document.id], 0);
  }
}

/** 管理员查看个人目录时记录真实访问者及所有者，不保存标题或正文。 */
export async function auditPersonalCollection(
  ctx: APIContext | undefined,
  collection: { id: string; ownerId?: string | null }
) {
  const identity = ctx && identityFromContext(ctx);
  if (
    !identity?.user.isAdmin ||
    !collection.ownerId ||
    collection.ownerId === identity.user.id
  ) {
    return;
  }
  await recordAudit(
    identity,
    {
      operation: "personal.collection.read",
      result: "complete",
      targetIds: [collection.id],
      personalOwnerIds: [collection.ownerId],
    },
    true
  );
}
