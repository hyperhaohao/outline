// @vitest-isolate true
import { Readable } from "node:stream";
import {
  FileOperationFormat,
  FileOperationState,
  UserRole,
} from "@shared/types";
import { ExportApproval, FileOperation } from "@server/models";
import FileStorage from "@server/storage/files";
import {
  buildAdmin,
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();
vi.mock("@server/storage/files", () => ({
  default: {
    getFileStream: vi.fn(),
    getSignedUrl: vi.fn(async () => "https://example.test/unused"),
  },
}));

/** 使用真实审批路由和独立合成资料创建可下载任务，只模拟对象存储的字节流。 */
async function fixture() {
  const team = await buildTeam();
  const user = await buildUser({ teamId: team.id, role: UserRole.Viewer });
  const admin = await buildAdmin({ teamId: team.id });
  const collection = await buildCollection({
    teamId: team.id,
    userId: admin.id,
  });
  const document = await buildDocument({
    teamId: team.id,
    userId: admin.id,
    collectionId: collection.id,
  });
  const response = await server.post("/api/exportApprovals.create", user, {
    body: {
      resourceId: document.id,
      resourceType: "document",
      action: "export",
      format: FileOperationFormat.MarkdownZip,
      reason: "受认证下载验证",
    },
  });
  const { data } = await response.json();
  await server.post("/api/exportApprovals.approve", admin, {
    body: { id: data.id },
  });
  const executed = await server.post("/api/exportApprovals.execute", user, {
    body: { id: data.id },
  });
  const result = await executed.json();
  const operation = await FileOperation.findByPk(result.data.fileOperationId, {
    rejectOnEmpty: true,
  });
  await operation.update({ state: FileOperationState.Complete, size: 10 });
  vi.mocked(FileStorage.getFileStream).mockImplementation(async (_key, range) =>
    Readable.from([
      Buffer.from("0123456789").subarray(
        range?.start ?? 0,
        (range?.end ?? 9) + 1
      ),
    ])
  );
  return {
    user,
    admin,
    document,
    collection,
    operation,
    approvalId: data.id as string,
  };
}

describe("审批文件的受认证下载", () => {
  it("直接返回文件流，断点续传不暴露匿名对象存储URL", async () => {
    const { user, operation } = await fixture();
    const result = await server.post("/api/fileOperations.redirect", user, {
      body: { id: operation.id },
      redirect: "manual",
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("location")).toBeNull();
    expect(await result.text()).toBe("0123456789");
    const resumed = await server.post("/api/fileOperations.redirect", user, {
      body: { id: operation.id },
      headers: { Range: "bytes=4-7" },
      redirect: "manual",
    });
    expect(resumed.status).toBe(206);
    expect(resumed.headers.get("content-range")).toBe("bytes 4-7/10");
    expect(await resumed.text()).toBe("4567");
  });
  it("他人、撤销、过期、权限撤回和文档变更均不能取得原文件", async () => {
    const { user, admin, document, operation, approvalId } = await fixture();
    const other = await buildUser({ teamId: user.teamId });
    expect(
      (
        await server.post("/api/fileOperations.redirect", other, {
          body: { id: operation.id },
        })
      ).status
    ).toBe(403);
    await server.post("/api/exportApprovals.revoke", admin, {
      body: { id: approvalId },
    });
    expect(
      (
        await server.post("/api/fileOperations.redirect", user, {
          body: { id: operation.id },
        })
      ).status
    ).toBe(403);
    await ExportApproval.update(
      { status: "consumed", expiresAt: new Date(Date.now() - 1000) },
      { where: { id: approvalId } }
    );
    expect(
      (
        await server.post("/api/fileOperations.redirect", user, {
          body: { id: operation.id },
        })
      ).status
    ).toBe(403);
    await ExportApproval.update(
      { expiresAt: new Date(Date.now() + 60000) },
      { where: { id: approvalId } }
    );
    await document.update({ title: "审批后变化" });
    expect(
      (
        await server.post("/api/fileOperations.redirect", user, {
          body: { id: operation.id },
        })
      ).status
    ).toBe(403);
  });
  it("下载会话过期、超出范围和撤销原阅读权均拒绝续传", async () => {
    const { user, collection, operation, approvalId } = await fixture();
    const result = await server.post("/api/fileOperations.redirect", user, {
      body: { id: operation.id },
      headers: { Range: "bytes=50-" },
      redirect: "manual",
    });
    expect(result.status).toBe(416);
    await ExportApproval.update(
      { downloadStartedAt: new Date(Date.now() - 11 * 60000) },
      { where: { id: approvalId } }
    );
    expect(
      (
        await server.post("/api/fileOperations.redirect", user, {
          body: { id: operation.id },
        })
      ).status
    ).toBe(403);
    await ExportApproval.update(
      { downloadStartedAt: null },
      { where: { id: approvalId } }
    );
    await collection.update({ permission: null });
    expect(
      (
        await server.post("/api/fileOperations.redirect", user, {
          body: { id: operation.id },
        })
      ).status
    ).toBe(403);
  });
});
