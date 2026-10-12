import {
  ApiKey,
  OAuthAuthentication,
  Collection,
  Document,
  Team,
  User,
  type FileOperation,
} from "@server/models";
import { Op } from "sequelize";
import { authorize } from "@server/policies";
import { AuthorizationError } from "@server/errors";
import { FileOperationType, type NavigationNode } from "@shared/types";

/** 根据当前角色、工作区设置与资源权限统一判断导出能力。 */
export function authorizeExport(
  user: User,
  resource: Document | Collection | Team | null | undefined,
  phase: "create" | "download" = "create"
): asserts resource is Document | Collection | Team {
  if (!resource) {
    throw AuthorizationError();
  }
  const action =
    resource instanceof Document
      ? "download"
      : resource instanceof Collection
        ? phase === "download"
          ? "download"
          : "export"
        : "createExport";
  authorize(user, action, resource);
}

/** 历史任务和执行任务均重新加载授权数据，不能信任创建时的快照。 */
export async function authorizeExportOperation(
  userId: string,
  operation: FileOperation,
  checkOrigin = false
) {
  if (operation.type !== FileOperationType.Export) {
    return undefined;
  }
  const user = await User.findByPk(userId, {
    include: [{ model: Team, as: "team", required: true }],
    rejectOnEmpty: true,
  });
  if (user.isSuspended || user.teamId !== operation.teamId) {
    throw AuthorizationError();
  }
  const origin = operation.options?.audit;
  if (checkOrigin && origin?.credentialId) {
    const credential =
      (await ApiKey.findByPk(origin.credentialId)) ??
      (await OAuthAuthentication.findByPk(origin.credentialId));
    const method = operation.documentId
      ? "documents.export"
      : operation.collectionId
        ? "collections.export"
        : "collections.export_all";
    if (
      !credential ||
      credential.userId !== user.id ||
      !credential.canAccess(`/api/${method}`) ||
      (credential instanceof ApiKey &&
        credential.expiresAt &&
        credential.expiresAt < new Date()) ||
      (credential instanceof OAuthAuthentication &&
        credential.accessTokenExpiresAt < new Date())
    ) {
      throw AuthorizationError();
    }
  }
  let ids: string[] = [];
  if (operation.documentId) {
    const document = await Document.findByPk(operation.documentId, {
      userId,
      rejectOnEmpty: true,
    });
    authorizeExport(user, document);
    ids = await exportDocumentIds(document);
  } else if (operation.collectionId) {
    const collection = await Collection.findByPk(operation.collectionId, {
      userId,
      rejectOnEmpty: true,
    });
    // 创建和执行仍要求集合导出资格；历史下载沿用既有集合 download 权限。
    authorizeExport(user, collection, checkOrigin ? "create" : "download");
    ids = await exportDocumentIds(collection);
  } else {
    authorizeExport(user, user.team);
  }
  ids = [
    ...new Set([...(operation.options?.exportedDocumentIds ?? []), ...ids]),
  ];
  await authorizeExportDocuments(user, ids);
  if (checkOrigin && ids.length) {
    await operation.update(
      { options: { ...operation.options, exportedDocumentIds: ids } },
      { hooks: false }
    );
  }
  return user;
}

/** 创建、执行和下载共用当前正文清单，创建任务前也逐篇检查子文档。 */
export async function exportDocumentIds(resource: Document | Collection) {
  if (resource instanceof Document) {
    return [
      resource.id,
      ...(await resource.findAllChildDocumentIds({
        archivedAt: null,
        publishedAt: { [Op.ne]: null },
      })),
    ];
  }
  const documents = await Document.findAll({
    attributes: ["id"],
    where: {
      collectionId: resource.id,
      teamId: resource.teamId,
      archivedAt: null,
      publishedAt: { [Op.ne]: null },
    },
  });
  return documents.map((document) => document.id);
}

/** 保存实际传给导出器的树快照，文档随后移走也不能从授权清单消失。 */
export async function verifyExportTree(
  user: User,
  operation: FileOperation,
  nodes: NavigationNode[]
) {
  const ids = new Set(operation.options?.exportedDocumentIds ?? []);
  const visit = (tree: NavigationNode[]) =>
    tree.forEach((node) => {
      ids.add(node.id);
      visit(node.children ?? []);
    });
  visit(nodes);
  await authorizeExportDocuments(user, [...ids]);
  await operation.update(
    { options: { ...operation.options, exportedDocumentIds: [...ids] } },
    { hooks: false }
  );
}

/** 包含子文档或集合内容时逐篇校验，不能通过父文档绕过更严格的子文档权限。 */
export async function authorizeExportDocuments(user: User, ids: string[]) {
  for (let offset = 0; offset < ids.length; offset += 20) {
    await Promise.all(
      ids.slice(offset, offset + 20).map(async (id) => {
        const document = await Document.findByPk(id, {
          userId: user.id,
          rejectOnEmpty: true,
        });
        authorizeExport(user, document);
      })
    );
  }
}
