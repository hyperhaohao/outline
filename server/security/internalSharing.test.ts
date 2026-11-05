import { CollectionPermission, UserRole } from "@shared/types";
import { Share, UserMembership } from "@server/models";
import {
  buildAdmin,
  buildCollection,
  buildDocument,
  buildPersonalCollection,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();

/** 测试身份与文档完全合成，不使用生产人员或资料。 */
async function fixture() {
  const team = await buildTeam({ sharing: true });
  const owner = await buildUser({ teamId: team.id, role: UserRole.Viewer });
  const employee = await buildUser({ teamId: team.id, role: UserRole.Member });
  const admin = await buildAdmin({ teamId: team.id });
  const personal = await buildPersonalCollection(owner, { sharing: true });
  const document = await buildDocument({
    userId: owner.id,
    teamId: team.id,
    collectionId: personal.id,
  });
  return { team, owner, employee, admin, personal, document };
}

describe("登录内部分享的资源边界", () => {
  it("Viewer可分享本人文档，分享标记不会被旧匿名加载器读取", async () => {
    const { owner, document } = await fixture();
    const response = await server.post("/api/shares.create", owner, {
      body: { documentId: document.id, audience: "workspace", enabled: true },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      audience: "workspace",
      enabled: true,
      published: false,
      includeChildDocuments: false,
    });
    const saved = await Share.findByPk(body.data.id, { rejectOnEmpty: true });
    expect(saved.published).toBe(false);
  });
  it("仅有效员工凭链接可读，直接文档读取权没有被扩大", async () => {
    const { owner, employee, document } = await fixture();
    const created = await server.post("/api/shares.create", owner, {
      body: { documentId: document.id, enabled: true },
    });
    const { data } = await created.json();
    const anonymous = await server.post("/api/shares.info", {
      body: { id: data.id },
    });
    expect(anonymous.status).toBe(401);
    const shared = await server.post("/api/documents.info", employee, {
      body: { id: document.id, shareId: data.id },
    });
    expect(shared.status).toBe(200);
    const direct = await server.post("/api/documents.info", employee, {
      body: { id: document.id },
    });
    expect(direct.status).toBe(403);
    const foreign = await buildUser();
    expect(
      (
        await server.post("/api/shares.info", foreign, {
          body: { id: data.id },
        })
      ).status
    ).not.toBe(200);
    const guest = await buildUser({
      teamId: employee.teamId,
      role: UserRole.Guest,
    });
    expect(
      (await server.post("/api/shares.info", guest, { body: { id: data.id } }))
        .status
    ).not.toBe(200);
  });
  it("关闭、撤销和创建者停用会停止服务端读取", async () => {
    const { owner, employee, document } = await fixture();
    const created = await server.post("/api/shares.create", owner, {
      body: { documentId: document.id, enabled: true },
    });
    const { data } = await created.json();
    expect(
      (
        await server.post("/api/shares.update", owner, {
          body: { id: data.id, enabled: false },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await server.post("/api/shares.info", employee, {
          body: { id: data.id },
        })
      ).status
    ).toBe(404);
    await server.post("/api/shares.update", owner, {
      body: { id: data.id, enabled: true },
    });
    await owner.update({ suspendedAt: new Date() });
    expect(
      (
        await server.post("/api/shares.info", employee, {
          body: { id: data.id },
        })
      ).status
    ).not.toBe(200);
  });
  it("拒绝整个个人区域、监管管理员代分享、匿名发布和带下级越界", async () => {
    const { owner, admin, document, personal, team } = await fixture();
    expect(
      (
        await server.post("/api/shares.create", owner, {
          body: { collectionId: personal.id, enabled: true },
        })
      ).status
    ).not.toBe(200);
    expect(
      (
        await server.post("/api/shares.create", admin, {
          body: { documentId: document.id, enabled: true },
        })
      ).status
    ).not.toBe(200);
    expect(
      (
        await server.post("/api/shares.create", owner, {
          body: { documentId: document.id, published: true },
        })
      ).status
    ).toBe(400);
    const child = await buildDocument({
      userId: owner.id,
      teamId: team.id,
      collectionId: personal.id,
      parentDocumentId: document.id,
    });
    const created = await server.post("/api/shares.create", owner, {
      body: {
        documentId: document.id,
        enabled: true,
        includeChildDocuments: true,
      },
    });
    const { data } = await created.json();
    expect(data.includeChildDocuments).toBe(false);
    expect(
      (
        await server.post("/api/documents.info", owner, {
          body: { id: child.id, shareId: data.id },
        })
      ).status
    ).not.toBe(200);
  });
  it("集合Viewer管理员可分享，普通公共读者不能转授权", async () => {
    const { owner, employee, team } = await fixture();
    const collection = await buildCollection({
      userId: employee.id,
      teamId: team.id,
      sharing: true,
    });
    await UserMembership.create({
      collectionId: collection.id,
      userId: owner.id,
      permission: CollectionPermission.Admin,
      createdById: employee.id,
    });
    expect(
      (
        await server.post("/api/shares.create", owner, {
          body: { collectionId: collection.id, enabled: true },
        })
      ).status
    ).toBe(200);
    const ordinaryReader = await buildUser({ teamId: team.id });
    expect(
      (
        await server.post("/api/shares.create", ordinaryReader, {
          body: { collectionId: collection.id, enabled: true },
        })
      ).status
    ).not.toBe(200);
  });
});
