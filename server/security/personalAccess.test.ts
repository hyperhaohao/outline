// @vitest-isolate true
import { randomUUID } from "node:crypto";
import { auditToolResult } from "./mcpAudit";
import { UserRole, TeamPreference, CollectionPermission } from "@shared/types";
import { Collection, Document, Event } from "@server/models";
import { serialize } from "@server/policies";
import {
  buildTeam,
  buildUser,
  buildAdmin,
  buildPersonalCollection,
  buildDocument,
  buildAttachment,
  buildCollection,
  buildApiKey,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();
vi.mock("@server/storage/files");

/** 创建隔离工作区及真实个人文档，避免管理员测试被普通集合授权干扰。 */
async function personalFixture() {
  const team = await buildTeam();
  team.setPreference(TeamPreference.PersonalDocs, true);
  team.setPreference(TeamPreference.MCP, true);
  await team.save();
  const owner = await buildUser({ teamId: team.id, role: UserRole.Viewer });
  const admin = await buildAdmin({ teamId: team.id });
  const other = await buildUser({ teamId: team.id, role: UserRole.Viewer });
  const collection = await buildPersonalCollection(owner);
  const document = await buildDocument({
    teamId: team.id,
    userId: owner.id,
    collectionId: collection.id,
  });
  return { team, owner, admin, other, collection, document };
}

describe("瑞玛个人区域", () => {
  for (const role of [
    UserRole.Viewer,
    UserRole.Member,
    UserRole.Admin,
    UserRole.Guest,
  ]) {
    it(`${role} 仅按个人规则创建，不改变公共集合权限`, async () => {
      const { team } = await personalFixture();
      const user = await buildUser({ teamId: team.id, role });
      const response = await server.post("/api/documents.create", user, {
        body: {
          collectionId: "personal",
          title: "个人草稿",
          text: "合成内容",
          publish: true,
        },
      });
      expect(response.status).toBe(role === UserRole.Guest ? 403 : 200);
      if (role !== UserRole.Guest) {
        const body = await response.json();
        const collection = await Collection.findByPk(body.data.collectionId);
        expect(collection?.ownerId).toBe(user.id);
      }
      if (role === UserRole.Viewer) {
        const shared = await buildCollection({
          teamId: team.id,
          permission: CollectionPermission.Read,
        });
        const denied = await server.post("/api/documents.create", user, {
          body: {
            collectionId: shared.id,
            title: "拒绝公共写入",
            publish: true,
          },
        });
        expect(denied.status).toBe(403);
      }
    });
  }

  it("拒绝伪造所有者，首次并发创建只生成一个集合", async () => {
    const { team, other } = await personalFixture();
    const user = await buildUser({ teamId: team.id, role: UserRole.Viewer });
    const forged = await server.post("/api/documents.create", user, {
      body: { collectionId: "personal", ownerId: other.id, title: "不得代建" },
    });
    expect(forged.status).toBe(400);
    const results = await Promise.all(
      [1, 2].map((n) =>
        server.post("/api/documents.create", user, {
          body: { collectionId: "personal", title: `并发 ${n}`, publish: true },
        })
      )
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await Collection.count({ where: { teamId: team.id, ownerId: user.id } })
    ).toBe(1);
  });

  it("管理员仅可读，普通同事不得读取或签名个人附件", async () => {
    const { owner, admin, other, document } = await personalFixture();
    for (const user of [owner, admin, other]) {
      const response = await server.post("/api/documents.info", user, {
        body: { id: document.id },
      });
      expect(response.status).toBe(user === other ? 403 : 200);
    }
    const reloaded = await Document.findByPk(document.id, { userId: admin.id });
    const policy = serialize(admin, reloaded);
    expect(policy.read).toBeTruthy();
    for (const ability of [
      "update",
      "delete",
      "move",
      "archive",
      "manageUsers",
      "share",
      "download",
      "duplicate",
      "comment",
    ]) {
      expect(policy[ability]).toBeFalsy();
    }
    const attachment = await buildAttachment({
      teamId: owner.teamId,
      userId: owner.id,
      documentId: document.id,
    });
    for (const user of [owner, admin, other]) {
      const response = await server.get(
        `/api/attachments.redirect?id=${attachment.id}`,
        user,
        { redirect: "manual" }
      );
      expect(response.status).toBe(user === other ? 403 : 302);
    }
    const audit = await Event.findAll({
      where: { name: "security.audit", actorId: admin.id },
    });
    expect(
      audit.some((e) => e.data?.personalOwnerIds?.includes(owner.id))
    ).toBe(true);
  });

  it("管理员可列出和搜索个人区域，降级与写入查询不复用监管权限", async () => {
    const { admin, other, owner, collection, document } =
      await personalFixture();
    expect(await admin.collectionIds()).toContain(collection.id);
    expect(await admin.collectionIds({ writableOnly: true })).not.toContain(
      collection.id
    );
    const response = await server.post("/api/collections.list", admin, {
      body: {
        filters: [{ field: "ownerId", operator: "eq", value: owner.id }],
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((c: Collection) => c.id)).toContain(
      collection.id
    );
    const denied = await server.post("/api/collections.list", other, {
      body: {
        filters: [{ field: "ownerId", operator: "eq", value: owner.id }],
      },
    });
    expect((await denied.json()).data).toEqual([]);
    const info = await server.post("/api/documents.info", admin, {
      body: { id: document.id },
    });
    expect((await info.json()).data.personalOwnerName).toBe(owner.name);
    admin.role = UserRole.Viewer;
    expect(await admin.collectionIds()).not.toContain(collection.id);
  });

  it("只读 Key 不因个人入口开放而获得写入作用域", async () => {
    const { owner } = await personalFixture();
    const key = await buildApiKey({ userId: owner.id, scope: ["read"] });
    const response = await server.post("/api/documents.create", {
      headers: { Authorization: `Bearer ${key.value}` },
      body: { collectionId: "personal", title: "拒绝 scope 扩张" },
    });
    expect(response.status).toBe(403);
  });
  it("管理员以短链接读取历史差异时仍按真实文档及所有者审计", async () => {
    const { admin, owner, document } = await personalFixture();
    await auditToolResult(
      { user: admin, channel: "mcp", traceId: randomUUID() },
      "get_document_changes",
      { id: document.urlId },
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ document: { id: document.id } }),
          },
          { type: "text", text: "仅合成差异" },
        ],
      }
    );
    const events = await Event.findAll({
      where: { name: "security.audit", actorId: admin.id },
    });
    expect(
      events.some(
        (e) =>
          e.data?.personalOwnerIds?.includes(owner.id) &&
          e.data?.targetIds?.includes(document.id)
      )
    ).toBe(true);
  });
});
