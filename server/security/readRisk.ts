import { Op } from "sequelize";
import { Document, Collection } from "@server/models";
import { randomUUID } from "node:crypto";
import RedisAdapter from "@server/storage/redis";
import Logger from "@server/logging/Logger";
import { recordAudit, type AuditIdentity } from "./audit";

/** 集中设置读取风险阈值；统计采用滚动窗口并以用户而非 Key 为单位。 */
export const readRiskConfig = {
  windowMs: positiveSetting(process.env.SECURITY_READ_WINDOW_MS, 300000),
  documents: positiveSetting(process.env.SECURITY_READ_DOCUMENTS, 50),
  bytes: positiveSetting(process.env.SECURITY_READ_BYTES, 10 * 1024 * 1024),
};

/** 非法配置使用默认值，避免负数或非有限数字使 Redis 风险统计失效。 */
function positiveSetting(value: string | undefined, fallback: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/** Redis Lua 在一次原子操作中维护文档最近访问、返回量与风险去重。 */
export const readRiskScript = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', cutoff)
for _, item in ipairs(expired) do redis.call('HDEL', KEYS[3], item) end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
for i = 7, #ARGV do redis.call('ZADD', KEYS[1], now, ARGV[i]) end
redis.call('ZADD', KEYS[2], now, ARGV[3])
redis.call('HSET', KEYS[3], ARGV[3], ARGV[4])
local bytes = 0
for _, value in ipairs(redis.call('HVALS', KEYS[3])) do bytes = bytes + tonumber(value) end
local count = redis.call('ZCARD', KEYS[1])
for i = 1, 3 do redis.call('PEXPIRE', KEYS[i], window) end
local risk = count >= tonumber(ARGV[5]) or bytes > tonumber(ARGV[6])
local flag = 0
if risk and redis.call('SET', KEYS[4], '1', 'PX', window, 'NX') then flag = 1 end
return {count, bytes, flag}
`;

/** 记录已返回正文的风险，失败只报告服务异常，不影响原有读取权限。 */
export async function recordRead(
  identity: AuditIdentity,
  operation: string,
  ids: string[],
  bytes: number
) {
  const targetIds = [...new Set(ids)];
  const personalDocuments =
    identity.user.isAdmin && targetIds.length
      ? await Document.scope("withDrafts").findAll({
          attributes: ["id"],
          paranoid: false,
          where: {
            id: targetIds.filter((id) =>
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                id
              )
            ),
            teamId: identity.user.teamId,
          },
          include: [
            {
              model: Collection,
              as: "collection",
              attributes: ["ownerId"],
              paranoid: false,
              where: {
                teamId: identity.user.teamId,
                ownerId: { [Op.ne]: null, [Op.not]: identity.user.id },
              },
            },
          ],
        })
      : [];
  const personalOwnerIds = [
    ...new Set(
      personalDocuments
        .map((d) => d.collection?.ownerId)
        .filter((id): id is string => !!id)
    ),
  ];
  const saved = await recordAudit(
    identity,
    {
      operation,
      result: "complete",
      targetIds,
      documentCount: targetIds.length,
      returnedBytes: bytes,
      personalOwnerIds,
    },
    personalOwnerIds.length > 0
  );
  if (!saved || (!bytes && !targetIds.length)) {
    return;
  }
  try {
    const prefix = `security:read:{${identity.user.teamId}:${identity.user.id}}`;
    const result = (await RedisAdapter.defaultClient.eval(
      readRiskScript,
      4,
      `${prefix}:docs`,
      `${prefix}:requests`,
      `${prefix}:bytes`,
      `${prefix}:risk`,
      Date.now(),
      readRiskConfig.windowMs,
      randomUUID(),
      bytes,
      readRiskConfig.documents,
      readRiskConfig.bytes,
      ...targetIds
    )) as number[];
    if (result[2]) {
      await recordAudit(identity, {
        operation,
        result: "allowed",
        riskType: "bulk_read",
        documentCount: result[0],
        returnedBytes: result[1],
      });
    }
  } catch (error) {
    Logger.error(
      "读取风险统计失败",
      error instanceof Error ? error : new Error("Redis failed"),
      { traceId: identity.traceId }
    );
  }
}

/** 从内存中的响应统计正文量，返回值不包含正文、URL 或请求内容。 */
export function measureBodies(value: unknown): {
  ids: string[];
  bytes: number;
} {
  const ids = new Set<string>();
  let bytes = 0;
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (
        typeof record.id === "string" &&
        (typeof record.text === "string" ||
          (record.data && typeof record.data === "object"))
      ) {
        ids.add(
          typeof record.documentId === "string" ? record.documentId : record.id
        );
        bytes += Buffer.byteLength(
          typeof record.text === "string"
            ? record.text
            : JSON.stringify(record.data)
        );
        return;
      }
      Object.values(record).forEach(visit);
    }
  };
  visit(value);
  return { ids: [...ids], bytes };
}
