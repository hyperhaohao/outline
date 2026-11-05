import { internalShareContent } from "./sharedContent";

describe("内部分享的稳定附件读取", () => {
  it("将图片和附件改为受登录及链接范围校验的代理，原协作数据不变", () => {
    const id = "ae2c3060-6060-423f-a870-67654f7d5551";
    const documentId = "ae2c3060-6060-423f-a870-67654f7d5552";
    const source = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: `/api/attachments.redirect?id=${id}` } },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "原始文字",
              marks: [
                {
                  type: "link",
                  attrs: { href: `/api/attachments.redirect?id=${id}` },
                },
              ],
            },
          ],
        },
      ],
    };
    const before = JSON.stringify(source);
    const result = internalShareContent(source, "test-link", documentId);
    expect(JSON.stringify(result)).toContain("/api/shares.attachment?");
    expect(JSON.stringify(result)).toContain(
      `shareId=test-link&documentId=${documentId}`
    );
    expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(result)).not.toContain("X-Amz-Signature");
  });
  it("外部链接、普通文字和站内文档引用保持原意", () => {
    const source = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://example.test/image.png" } },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "测试",
              marks: [{ type: "link", attrs: { href: "/doc/example" } }],
            },
          ],
        },
      ],
    };
    expect(internalShareContent(source, "test-link")).toEqual(source);
  });
});
