// @vitest-isolate true
import { generateKeyPairSync } from "node:crypto";
import JWT from "jsonwebtoken";
import env from "./env";
import { verifyDingTalkIdentity } from "./dingTalkIdentity";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const issuer = "https://identity.example.test";
const subject = "casdoor-immutable-user";
const unionId = "CorpUnionID-Complete.Value_12345678901234567890";
const original = {
  issuer: env.OIDC_DINGTALK_ISSUER,
  jwks: env.OIDC_DINGTALK_JWKS_URI,
  client: env.OIDC_CLIENT_ID,
};
const token = (claims = {}, options: JWT.SignOptions = {}) =>
  JWT.sign(
    { dingtalk: unionId, ...claims },
    privateKey.export({ type: "pkcs8", format: "pem" }),
    {
      algorithm: "RS256",
      issuer,
      audience: "outline-test",
      subject,
      expiresIn: "5m",
      keyid: "synthetic-key",
      ...options,
    }
  );

describe("可信钉钉身份声明", () => {
  beforeEach(() => {
    env.OIDC_DINGTALK_ISSUER = issuer;
    env.OIDC_DINGTALK_JWKS_URI = "https://keys.example.test/jwks";
    env.OIDC_CLIENT_ID = "outline-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            keys: [
              {
                ...publicKey.export({ format: "jwk" }),
                kid: "synthetic-key",
                alg: "RS256",
              },
            ],
          })
        )
      )
    );
  });
  afterEach(() => {
    env.OIDC_DINGTALK_ISSUER = original.issuer;
    env.OIDC_DINGTALK_JWKS_URI = original.jwks;
    env.OIDC_CLIENT_ID = original.client;
    vi.unstubAllGlobals();
  });
  it("完整保留标识，绑定不可变subject并记录核验来源", async () => {
    const identity = await verifyDingTalkIdentity(token(), subject);
    expect(identity?.dingTalk).toMatchObject({
      unionId,
      subject,
      issuer,
      source: "casdoor.dingtalk",
    });
    expect(identity?.dingTalk?.verifiedAt).toEqual(expect.any(String));
  });
  it("不从姓名、邮箱或phone字段猜测钉钉身份", async () => {
    await expect(
      verifyDingTalkIdentity(
        token({ dingtalk: undefined, phone: unionId }),
        subject
      )
    ).rejects.toThrow();
  });
  it("明确空绑定会清除旧身份", async () => {
    expect(
      await verifyDingTalkIdentity(token({ dingtalk: "" }), subject)
    ).toEqual({ dingTalk: null });
  });

  it("拒绝没有到期时间的身份令牌", async () => {
    const noExpiry = JWT.sign(
      { dingtalk: unionId },
      privateKey.export({ type: "pkcs8", format: "pem" }),
      {
        algorithm: "RS256",
        issuer,
        audience: "outline-test",
        subject,
        keyid: "synthetic-key",
      }
    );
    await expect(verifyDingTalkIdentity(noExpiry, subject)).rejects.toThrow();
  });
  it.each([
    ["wrong-issuer", { issuer: "https://other.example.test" }],
    ["wrong-audience", { audience: "other-app" }],
    ["expired", { expiresIn: -60 }],
  ])("拒绝%s", async (_name, options) => {
    await expect(
      verifyDingTalkIdentity(token({}, options), subject)
    ).rejects.toThrow();
  });
  it("拒绝其他用户、伪造签名、控制字符和过长标识", async () => {
    await expect(
      verifyDingTalkIdentity(token(), "other-user")
    ).rejects.toThrow();
    const parts = token().split(".");
    parts[1] = Buffer.from(
      JSON.stringify({ sub: subject, dingtalk: "forged" })
    ).toString("base64url");
    await expect(
      verifyDingTalkIdentity(parts.join("."), subject)
    ).rejects.toThrow();
    for (const value of ["a\nb", "x".repeat(101)]) {
      await expect(
        verifyDingTalkIdentity(token({ dingtalk: value }), subject)
      ).rejects.toThrow();
    }
  });
  it("未启用的其他OIDC部署保持原行为", async () => {
    env.OIDC_DINGTALK_ISSUER = undefined;
    env.OIDC_DINGTALK_JWKS_URI = undefined;
    expect(
      await verifyDingTalkIdentity("not-a-token", subject)
    ).toBeUndefined();
  });
  it("单边缺失配置拒绝身份更新", async () => {
    env.OIDC_DINGTALK_JWKS_URI = undefined;
    await expect(verifyDingTalkIdentity(token(), subject)).rejects.toThrow();
  });
});
