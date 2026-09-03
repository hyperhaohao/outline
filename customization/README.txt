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
