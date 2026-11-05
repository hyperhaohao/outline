import { CollectionPermission } from "@shared/types";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
} from "@server/errors";
import type { Share } from "@server/models";
import { Collection, Document, Team, User } from "@server/models";
import { can } from "@server/policies";

/** 内部分享只允许同工作区的有效员工，不能把Guest或停用身份降级为匿名访问。 */
export function isInternalShareMember(
  user: User | undefined,
  teamId: string
): user is User {
  return (
    !!user &&
    user.teamId === teamId &&
    !user.isGuest &&
    !user.isSuspended &&
    !user.deletedAt &&
    !user.isInvited
  );
}

/** 分享管理权来自本人个人区域或集合管理授权，与Viewer全局角色无关。 */
export function canManageInternalShare(
  user: User,
  resource: Document | Collection | null | undefined
): boolean {
  if (
    !resource ||
    !isInternalShareMember(user, resource.teamId) ||
    !user.team.sharing ||
    user.team.isSuspended
  ) {
    return false;
  }
  const collection =
    resource instanceof Collection ? resource : resource.collection;
  if (!collection || !collection.isActive || !collection.sharing) {
    return false;
  }
  if (
    resource instanceof Document &&
    (!resource.publishedAt ||
      !resource.isActive ||
      !can(user, "read", resource))
  ) {
    return false;
  }
  if (collection.isPersonal) {
    return resource instanceof Document && collection.ownerId === user.id;
  }
  return (
    user.isAdmin ||
    [
      ...(collection.memberships ?? []),
      ...(collection.groupMemberships ?? []),
    ].some((membership) => membership.permission === CollectionPermission.Admin)
  );
}

/** 每次读取重新加载创建者及原始授权，防止其离职或失去管理权后链接继续生效。 */
export async function authorizeInternalShareReader(
  user: User | undefined,
  share: Share
): Promise<void> {
  if (process.env.RUIMA_SAFE_MODE === "true") {
    throw NotFoundError();
  }
  if (!user) {
    throw AuthenticationError("请先登录瑞玛知识库");
  }
  if (
    !isInternalShareMember(user, share.teamId) ||
    share.audience !== "workspace" ||
    !share.internalEnabled ||
    share.revokedAt
  ) {
    throw NotFoundError();
  }
  const currentUser = await User.findByPk(user.id, {
    include: [{ model: Team, as: "team" }],
  });
  if (!currentUser || !isInternalShareMember(currentUser, share.teamId)) {
    throw AuthorizationError();
  }
  const creator = await User.findByPk(share.userId, {
    include: [{ model: Team, as: "team" }],
  });
  if (!creator || (!share.documentId && !share.collectionId)) {
    throw NotFoundError();
  }
  const resource = share.documentId
    ? await Document.findByPk(share.documentId, { userId: creator.id })
    : share.collectionId
      ? await Collection.findByPk(share.collectionId, { userId: creator.id })
      : null;
  if (!canManageInternalShare(creator, resource)) {
    throw NotFoundError();
  }
}
