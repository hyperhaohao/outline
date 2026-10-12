Outline 1.10.0-ruima.2 导出、打印、水印与风险审计候选构建

本次基于已部署的 ruima.1 定制源码快照 640c989de979e29e9db35cc69226df9a02327b41，保留原入口隐藏补丁。
沿用 viewersCanExport：关闭后 Viewer/Guest 禁止导出与打印，Member/工作区管理员保留既有权限。
集合导出创建与执行沿用 export 权限；历史结果下载沿用 download 权限并重新校验资源与归档清单。
全库导出始终只允许工作区管理员。正常阅读、附件和 MCP 写入不因导出开关改变。
历史归档缺少实际文档清单时，非管理员不能取得新的下载链接，应重新导出当前有权访问的内容；管理员仍执行现有资源检查。待执行任务会在生成前建立清单。

实现入口：
server/security/exportAuthorization.ts 统一权限、当前凭据校验和实际归档清单。
server/security/audit.ts 独立事务审计、固定元数据白名单与导出失败关闭。
server/security/readRisk.ts Redis Lua 用户级滚动统计，跨 API/MCP 和不同凭据。
app/components/DocumentSecurity.tsx 登录工作区文档身份水印、分屏与演示打印保护。
app/scenes/Settings/RiskAudit.tsx 中文管理员审计查询。
server/routes/api/securityAudit.ts 访问追踪、客户端打印上报及管理员过滤查询。

默认风险阈值：5 分钟 50 篇不同文档或返回正文超过 10 MiB；仅标记，不自动封禁。
集中配置：SECURITY_READ_WINDOW_MS、SECURITY_READ_DOCUMENTS、SECURITY_READ_BYTES。
审计保留复用 CleanupOldEventsTask 的 365 天规则，由 Worker 独立注册 security-audit-retention 每小时任务，只清理 security.audit，不依赖启用全局 cron。审计不保存 Key/Token、签名链接、正文或完整载荷。
浏览器水印每分钟刷新北京时间，服务端生成的访问编号与访问记录关联；浏览器打印上报不是可靠泄漏证明。
已签发存储链接只受原有效期约束，不能立即撤回；允许阅读的内容仍可能被保存。

构建与迁移：
使用 Yarn 4.11.0、固定 yarn.lock，NODE_ENV=production yarn build。
Dockerfile 叠加 build/app、build/server、build/shared、build/plugins 和包版本，沿用官方运行依赖。
单独复制 server/migrations/20261012055118-security-audit-indexes.js，启动时增加事件部分索引与 JSONB GIN 索引。
不改正文模型，回退旧镜像保留事件及索引，不执行清空事件或删除正文操作。
QA 身份服务、测试代码、node_modules 构建环境、数据库和任何环境文件均不进入镜像叠加层。

验收状态：
定向验证覆盖 16 个测试文件；最终通过数量、浏览器验收及构建结果见候选发布审查记录。
覆盖直接导出、历史结果、角色开关矩阵、撤销凭据、子文档撤权、附件、MCP 读写、跨凭据风险和业务回滚。
组件测试覆盖未知权限、分屏清理、管理员水印、点击透传、断网后打印检查。
Chrome/Edge 系统打印、Ctrl+P 与真实 PDF 应独立验收，不能把组件测试记作实际浏览器打印通过。
候选镜像与补丁可独立审查；生产切换状态以外部实施记录为准。
正式切换前补齐浏览器验收，核对固定摘要、只改两项镜像引用，重新保存停写窗口数据库备份并校验可恢复性。
回退到 ruima.1 时，先移除 Bull 中 ID 为 security-audit-retention 的重复任务及其延迟任务，再启动旧 Worker，避免旧镜像无法识别新任务类型；保留数据库中的审计记录和索引。

以下为 ruima.1 历史构建与发布记录，版本和无迁移描述仅适用于该历史版本：

目标：
工作区管理员保留 Outline 官方入口，其他已登录角色隐藏入口。
匿名登录页和匿名分享页保留原状，正文链接和业务权限不变。

