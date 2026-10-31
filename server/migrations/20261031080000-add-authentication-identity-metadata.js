"use strict";

/** 钉钉绑定由认证链路维护，独立于用户可修改资料；旧镜像可忽略新增列。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("user_authentications", "identityMetadata", {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn(
      "user_authentications",
      "identityMetadata"
    );
  },
};
