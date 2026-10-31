// @vitest-isolate true
import {
  AuthenticationProvider,
  UserAuthentication,
  Event,
} from "@server/models";
import {
  buildTeam,
  buildUser,
  buildDocument,
  buildCollection,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { getDingTalkIdentity } from "./dingTalkIdentity";

const server = getTestServer();
const unionId = "CorpUnion-Synthetic-Complete_1234567890";

/** 构造独立OIDC关联，测试不用任何生产身份或真实钉钉标识。 */
async function fixture() {
  const team = await buildTeam({
    authenticationProviders: [
      { name: "oidc", providerId: "synthetic-casdoor" },
    ],
  });
  const user = await buildUser({ teamId: team.id });
  const provider = await AuthenticationProvider.findOne({
    where: { teamId: team.id },
    rejectOnEmpty: true,
  });
  const identity = {
    unionId,
    subject: "immutable-casdoor-subject",
    issuer: "https://identity.example.test",
    source: "casdoor.dingtalk" as const,
    verifiedAt: new Date().toISOString(),
  };
  const authentication = await UserAuthentication.create({
    userId: user.id,
    authenticationProviderId: provider.id,
    providerId: identity.subject,
    scopes: [],
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
    identityMetadata: { dingTalk: identity },
  });
  const collection = await buildCollection({
    userId: user.id,
    teamId: team.id,
  });
  const document = await buildDocument({
    userId: user.id,
    teamId: team.id,
    collectionId: collection.id,
  });
  return { user, provider, authentication, document, identity };
}

describe("钉钉水印与身份审计", () => {
  it("只返回当前用户的完整绑定，客户端字段不能伪造身份", async () => {
    const { user, document, identity } = await fixture();
    const response = await server.post("/api/securityAudit.context", user, {
      body: { documentId: document.id, dingTalkUnionId: "forged" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      userId: user.id,
      dingTalkUnionId: unionId,
    });
    const event = await Event.findOne({
      where: { actorId: user.id, name: "security.audit" },
      rejectOnEmpty: true,
    });
    expect(event.data?.dingTalkIdentity).toEqual(identity);
  });
  it("缺失绑定、subject不符或提供方停用时不显示", async () => {
    const { user, provider, authentication } = await fixture();
    await authentication.update({ providerId: "different-subject" });
    expect(await getDingTalkIdentity(user)).toBeUndefined();
    await authentication.update({ providerId: "immutable-casdoor-subject" });
    await provider.update({ enabled: false });
    expect(await getDingTalkIdentity(user)).toBeUndefined();
    await provider.update({ enabled: true });
    await authentication.update({ identityMetadata: { dingTalk: null } });
    expect(await getDingTalkIdentity(user)).toBeUndefined();
  });
  it("绑定变化签发新的访问追踪号，旧审计快照不被修改", async () => {
    const { user, document, authentication, identity } = await fixture();
    const first = await server.post("/api/securityAudit.context", user, {
      body: { documentId: document.id },
    });
    const before = await first.json();
    await authentication.update({
      identityMetadata: {
        dingTalk: { ...identity, unionId: "new-synthetic-union-id" },
      },
    });
    const next = await server.post("/api/securityAudit.context", user, {
      body: { documentId: document.id, accessTrace: before.data.traceId },
    });
    const after = await next.json();
    expect(after.data.traceId).not.toBe(before.data.traceId);
    const previous = await Event.findOne({
      where: { actorId: user.id, data: { traceId: before.data.traceId } },
      rejectOnEmpty: true,
    });
    expect(previous.data?.dingTalkIdentity.unionId).toBe(unionId);
  });
  it("打印审计保留实际访问者身份，不在普通用户资料中公开元数据", async () => {
    const { user, document } = await fixture();
    const response = await server.post("/api/securityAudit.print", user, {
      body: { documentId: document.id, result: "allowed" },
    });
    expect(response.status).toBe(200);
    const event = await Event.findOne({
      where: { actorId: user.id, data: { operation: "browser.print" } },
      rejectOnEmpty: true,
    });
    expect(event.data?.dingTalkIdentity.unionId).toBe(unionId);
    const profile = await server.post("/api/users.info", user, {
      body: { id: user.id },
    });
    expect(JSON.stringify(await profile.json())).not.toContain(unionId);
  });
});
