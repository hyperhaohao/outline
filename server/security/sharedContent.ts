import type { JSONObject, ProsemirrorData } from "@shared/types";

/** 分享响应保持稳定附件标识，通过需登录的受控接口读取，不把S3签名URL写进正文。 */
export function internalShareContent(
  data: ProsemirrorData,
  shareId: string,
  documentId?: string
): ProsemirrorData {
  const rewrite = (attrs: JSONObject | undefined): JSONObject | undefined => {
    if (!attrs) {
      return attrs;
    }
    return Object.fromEntries(
      Object.entries(attrs).map(([key, value]) => {
        if (
          typeof value !== "string" ||
          !["src", "href", "url"].includes(key)
        ) {
          return [key, value];
        }
        const match = /\/api\/attachments\.redirect\?id=([a-f0-9-]{36})/i.exec(
          value
        );
        if (!match) {
          return [key, value];
        }
        const query = new URLSearchParams({
          id: match[1],
          shareId,
          ...(documentId ? { documentId } : {}),
        });
        return [key, `/api/shares.attachment?${query.toString()}`];
      })
    );
  };
  return {
    ...data,
    ...(data.attrs ? { attrs: rewrite(data.attrs) } : {}),
    ...(data.content
      ? {
          content: data.content.map((child) =>
            internalShareContent(child, shareId, documentId)
          ),
        }
      : {}),
    ...(data.marks
      ? {
          marks: data.marks.map((mark) => ({
            ...mark,
            attrs: rewrite(mark.attrs),
          })),
        }
      : {}),
  };
}
