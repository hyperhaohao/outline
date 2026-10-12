import {
  FileOperationFormat,
  FileOperationType,
  FileOperationState,
} from "@shared/types";
import { traceFunction } from "@server/logging/tracing";
import type { Collection, Team, User } from "@server/models";
import { FileOperation } from "@server/models";
import { exportAuditOrigin } from "@server/security/audit";
import {
  authorizeExportDocuments,
  exportDocumentIds,
} from "@server/security/exportAuthorization";
import { type APIContext } from "@server/types";

type Props = {
  collection?: Collection;
  team: Team;
  user: User;
  format?: FileOperationFormat;
  includeAttachments?: boolean;
  includePrivate?: boolean;
  ctx: APIContext;
};

async function collectionExporter({
  collection,
  team,
  user,
  format = FileOperationFormat.MarkdownZip,
  includeAttachments = true,
  includePrivate = true,
  ctx,
}: Props) {
  const collectionId = collection?.id;
  const exportedDocumentIds = collection
    ? await exportDocumentIds(collection)
    : [];
  await authorizeExportDocuments(user, exportedDocumentIds);
  const key = FileOperation.getExportKey({
    name: collection?.name || team.name,
    teamId: user.teamId,
    format,
  });
  const fileOperation = await FileOperation.createWithCtx(ctx, {
    type: FileOperationType.Export,
    state: FileOperationState.Creating,
    format,
    key,
    url: null,
    size: 0,
    collectionId,
    options: {
      audit: exportAuditOrigin(ctx),
      exportedDocumentIds,
      includeAttachments,
      includePrivate,
    },
    userId: user.id,
    teamId: user.teamId,
  });

  fileOperation.user = user;

  if (collection) {
    fileOperation.collection = collection;
  }

  return fileOperation;
}

export default traceFunction({
  spanName: "collectionExporter",
})(collectionExporter);
