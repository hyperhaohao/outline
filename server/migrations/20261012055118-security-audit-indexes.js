"use strict";

module.exports = {
  /** 按工作区和时间查询安全事件，JSONB 支持组合元数据筛选。 */
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS events_security_team_time_idx ON events ("teamId", "createdAt" DESC, id DESC) WHERE name = \'security.audit\''
    );
    await queryInterface.sequelize.query(
      "CREATE INDEX IF NOT EXISTS events_security_data_idx ON events USING gin (data jsonb_path_ops) WHERE name = 'security.audit'"
    );
  },
  /** 回退仅移除索引，保留新增审计记录。 */
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "DROP INDEX IF EXISTS events_security_data_idx"
    );
    await queryInterface.sequelize.query(
      "DROP INDEX IF EXISTS events_security_team_time_idx"
    );
  },
};
