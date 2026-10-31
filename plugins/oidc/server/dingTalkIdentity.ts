import { createPublicKey } from "node:crypto";
import JWT from "jsonwebtoken";
import { z } from "zod";
import { AuthenticationError } from "@server/errors";
import {
  dingTalkIdentitySchema,
  type DingTalkIdentity,
} from "@server/security/dingTalkIdentity";
import env from "./env";

const keysSchema = z.object({
  keys: z.array(
    z.object({
      kty: z.literal("RSA"),
      kid: z.string().optional(),
      n: z.string(),
      e: z.string(),
      use: z.string().optional(),
      alg: z.string().optional(),
    })
  ),
});
let cachedKeys:
  | { url: string; expires: number; keys: z.infer<typeof keysSchema>["keys"] }
  | undefined;

/** 从显式配置的地址读取公钥，不接受令牌自带的jku或客户端身份字段。 */
async function signingKey(kid: string | undefined) {
  const url = env.OIDC_DINGTALK_JWKS_URI!;
  if (
    !cachedKeys ||
    cachedKeys.url !== url ||
    cachedKeys.expires < Date.now()
  ) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) {
      throw AuthenticationError("身份验签公钥不可用");
    }
    const parsed = keysSchema.parse(await response.json());
    cachedKeys = { url, keys: parsed.keys, expires: Date.now() + 300000 };
  }
  const candidates = cachedKeys.keys.filter(
    (key) =>
      (!kid || key.kid === kid) &&
      (!key.use || key.use === "sig") &&
      (!key.alg || key.alg === "RS256")
  );
  if (candidates.length !== 1) {
    cachedKeys = undefined;
    throw AuthenticationError("身份验签公钥不唯一或已变更，请重新登录");
  }
  return createPublicKey({ key: candidates[0], format: "jwk" }).export({
    type: "spki",
    format: "pem",
  });
}

/** 只从验签及issuer、audience、subject校验通过的应用令牌读取钉钉绑定。 */
export async function verifyDingTalkIdentity(
  idToken: string,
  subject: string
): Promise<{ dingTalk: DingTalkIdentity | null } | undefined> {
  if (!env.OIDC_DINGTALK_ISSUER && !env.OIDC_DINGTALK_JWKS_URI) {
    return undefined;
  }
  if (!env.OIDC_DINGTALK_ISSUER || !env.OIDC_DINGTALK_JWKS_URI) {
    throw AuthenticationError("钉钉身份配置不完整");
  }
  const header = JWT.decode(idToken, { complete: true })?.header;
  if (!header || header.alg !== "RS256") {
    throw AuthenticationError("身份令牌签名算法不受支持");
  }
  const payload = JWT.verify(idToken, await signingKey(header.kid), {
    algorithms: ["RS256"],
    issuer: env.OIDC_DINGTALK_ISSUER,
    audience: env.OIDC_CLIENT_ID,
    maxAge: "10m",
    clockTolerance: 30,
  });
  if (
    typeof payload === "string" ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.sub !== subject ||
    typeof payload.dingtalk !== "string"
  ) {
    throw AuthenticationError("钉钉身份声明缺失或账号不一致");
  }
  if (!payload.dingtalk) {
    return { dingTalk: null };
  }
  const verified = dingTalkIdentitySchema.safeParse({
    unionId: payload.dingtalk,
    subject,
    issuer: env.OIDC_DINGTALK_ISSUER,
    source: "casdoor.dingtalk",
    verifiedAt: new Date().toISOString(),
  });
  if (!verified.success) {
    throw AuthenticationError("钉钉身份标识格式无效");
  }
  return { dingTalk: verified.data };
}