源码：
基于官方 v1.10.0，补丁涉及前端源码、英文提取键、简体中文翻译与 package.json 版本。
共享规则位于 app/utils/officialLinks.ts，observer 组件通过 useOfficialLinksVisible 订阅认证状态。
账户菜单与命令搜索复用 navigation.tsx 中的 visible 条件。
角色通知沿用已有 WebSocket 事件，收到当前用户升降权后调用 fetchAuth 刷新身份，再刷新文档集。
独立入口包括设置版本区、翻译站点、API/应用/MCP 文档、演示说明和错误报错按钮。

本次验证：
yarn install --immutable
yarn vitest run --project app app/utils/officialLinks.test.ts app/actions/definitions/navigation.test.ts app/components/Sidebar/components/Version.test.tsx app/components/ErrorBoundary.test.tsx app/components/WebsocketProvider.test.tsx
yarn tsc --noEmit
对修改文件执行 yarn oxlint --type-aware 和 yarn oxfmt --check。
浏览器矩阵及结果另见测试记录。

生产打包：
NODE_ENV=production yarn build
docker build --pull=false -f customization/Dockerfile --build-arg SOURCE_REVISION=<Git提交号> -t outline-ruima:1.10.0-ruima.1 .
使用 Dockerfile 专属忽略文件，只包含 build/app、build/shared/i18n、package.json、LICENSE。
最终镜像沿用官方服务器代码、依赖、入口点与运行用户，不添加测试身份提供器或构建工具。

隔离测试：
customization/qa-idp.mjs 是独立测试用 OIDC 身份提供器，仅接受 localhost:13810 的测试回调。
与空白测试 PostgreSQL/Redis 配合，端口只绑定服务器回环地址，通过 SSH 转发到测试浏览器。
QA_CLIENT_SECRET 使用临时随机值注入，不写入仓库。
测试账号和角色只存在于测试数据库，不使用生产用户或数据库副本。
测试身份提供器不允许进入正式镜像或生产网络。

发布：
先保存正式 Compose 与官方镜像引用，核对镜像标签、摘要、版本和服务配置。
必须单独确认生产维护窗口；构建/上传授权不包含生产切换。
确认后 Web 和 Worker 使用同一固定摘要镜像，仅重建这两个服务。
本次无数据库迁移；失败时恢复升级前的官方 1.10.0 镜像。
继续保留生产备份、官方镜像、定制镜像以及对应 Git 补丁。

后续升级：
从新的官方版本重新合并源码补丁，复查官方界面入口，重跑角色矩阵、构建和浏览器回归。
禁止直接修改运行容器内的压缩资源。

GitHub 镜像发布：
仓库：https://github.com/hyperhaohao/outline
定制源码分支：codex/non-admin-outline-links
镜像地址：ghcr.io/hyperhaohao/outline:1.10.0-ruima.1
固定摘要、归档校验值和镜像源码提交号记录在 customization/release.json。
归档通过 Releases 保存，不提交到 Git 历史；导入命令：
docker load -i outline-1.10.0-ruima.1.tar

.github/workflows/ruima-publish.yml 使用仓库内置 GITHUB_TOKEN 发布 GHCR。
先上传与校验 Release 镜像附件，再提交 release.json 到定制分支触发发布。
流程校验归档 SHA-256，以 skopeo --preserve-digests 复制 OCI 镜像，并核对远端摘要。
镜像保留构建时的原始标签，因此原有上游 source/url 标签不在复制时重写。
后续发布应使用新版本号与独立 Release，不覆盖已经验收的版本。
源码构建步骤见上文；此发布流程复制已验收产物，不重新构建已有版本。
发布到 GitHub/GHCR 不会改变任何运行中的部署。

公开源码追溯：
公开分支直接基于官方 v1.10.0 提交 65be53c3eb093a535ce260eb2f2da897bb07a29e 应用定制补丁。
release.json 中的 sourceRevision 是镜像构建时的本地提交标识；公开提交因整理历史而不同。
定制应用代码、翻译、package.json、依赖锁文件与已验收构建一致；测试附件保留官方原始 Git 对象。
本地导入时由透明加密软件产生的测试附件密文不进入公开历史。
发布前已使用 Gitleaks 检查源码与提交历史，命中项均与上游公开测试配置或代码一致。
镜像环境变量与官方基底一致；三个新增层仅含前端产物、翻译、版本元数据和许可证。
