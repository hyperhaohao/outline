# 基于已验证的官方运行镜像，替换前后端构建产物，保留相同锁定运行依赖。
FROM outlinewiki/outline@sha256:5d506854fed4940177e37cec1a28e9189dd26f404faafaa978a746038b6c2dfb
ARG SOURCE_REVISION
LABEL org.opencontainers.image.version="1.12.0-ruima.2" \
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
COPY --chown=1001:1001 build/package.json /opt/outline/build/package.json
COPY --chown=1001:1001 package.json LICENSE /opt/outline/

COPY --chown=1001:1001 customization/legacy-personal-spaces.cjs /opt/outline/customization/legacy-personal-spaces.cjs
