/** 维护窗口工具：只读清单为默认动作；删除与恢复必须提供精确清单和真实管理员身份。 */
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { parseArgs } = require("node:util");
require("../build/server/scripts/bootstrap.js");
const { Collection, User } = require("../build/server/models");
const { sequelize } = require("../build/server/storage/database");
const { createContext } = require("../build/server/context");
const { taskQueue } = require("../build/server/queues");
const { inspectLegacyPersonalSpace, removeEmptyLegacyPersonalSpace, restoreEmptyLegacyPersonalSpace } = require("../build/server/commands/legacyPersonalSpaceCleaner");

/** 扫描队列中的集合引用，不输出任务内容；队列不可读时保守保留所有集合。 */
async function pendingReferences(ids) {
  const queue = taskQueue();
  try {
    const jobs = await queue.getJobs(["waiting", "active", "delayed", "paused"]);
    const references = [];
    for (const job of jobs) {
      const data = JSON.stringify(job.data);
      references.push(...ids.filter(id => data.includes(id)));
    }
    return references;
  } catch {
    return undefined;
  } finally {
    await queue.close();
  }
}

/** 仅将本轮确认的集合逐项变更；事务中再次验证，任何不符合项使整轮回滚。 */
async function main() {
  const { values } = parseArgs({ options: {
    action: { type: "string", default: "inspect" },
    "actor-id": { type: "string" },
    "team-id": { type: "string" },
    manifest: { type: "string" },
    "maintenance-confirmed": { type: "boolean", default: false },
  } });
  assert(["inspect", "apply", "restore"].includes(values.action));
  if (values.action === "inspect") {
    assert(values["team-id"], "An explicit team is required");
    const collections = await Collection.findAll({ where: { teamId: values["team-id"], ownerId: null } });
    const legacy = collections.filter(c => c.name.startsWith("个人空间｜"));
    const pending = await pendingReferences(legacy.map(c => c.id));
    const rows = [];
    for (const collection of legacy) { rows.push(await inspectLegacyPersonalSpace(collection, pending)); }
    console.log(JSON.stringify({ mode: "inspect", checkedAt: new Date().toISOString(), queueVerified: pending !== undefined, collections: rows }));
  } else {
    assert(values["maintenance-confirmed"], "Stop application writes before modifying legacy collections");
    assert(values.manifest && values["actor-id"], "Exact reviewed manifest and maintenance actor are required");
    const manifest = JSON.parse(fs.readFileSync(values.manifest, "utf8"));
    assert(manifest.queueVerified && Array.isArray(manifest.collections));
    if (values.action === "restore") { assert(manifest.mode === "apply", "Restore requires the actual deletion receipt"); }
    const actor = await User.findByPk(values["actor-id"]);
    assert(actor?.isAdmin && !actor.isSuspended, "An active workspace administrator is required");
    const selected = manifest.collections.filter(c => c.eligible);
    assert(selected.every(c => c.teamId === actor.teamId && c.counts.documents === 0));
    const pending = await pendingReferences(selected.map(c => c.id));
    assert(pending !== undefined, "Queue state could not be verified");
    const changed = await sequelize.transaction(async transaction => {
      const ctx = createContext({ user: actor, transaction });
      const result = [];
      for (const row of selected) {
        const collection = values.action === "restore"
          ? await restoreEmptyLegacyPersonalSpace(ctx, row, row.cleanupDeletedAt)
          : await removeEmptyLegacyPersonalSpace(ctx, row.id, pending);
        result.push({ ...row, cleanupDeletedAt: collection.deletedAt ? new Date(collection.deletedAt).toISOString() : null });
      }
      return result;
    });
    console.log(JSON.stringify({ mode: values.action, completedAt: new Date().toISOString(), actorId: actor.id, queueVerified: true, collections: changed }));
  }
  await sequelize.close();
  process.exit(0);
}
main().catch(error => { console.error(JSON.stringify({ status: "failed", errorType: error.name, message: error.message })); process.exit(1); });
