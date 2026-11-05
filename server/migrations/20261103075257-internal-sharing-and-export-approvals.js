"use strict";

/** 新增内部分享及审批结构；不在结构迁移中撤销生产链接，数据变更单独备份核验。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        "shares",
        "audience",
        { type: Sequelize.STRING, allowNull: false, defaultValue: "public" },
        { transaction }
      );
      await queryInterface.addColumn(
        "shares",
        "internalEnabled",
        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        { transaction }
      );
      await queryInterface.createTable(
        "export_approvals",
        {
          id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
          teamId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "teams", key: "id" },
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "users", key: "id" },
          },
          resourceId: { type: Sequelize.UUID, allowNull: false },
          resourceType: { type: Sequelize.STRING, allowNull: false },
          action: { type: Sequelize.STRING, allowNull: false },
          format: { type: Sequelize.STRING, allowNull: true },
          includeChildDocuments: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          reason: { type: Sequelize.TEXT, allowNull: false },
          manifest: { type: Sequelize.JSONB, allowNull: false },
          manifestDigest: { type: Sequelize.STRING, allowNull: false },
          status: {
            type: Sequelize.STRING,
            allowNull: false,
            defaultValue: "pending",
          },
          responderId: {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: "users", key: "id" },
          },
          response: { type: Sequelize.TEXT, allowNull: true },
          respondedAt: { type: Sequelize.DATE, allowNull: true },
          expiresAt: { type: Sequelize.DATE, allowNull: true },
          consumedAt: { type: Sequelize.DATE, allowNull: true },
          fileOperationId: {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: "file_operations", key: "id" },
            unique: true,
          },
          printSessionDigest: { type: Sequelize.STRING, allowNull: true },
          printSessionExpiresAt: { type: Sequelize.DATE, allowNull: true },
          downloadStartedAt: { type: Sequelize.DATE, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.addIndex(
        "export_approvals",
        ["teamId", "status", "createdAt"],
        { transaction }
      );
      await queryInterface.addIndex(
        "export_approvals",
        ["userId", "createdAt"],
        { transaction }
      );
      await queryInterface.addIndex(
        "export_approvals",
        [
          "userId",
          "action",
          "resourceId",
          "manifestDigest",
          "format",
          "includeChildDocuments",
        ],
        {
          name: "export_approvals_unique_pending",
          unique: true,
          where: { status: "pending" },
          transaction,
        }
      );
    });
  },
  async down() {
    throw new Error(
      "审批及审计结构禁止自动删除；应用回退必须保留数据并使用安全门禁镜像。"
    );
  },
};
