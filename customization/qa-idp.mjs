import http from "node:http";
import { randomBytes, createHmac } from "node:crypto";

const clientId = "outline-custom-qa";
const clientSecret = process.env.QA_CLIENT_SECRET;
if (!clientSecret) {
  throw new Error("QA_CLIENT_SECRET is required");
}
const redirectUri = "http://localhost:13810/auth/oidc.callback";
const identities = ["admin", "member", "viewer", "guest"];
const codes = new Map();
const tokens = new Map();

/** 测试身份提供器仅用于独立空白测试库，授权码单次使用且短时有效。 */
function profile(role) {
  return { sub: "qa-" + role, name: "QA " + role, preferred_username: role,
    email: "qa-" + role + "@outline-qa.example", email_verified: true, locale: "zh-CN" };
}

/** 返回 JSON 响应，避免将测试令牌写入访问日志。 */
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** 为测试 ID Token 签名，测试密钥只通过容器环境注入。 */
function idToken(role) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = enc({ alg: "HS256", typ: "JWT" }) + "." + enc({
    ...profile(role), iss: "http://localhost:13811", aud: clientId,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return body + "." + createHmac("sha256", clientSecret).update(body).digest("base64url");
}

/** 转义表单隐藏字段，授权端点仅接受预设的本机测试回调。 */
function escape(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:13811");
  if (url.pathname === "/authorize") {
    if (url.searchParams.get("client_id") !== clientId ||
        url.searchParams.get("redirect_uri") !== redirectUri) {
      return json(res, 400, { error: "invalid_client_or_redirect" });
    }
    const role = url.searchParams.get("identity");
    if (!identities.includes(role)) {
      const hidden = [...url.searchParams].filter(([key]) => key !== "identity")
        .map(([key, value]) => '<input type="hidden" name="' + escape(key) + '" value="' + escape(value) + '">').join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end('<!doctype html><title>Outline 隔离测试登录</title><h1>选择测试身份</h1><p>仅连接独立 QA 数据库</p><form action="/authorize" method="get">' + hidden +
        identities.map((item) => '<button name="identity" value="' + item + '">QA ' + item + '</button>').join(" ") + "</form>");
    }
    const code = randomBytes(24).toString("hex");
    codes.set(code, { role, expires: Date.now() + 180000 });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", url.searchParams.get("state") || "");
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) {
        return json(res, 413, { error: "too_large" });
      }
    }
    const values = new URLSearchParams(body);
    const basic = req.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":") : [];
    if ((values.get("client_id") || basic[0]) !== clientId ||
        (values.get("client_secret") || basic[1]) !== clientSecret) {
      return json(res, 401, { error: "invalid_client" });
    }
    const code = values.get("code");
    const grant = codes.get(code);
    codes.delete(code);
    if (!grant || grant.expires < Date.now() || values.get("redirect_uri") !== redirectUri) {
      return json(res, 400, { error: "invalid_grant" });
    }
    const token = randomBytes(32).toString("hex");
    tokens.set(token, { role: grant.role, expires: Date.now() + 3600000 });
    return json(res, 200, { access_token: token, token_type: "Bearer",
      expires_in: 3600, scope: "openid profile email", id_token: idToken(grant.role) });
  }
  if (url.pathname === "/userinfo") {
    const grant = tokens.get(req.headers.authorization?.replace(/^Bearer /i, ""));
    return grant && grant.expires > Date.now()
      ? json(res, 200, profile(grant.role))
      : json(res, 401, { error: "invalid_token" });
  }
  return json(res, 404, { error: "not_found" });
}).listen(8000, "0.0.0.0");
