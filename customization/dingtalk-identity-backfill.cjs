/* 受控身份回填：只接受运维从Casdoor不可变ID取得的绑定，默认预览；不打印真实标识。 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Client } = require("pg");

/** 在单个事务内重新核对目标关联，原字段保持不变，任何歧义均排除。 */
async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const apply = process.argv.includes("--apply");
  if (!Array.isArray(input.bindings) || typeof input.issuer !== "string") {
    throw new Error("INVALID_BACKFILL_INPUT");
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      'SELECT ua.id, ua."userId", ua."providerId", ua."authenticationProviderId", ua."identityMetadata", u."teamId" FROM user_authentications ua JOIN users u ON u.id=ua."userId" JOIN authentication_providers ap ON ap.id=ua."authenticationProviderId" WHERE ap.name=$1 AND ap.enabled=true AND u."deletedAt" IS NULL FOR UPDATE OF ua',
      ["oidc"]
    );
    const counts = {
      mode: apply ? "apply" : "preview",
      matched: 0,
      unbound: 0,
      missing: 0,
      conflicts: 0,
      changed: 0,
    };
    const planned = [];
    for (const row of rows) {
      const matches = input.bindings.filter(
        (binding) => binding.subject === row.providerId
      );
      if (!matches.length) {
        counts.missing++;
        continue;
      }
      if (matches.length !== 1) {
        counts.conflicts++;
        continue;
      }
      const binding = matches[0];
      if (!binding.unionId) {
        counts.unbound++;
        continue;
      }
      if (
        typeof binding.unionId !== "string" ||
        !/^[!-~]{1,100}$/.test(binding.unionId) ||
        input.bindings.filter((other) => other.unionId === binding.unionId)
          .length !== 1
      ) {
        counts.conflicts++;
        continue;
      }
      counts.matched++;
      const identity = {
        unionId: binding.unionId,
        subject: binding.subject,
        issuer: input.issuer,
        source: "casdoor.dingtalk",
        verifiedAt: input.verifiedAt,
      };
      if (
        row.identityMetadata?.dingTalk &&
        (row.identityMetadata.dingTalk.unionId !== identity.unionId ||
          row.identityMetadata.dingTalk.subject !== identity.subject)
      ) {
        counts.conflicts++;
        continue;
      }
      planned.push({
        id: row.id,
        providerId: row.providerId,
        identityMetadata: {
          ...(row.identityMetadata || {}),
          dingTalk: identity,
        },
      });
    }
    const sourceDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(input.bindings))
      .digest("hex");
    if (apply && input.expectedSourceDigest !== sourceDigest) {
      throw new Error("SOURCE_SNAPSHOT_CHANGED");
    }
    for (const row of planned) {
      if (apply) {
        const result = await client.query(
          'UPDATE user_authentications SET "identityMetadata"=$1 WHERE id=$2 AND "providerId"=$3',
          [row.identityMetadata, row.id, row.providerId]
        );
        if (result.rowCount !== 1) {
          throw new Error("AUTHENTICATION_CHANGED");
        }
      }
    }
    counts.changed = apply ? planned.length : 0;
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    console.log(
      JSON.stringify({ ...counts, planned: planned.length, sourceDigest })
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
main().catch(() => {
  console.error(
    "DINGTALK_BACKFILL_FAILED: 未输出身份或凭据，请在受控环境核对输入与授权。"
  );
  process.exitCode = 1;
});
