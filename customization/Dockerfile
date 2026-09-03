# 基于已验证的官方运行镜像，仅替换前端产物、翻译和版本元数据。
FROM outlinewiki/outline@sha256:aade2a3fcf47e7121b36bd3c05df074da04a79d3d63e40457b8a289447e2166b
ARG SOURCE_REVISION
LABEL org.opencontainers.image.version="1.10.0-ruima.1" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.title="Outline Ruima" \
      org.opencontainers.image.description="Role-based visibility for official Outline navigation"
COPY --chown=1001:1001 build/app/ /opt/outline/build/app/
COPY --chown=1001:1001 build/shared/i18n/ /opt/outline/build/shared/i18n/
COPY --chown=1001:1001 package.json LICENSE /opt/outline/
