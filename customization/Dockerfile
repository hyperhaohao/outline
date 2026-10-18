# 基于已验证的官方运行镜像，替换前后端构建产物，保留相同锁定运行依赖。
FROM outlinewiki/outline@sha256:898e4e94aeeb1e95a5d2a637dbcb51393cfd1e041d65381ab182cf2aade585fe
ARG SOURCE_REVISION
LABEL org.opencontainers.image.version="1.11.0-ruima.1" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.title="Outline Ruima" \
      org.opencontainers.image.description="Unified export authorization, print protection, identity watermark and security auditing"
COPY --chown=1001:1001 build/app/ /opt/outline/build/app/
COPY --chown=1001:1001 build/shared/i18n/ /opt/outline/build/shared/i18n/
COPY --chown=1001:1001 build/server/ /opt/outline/build/server/
COPY --chown=1001:1001 build/shared/ /opt/outline/build/shared/
COPY --chown=1001:1001 build/plugins/ /opt/outline/build/plugins/
COPY --chown=1001:1001 server/migrations/20261012055118-security-audit-indexes.js /opt/outline/server/migrations/
COPY --chown=1001:1001 server/mcp/skills/ /opt/outline/server/mcp/skills/
COPY --chown=1001:1001 package.json LICENSE /opt/outline/
