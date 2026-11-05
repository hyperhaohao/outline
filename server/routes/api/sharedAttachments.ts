import Router from "@koa/router";
import { z } from "zod";
import { Attachment } from "@server/models";
import { AuthorizationError, NotFoundError } from "@server/errors";
import { loadPublicShare } from "@server/commands/shareLoader";
import auth from "@server/middlewares/authentication";
import validate from "@server/middlewares/validate";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { ProsemirrorHelper } from "@server/models/helpers/ProsemirrorHelper";
import FileStorage from "@server/storage/files";
import type { APIContext } from "@server/types";
import { BaseSchema } from "./schema";

const router = new Router();
const schema = BaseSchema.extend({
  query: z.object({
    id: z.uuid(),
    shareId: z.string().min(1).max(255),
    documentId: z.uuid().optional(),
  }),
});

router.get(
  "shares.attachment",
  auth(),
  validate(schema),
  async (ctx: APIContext<z.infer<typeof schema>>) => {
    const { id, shareId, documentId } = ctx.input.query;
    const { user } = ctx.state.auth;
    const { document, collection } = await loadPublicShare({
      id: shareId,
      documentId,
      user,
      authenticationType: ctx.state.auth.type,
      teamId: user.teamId,
    });
    const attachment = await Attachment.findByPk(id, { rejectOnEmpty: true });
    if (attachment.teamId !== user.teamId) {
      throw AuthorizationError();
    }
    const node = document
      ? DocumentHelper.toProsemirror(document)
      : collection
        ? DocumentHelper.toProsemirror(collection)
        : null;
    if (
      !node ||
      !ProsemirrorHelper.parseAttachmentIds(node).includes(attachment.id)
    ) {
      throw NotFoundError();
    }
    // 在线预览不生成可复用的匿名下载地址；原始附件下载仍走用户原有权限入口。
    if (!/^(image\/|application\/pdf$|video\/)/i.test(attachment.contentType)) {
      throw AuthorizationError("此附件不支持在线预览，请按原有附件权限访问");
    }
    const stream = await FileStorage.getFileStream(attachment.key);
    if (!stream) {
      throw NotFoundError();
    }
    ctx.set("Cache-Control", "private, no-store");
    ctx.set("X-Content-Type-Options", "nosniff");
    ctx.set("Content-Security-Policy", "sandbox");
    ctx.type = attachment.contentType;
    ctx.body = stream;
  }
);

export default router;
