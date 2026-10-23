// @vitest-isolate true
import { randomUUID } from "node:crypto";
import {
  CollectionPermission,
  DocumentPermission,
  FileOperationState,
  FileOperationType,
  TeamPreference,
  UserRole,
} from "@shared/types";
import { Event, UserMembership } from "@server/models";
import { sequelize } from "@server/storage/database";
import RedisAdapter from "@server/storage/redis";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import {
  buildAdmin,
  buildAttachment,
  buildApiKey,
  buildCollection,
  buildDocument,
  buildFileOperation,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import ExportMarkdownZipTask from "@server/queues/tasks/ExportMarkdownZipTask";
import SecurityAuditRetentionTask from "@server/queues/tasks/SecurityAuditRetentionTask";
import { recordAudit } from "./audit";
import { allowedTool } from "./mcpAudit";
import { withTracing } from "@server/mcp/util";
import { authorizeExportOperation } from "./exportAuthorization";
import { readRiskConfig, readRiskScript, recordRead } from "./readRisk";

const server = getTestServer();
vi.mock("@server/storage/files");

/** 创建独立角色和可读文档，避免角色测试被资源不可读混淆。 */
async function fixture(role = UserRole.Member, enabled = false) {
  const team = await buildTeam();
  team.setPreference(TeamPreference.ViewersCanExport, enabled);
  team.setPreference(TeamPreference.MCP, true);
  await team.save();
  const admin = await buildAdmin({ teamId: team.id });
  const user = await buildUser({ teamId: team.id, role });
  const collection = await buildCollection({
    teamId: team.id,
    userId: admin.id,
    permission: CollectionPermission.ReadWrite,
  });
  const document = await buildDocument({
    teamId: team.id,
    userId: admin.id,
    collectionId: collection.id,
  });
  await UserMembership.create({
    userId: user.id,
    documentId: document.id,
    permission: DocumentPermission.Read,
    createdById: admin.id,
  });
  const key = await buildApiKey({ userId: user.id, scope: ["read"] });
  return { team, admin, user, document, key, collection };
}

afterEach(() => vi.restoreAllMocks());

describe("导出与风险审计", () => {
  it("缺少归档文档清单的旧结果拒绝非管理员下载，管理员仍按资源规则检查", async () => {
    const { user, admin, team, collection } = await fixture();
    await UserMembership.create({
      userId: user.id,
      collectionId: collection.id,
      permission: CollectionPermission.Admin,
      createdById: admin.id,
    });
    const operation = await buildFileOperation({
      type: FileOperationType.Export,
      state: FileOperationState.Complete,
      teamId: team.id,
      userId: user.id,
      collectionId: collection.id,
    });
    const response = await server.post("/api/fileOperations.redirect", user, {
      body: { id: operation.id },
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(await authorizeExportOperation(admin.id, operation)).toBeDefined();
    const denied = await Event.findAll({
      where: {
        name: "security.audit",
        actorId: user.id,
        data: { result: "denied" },
      },
    });
    expect(denied).toHaveLength(1);
    expect(denied[0].data?.reason).toBe("legacy_export_manifest");
    // 新任务在实际生成前取得清单，之后仍可按现有成员权限下载。
    await authorizeExportOperation(user.id, operation, true);
    await operation.reload();
    expect(await authorizeExportOperation(user.id, operation)).toBeDefined();
  });
  for (const enabled of [false, true]) {
    for (const role of [
      UserRole.Admin,
      UserRole.Member,
      UserRole.Viewer,
      UserRole.Guest,
    ]) {
      it(`网页与 read scope API 导出一致：${role}，开关 ${enabled}`, async () => {
        const { user, key, document } = await fixture(role, enabled);
        const allowed =
          enabled || role === UserRole.Admin || role === UserRole.Member;
        const web = await server.post("/api/documents.export", user, {
          body: { id: document.id },
        });
        const api = await server.post("/api/documents.export", {
          headers: { Authorization: `Bearer ${key.value}` },
          body: { id: document.id },
        });
        expect(web.status).toBe(allowed ? 200 : 403);
        expect(api.status).toBe(web.status);
        expect(api.headers.get("x-request-trace-id")).toMatch(
          /^[0-9a-f-]{36}$/
        );
        const events = await Event.findAll({
          where: { name: "security.audit", actorId: user.id },
        });
        expect(
          events.filter((event) => event.data?.result === "attempt")
        ).toHaveLength(2);
        expect(
          events.filter(
            (event) => event.data?.result === (allowed ? "complete" : "denied")
          )
        ).toHaveLength(2);
        expect(JSON.stringify(events.map((event) => event.data))).not.toContain(
          key.value
        );
      });
    }
  }

  it("关闭开关的 Viewer 不能直调集合、全库或历史导出下载，阅读 MCP 仍允许", async () => {
    const { user, key, document, collection } = await fixture(UserRole.Viewer);
    const operation = await buildFileOperation({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
      state: FileOperationState.Complete,
    });
    for (const [path, id] of [
      ["collections.export", collection.id],
      ["collections.export_all", undefined],
      ["documents.export", document.id],
      ["fileOperations.redirect", operation.id],
    ]) {
      const response = await server.post(`/api/${path}`, {
        headers: { Authorization: `Bearer ${key.value}` },
        body: id ? { id } : {},
      });
      expect(response.status).toBe(403);
    }
    const mcp = await server.post("/mcp", {
      headers: {
        Authorization: `Bearer ${key.value}`,
        Accept: "application/json, text/event-stream",
      },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "fetch",
          arguments: { resource: "document", id: document.id },
        },
      },
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).not.toContain('"isError":true');
    const events = await Event.findAll({
      where: { name: "security.audit", actorId: user.id },
    });
    expect(
      events.some(
        (event) =>
          event.data?.channel === "mcp" && event.data?.documentCount === 1
      )
    ).toBe(true);
  });

  it("未知工具和 scope 不足的 MCP 调用都留下拒绝事件", async () => {
    const { user, key } = await fixture();
    for (const name of ["export_all", "delete_document"]) {
      const response = await server.post("/mcp", {
        headers: {
          Authorization: `Bearer ${key.value}`,
          Accept: "application/json, text/event-stream",
        },
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: {} },
        },
      });
      const body = await response.json();
      expect(body.error?.message ?? body.result?.content[0]?.text).toContain(
        "追踪编号"
      );
    }
    const events = await Event.findAll({
      where: { name: "security.audit", actorId: user.id },
    });
    expect(events.map((event) => event.data?.riskType)).toEqual(
      expect.arrayContaining(["unknown_tool", "credential_scope"])
    );
  });

  it("旧任务执行前重新检查已关闭的开关，不生成文件", async () => {
    const { user, document } = await fixture(UserRole.Viewer);
    const operation = await buildFileOperation({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
    });
    const task = new ExportMarkdownZipTask();
    const generate = vi.spyOn(task, "loadDataAndExport");
    await expect(
      task.perform({ fileOperationId: operation.id })
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    expect((await operation.reload()).state).toBe(FileOperationState.Error);
  });

  it("创建任务的 Key 已撤销时，任务执行拒绝，当前管理员仍可按自身权限下载", async () => {
    const { user, admin, key, document } = await fixture();
    const operation = await buildFileOperation({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
      options: {
        audit: { traceId: randomUUID(), credentialId: key.id, channel: "api" },
      },
    });
    await key.destroy();
    await expect(
      authorizeExportOperation(user.id, operation, true)
    ).rejects.toThrow();
    await expect(
      authorizeExportOperation(admin.id, operation)
    ).resolves.toBeDefined();
  });

  it("审计拒绝记录在业务事务回滚后仍存在", async () => {
    const { user } = await fixture();
    const traceId = randomUUID();
    await expect(
      sequelize.transaction(async () => {
        await recordAudit(
          { user, channel: "api", traceId },
          { operation: "test.rollback", result: "denied" },
          true
        );
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(
      await Event.count({
        where: { name: "security.audit", data: { traceId } },
      })
    ).toBe(1);
  });

  it("导出尝试审计不可用时返回 503 并不生成导出", async () => {
    const { user, document } = await fixture();
    vi.spyOn(Event, "create").mockRejectedValue(new Error("audit unavailable"));
    const generate = vi.spyOn(DocumentHelper, "toMarkdown");
    const response = await server.post("/api/documents.export", user, {
      body: { id: document.id },
    });
    expect(response.status).toBe(503);
    expect(generate).not.toHaveBeenCalled();
  });

  it("普通员工不能查询审计，管理员可按渠道与结果筛选", async () => {
    const { user, admin } = await fixture();
    await recordAudit(
      { user, channel: "mcp", traceId: randomUUID() },
      { operation: "fetch", result: "denied", riskType: "permission_denied" }
    );
    expect(
      (await server.post("/api/securityAudit.list", user, { body: {} })).status
    ).toBe(403);
    const response = await server.post("/api/securityAudit.list", admin, {
      body: { channel: "mcp", result: "denied" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].channel).toBe("mcp");
  });

  it("水印访问追踪复用，开关变化返回最新打印权限和策略", async () => {
    const { team, user, document } = await fixture(UserRole.Viewer, true);
    const first = await server.post("/api/securityAudit.context", user, {
      body: { documentId: document.id },
    });
    const firstBody = await first.json();
    expect(firstBody.data.canPrint).toBe(true);
    team.setPreference(TeamPreference.ViewersCanExport, false);
    await team.save();
    const next = await server.post("/api/securityAudit.context", user, {
      body: { documentId: document.id, accessTrace: firstBody.data.traceId },
    });
    const nextBody = await next.json();
    expect(nextBody.data.traceId).toBe(firstBody.data.traceId);
    expect(nextBody.data.canPrint).toBe(false);
    expect(nextBody.policies[0].abilities.download).toBe(false);
    expect(
      await Event.count({
        where: {
          name: "security.audit",
          actorId: user.id,
          data: { operation: "document.view" },
        },
      })
    ).toBe(1);
  });

  it("读取阈值跨 API/MCP 与不同凭据汇总，并在窗口内只标记一次", async () => {
    const { user } = await fixture();
    const traceId = randomUUID();
    const ids = Array.from({ length: readRiskConfig.documents }, () =>
      randomUUID()
    );
    await recordRead(
      { user, channel: "api", traceId, credentialId: randomUUID() },
      "documents.info",
      ids.slice(0, 25),
      100
    );
    await recordRead(
      { user, channel: "mcp", traceId, credentialId: randomUUID() },
      "fetch",
      ids.slice(25),
      100
    );
    await recordRead({ user, channel: "mcp", traceId }, "fetch", [ids[0]], 100);
    const events = await Event.findAll({
      where: {
        name: "security.audit",
        actorId: user.id,
        data: { riskType: "bulk_read" },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].data?.documentCount).toBe(readRiskConfig.documents);
    await RedisAdapter.defaultClient.flushall();
  });

  it("已导出的子文档移到私有集合后，历史下载不能绕过当前资源权限", async () => {
    const { user, admin, document, collection } = await fixture();
    const child = await buildDocument({
      teamId: user.teamId,
      userId: admin.id,
      collectionId: collection.id,
      parentDocumentId: document.id,
    });
    const operation = await buildFileOperation({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
      state: FileOperationState.Complete,
      options: { exportedDocumentIds: [document.id, child.id] },
    });
    await expect(
      authorizeExportOperation(user.id, operation)
    ).resolves.toBeDefined();
    const privateCollection = await buildCollection({
      teamId: user.teamId,
      userId: admin.id,
      permission: null,
    });
    await child.update({
      collectionId: privateCollection.id,
      parentDocumentId: null,
    });
    await expect(
      authorizeExportOperation(user.id, operation)
    ).rejects.toThrow();
  });

  it("禁止导出的 Viewer 仍可下载原有附件和导入结果，不产生导出事件", async () => {
    const { user, document, key } = await fixture(UserRole.Viewer);
    const attachment = await buildAttachment({
      userId: user.id,
      teamId: user.teamId,
      documentId: document.id,
    });
    const operation = await buildFileOperation({
      userId: user.id,
      teamId: user.teamId,
      type: FileOperationType.Import,
      state: FileOperationState.Complete,
    });
    for (const [path, id] of [
      ["attachments.redirect", attachment.id],
      ["fileOperations.redirect", operation.id],
    ]) {
      const response = await server.post(`/api/${path}`, {
        headers: { Authorization: `Bearer ${key.value}` },
        body: { id },
        redirect: "manual",
      });
      expect(response.status).toBe(302);
    }
    const events = await Event.findAll({
      where: { name: "security.audit", actorId: user.id },
    });
    expect(
      events.some(
        (event) =>
          event.data?.operation === "attachments.redirect" &&
          event.data?.result === "complete"
      )
    ).toBe(true);
    expect(events.some((event) => event.data?.result === "attempt")).toBe(
      false
    );
    expect(JSON.stringify(events.map((event) => event.data))).not.toContain(
      "https://"
    );
  });

  it("单篇正文返回超过字节阈值也标记风险，并不撤销阅读权限", async () => {
    const { user } = await fixture();
    await recordRead(
      { user, channel: "api", traceId: randomUUID() },
      "documents.info",
      [randomUUID()],
      readRiskConfig.bytes + 1
    );
    const events = await Event.findAll({
      where: {
        name: "security.audit",
        actorId: user.id,
        data: { riskType: "bulk_read" },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].data?.documentCount).toBe(1);
    expect(user.isSuspended).toBe(false);
  });

  it("滚动窗口排除已过期正文量，同篇文档读取不重复计数", async () => {
    const prefix = `security:test:${randomUUID()}`;
    const keys = ["docs", "requests", "bytes", "risk"].map(
      (suffix) => `${prefix}:${suffix}`
    );
    const run = (time: number, id: string, bytes: number) =>
      RedisAdapter.defaultClient.eval(
        readRiskScript,
        4,
        ...keys,
        time,
        1000,
        randomUUID(),
        bytes,
        50,
        100,
        id
      );
    const id = randomUUID();
    expect(await run(1000, id, 60)).toEqual([1, 60, 0]);
    expect(await run(1500, id, 30)).toEqual([1, 90, 0]);
    expect(await run(2001, id, 30)).toEqual([1, 60, 0]);
  });

  it("独立保留期清理仅移除超过 365 天的安全事件，保留业务事件与新审计", async () => {
    const { user } = await fixture();
    const oldDate = new Date(Date.now() - 400 * 86400000);
    const identity = { teamId: user.teamId, actorId: user.id, data: {} };
    const oldAudit = await Event.create(
      { ...identity, name: "security.audit", createdAt: oldDate },
      { hooks: false }
    );
    const business = await Event.create(
      { ...identity, name: "documents.update", createdAt: oldDate },
      { hooks: false }
    );
    const recent = await Event.create(
      { ...identity, name: "security.audit" },
      { hooks: false }
    );
    await new SecurityAuditRetentionTask().perform({
      limit: 100000,
      partition: { partitionIndex: 0, partitionCount: 1 },
    });
    expect(await Event.findByPk(oldAudit.id)).toBeNull();
    expect(await Event.findByPk(business.id)).not.toBeNull();
    expect(await Event.findByPk(recent.id)).not.toBeNull();
  });
});

describe("1.12.0 定制兼容", () => {
  it("差异工具必须同时具备修订列表和修订正文作用域", () => {
    expect(allowedTool("get_document_changes", ["/api/revisions.list"])).toBe(
      "credential_scope"
    );
    expect(allowedTool("get_document_changes", ["/api/revisions.info"])).toBe(
      "credential_scope"
    );
    expect(
      allowedTool("get_document_changes", [
        "/api/revisions.list",
        "/api/revisions.info",
      ])
    ).toBe("allowed");
  });

  it("SDK v2 上下文中的审计身份保留差异正文读取统计", async () => {
    const { user, document } = await fixture();
    const traceId = randomUUID();
    const diff = "+仅用于合成测试的历史正文";
    const identity = {
      user,
      traceId,
      channel: "mcp" as const,
      credentialId: randomUUID(),
    };
    const handler = withTracing(
      "get_document_changes",
      async (_input: { id: string }, _context: object) => ({
        content: [{ type: "text" as const, text: diff }],
      })
    );
    await handler(
      { id: document.id },
      { http: { authInfo: { extra: { user, auditIdentity: identity } } } }
    );
    const events = await Event.findAll({
      where: { name: "security.audit", data: { traceId } },
    });
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      channel: "mcp",
      credentialId: identity.credentialId,
      operation: "get_document_changes",
      documentCount: 1,
      returnedBytes: Buffer.byteLength(diff),
    });
    expect(JSON.stringify(events[0].data)).not.toContain(diff);
  });

  it("个人导出移动至普通集合后仍不能交给其他管理员下载", async () => {
    const { user, admin, team, document } = await fixture();
    const operation = await buildFileOperation({
      type: FileOperationType.Export,
      state: FileOperationState.Complete,
      teamId: team.id,
      userId: user.id,
      documentId: document.id,
      options: { personalOwnerId: user.id, exportedDocumentIds: [document.id] },
    });
    await expect(
      authorizeExportOperation(admin.id, operation)
    ).rejects.toThrow();
    await expect(
      authorizeExportOperation(user.id, operation)
    ).resolves.toBeDefined();
  });
});
