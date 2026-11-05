import type { APIContext } from "@server/types";
import {
  AuthorizationError,
  InvalidRequestError,
  NotFoundError,
} from "@server/errors";
import type { FileOperation } from "@server/models";
import FileStorage from "@server/storage/files";
import { sequelize } from "@server/storage/database";
import {
  authorizeApprovalCredential,
  validateApprovedFileOperation,
} from "./exportApprovalAuthorization";

/** 单次下载会话绑定当前账号及文件，在十分钟内允许Range重试，不生成匿名签名URL。 */
export async function sendApprovedDownload(
  ctx: APIContext,
  operation: FileOperation
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const approved = await validateApprovedFileOperation(
      ctx.state.auth.user,
      operation
    );
    await authorizeApprovalCredential(ctx, approved.resourceType);
    await approved.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await validateApprovedFileOperation(ctx.state.auth.user, operation);
    if (
      approved.downloadStartedAt &&
      Date.now() - approved.downloadStartedAt.getTime() > 10 * 60 * 1000
    ) {
      throw AuthorizationError("本次下载会话已结束，请重新申请");
    }
    if (!approved.downloadStartedAt) {
      await approved.update({ downloadStartedAt: new Date() }, { transaction });
    }
  });
  let start = 0;
  let end = operation.size - 1;
  const range = ctx.get("Range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      throw InvalidRequestError("仅支持单一字节范围");
    }
    if (!match[1]) {
      start = Math.max(0, operation.size - Number(match[2]));
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(end, Number(match[2])) : end;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start < 0 ||
      start >= operation.size
    ) {
      ctx.status = 416;
      ctx.set("Content-Range", `bytes */${operation.size}`);
      return;
    }
    ctx.status = 206;
    ctx.set("Content-Range", `bytes ${start}-${end}/${operation.size}`);
  }
  const stream = await FileStorage.getFileStream(
    operation.key,
    range ? { start, end } : undefined
  );
  if (!stream) {
    throw NotFoundError();
  }
  ctx.set("Cache-Control", "private, no-store");
  ctx.set("Accept-Ranges", "bytes");
  ctx.set("Content-Length", String(end - start + 1));
  ctx.type = "application/zip";
  ctx.attachment("approved-export.zip");
  ctx.body = stream;
}
