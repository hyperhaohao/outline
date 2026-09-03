Outline 1.10.0-ruima.1 定制构建说明

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
