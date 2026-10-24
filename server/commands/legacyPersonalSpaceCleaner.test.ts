import {
  buildTeam,
  buildAdmin,
  buildUser,
  buildCollection,
  buildPersonalCollection,
  buildDocument,
  buildFileOperation,
} from "@server/test/factories";
import { Collection, UserMembership } from "@server/models";
import { withAPIContext } from "@server/test/support";
import { FileOperationState } from "@shared/types";
import {
  inspectLegacyPersonalSpace,
  removeEmptyLegacyPersonalSpace,
  restoreEmptyLegacyPersonalSpace,
} from "./legacyPersonalSpaceCleaner";

describe("旧空个人空间清理", () => {
  it("空集合软删除后恢复，原授权仍在；重复或状态不明的清理拒绝", async () => {
    const team = await buildTeam();
    const admin = await buildAdmin({ teamId: team.id });
    await buildCollection({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      name: "个人空间｜合成员工",
      userId: admin.id,
    });
    const before = await inspectLegacyPersonalSpace(collection, []);
    expect(before.eligible).toBe(true);
    expect(
      (await inspectLegacyPersonalSpace(collection, undefined)).eligible
    ).toBe(false);
    const deleted = await withAPIContext(admin, (ctx) =>
      removeEmptyLegacyPersonalSpace(ctx, collection.id, [])
    );
    expect(deleted.id).toBe(collection.id);
    expect(await Collection.findByPk(collection.id)).toBeNull();
    await withAPIContext(admin, (ctx) =>
      restoreEmptyLegacyPersonalSpace(
        ctx,
        before,
        new Date(deleted.deletedAt!).toISOString()
      )
    );
    expect(await Collection.findByPk(collection.id)).toBeTruthy();
    expect(
      await UserMembership.count({ where: { collectionId: collection.id } })
    ).toBe(before.userMemberships.length);
  });
  for (const state of ["published", "draft", "archived", "deleted"]) {
    it(`包含 ${state} 文档的集合不会因页面目录为空而被删除`, async () => {
      const collection = await buildCollection({ name: "个人空间｜有资料" });
      const document = await buildDocument({
        teamId: collection.teamId,
        collectionId: collection.id,
        ...(state === "draft" ? { publishedAt: null } : {}),
        ...(state === "archived" ? { archivedAt: new Date() } : {}),
      });
      if (state === "deleted") {
        await document.destroy({ hooks: false });
      }
      const inspection = await inspectLegacyPersonalSpace(collection, []);
      expect(inspection.eligible).toBe(false);
      expect(inspection.counts.documents).toBe(1);
    });
  }
  it("新版个人集合和未完成任务保持原位", async () => {
    const user = await buildUser();
    const personal = await buildPersonalCollection(user);
    expect((await inspectLegacyPersonalSpace(personal, [])).eligible).toBe(
      false
    );
    const legacy = await buildCollection({
      teamId: user.teamId,
      name: "个人空间｜任务中",
    });
    await buildFileOperation({
      teamId: user.teamId,
      userId: user.id,
      collectionId: legacy.id,
      state: FileOperationState.Creating,
    });
    expect((await inspectLegacyPersonalSpace(legacy, [])).eligible).toBe(false);
  });
});
