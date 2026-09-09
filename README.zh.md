# dsh-plugin-maya

[![ci](https://github.com/juewee/dsh-plugin-maya/actions/workflows/ci.yml/badge.svg)](https://github.com/juewee/dsh-plugin-maya/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，让 DSH
智能体真正会写 Maya Python：内置**离线 Autodesk `maya.cmds` 文档**、**正在运行的 Maya
实时通道**、以及**无界面 `mayapy` 验证器**——脚本交给你之前先证明它跑得起来。

它是把 [maya-doc](https://github.com/juewee/maya-doc) 项目重做成 DSH 原生插件：
它里面的技能变成 DSH 技能，"别读这 1.3 MB JSON、去 grep"变成带排序的工具，散落的
socket 脚本变成一个带帧协议的 command port 客户端。

[English](README.md) | 中文

## 工具

| 工具 | 作用 |
|---|---|
| `maya_status` | mayapy 路径/版本、命令端口是否可达、已安装的文档版本 |
| `maya_doc_search` | 每版约 1500 条命令的排序检索，可加分类过滤 |
| `maya_doc_get` | 最多 8 条命令的完整条目：描述 + 官方原始示例 + URL |
| `maya_doc_categories` | 分类 → 子分类 → 命令数，用于按主题浏览 |
| `maya_cmd` | 在**正在运行的 Maya** 里执行 Python，回传 stdout 和异常栈 |
| `maya_standalone` | 用 `mayapy.exe` 无界面跑脚本，回传 stdout/stderr/退出码 |
| `maya_session` | 常驻无界面 Maya：跨多次调用保持状态，可打开场景、遍历大纲、修改并保存 |

另外附带 2 个技能，**不需要安装插件**就能进入 DSH 技能目录：

| 技能 | 内容 |
|---|---|
| `maya-script-dev` | 工作流：什么时候用哪个工具、版本差异、命令端口配置、standalone 的坑、脚本风格 |
| `maya-script-templates` | 10 类可直接复制的模式（建模/变换、场景查询、多边形、关键帧、文件 IO、自定义属性、材质、变形器、UI、批处理） |

## 安装

```powershell
git clone https://github.com/juewee/dsh-plugin-maya.git
cd dsh-plugin-maya

node scripts/sync-docs.mjs        # 1. 从 maya-doc 检出同步爬取数据
node scripts/install-skills.mjs   # 2. 把技能装到 <项目>/.dsh/skills
node scripts/enable.mjs           # 3. 挂载到 web profile（热加载，无需重启）
```

仓库里已经带了文档数据，第 1 步只在需要更新时执行。第 3 步会往
`$DSH_HOME/profiles/web/cordis.patch.yml` 追加一行 `insert`，用 `file://` URL 引用插件——
不需要 pnpm、不需要 `node_modules`、不需要重启。加 `--dry-run` 可先预览。

环境要求：Node 20+、带 `web` profile 的 DSH；执行类工具需要装 Maya
（`maya_standalone` 需要 `mayapy.exe`，`maya_cmd` 需要 Maya 里打开
`cmds.commandPort(name=":6000", sourceType="python")`）。

## 典型流程

```
maya_status                                  → 这个会话能做什么？
maya_doc_search "blendShape"                 → 命令叫什么、属于哪个分类？
maya_doc_get ["blendShape", "setKeyframe"]   → 确切参数 + 官方示例
maya_standalone <script>                     → 在干净场景里真的能跑吗？
maya_session  <打开 .ma、遍历大纲、修改、保存>  → 多步操作，Maya 只启动一次
maya_cmd <probe>                             → 在用户当前场景里对不对？
```

PTC 模式下等价写法是在 `run_code` 里 `await tools.maya_doc_search({ query: 'blendShape' })`。

## 目录结构

```
dsh-plugin-maya/
├── lib/                     插件运行时（零依赖）
│   ├── index.js             入口：name / inject / apply + 六个工具
│   ├── schema.js            defineTool 等价实现 + JSON Schema 参数校验
│   ├── maya-docs.js         懒加载缓存的文档库、排序检索、分类树
│   ├── command-port.js      带哨兵分帧的 Maya command port 客户端
│   ├── standalone.js        mayapy 执行器 + 解释器探测
│   ├── session.js           常驻无界面 Maya 客户端
│   └── session-driver.py    常驻会话的进程内驱动
├── skills/                  DSH 技能（安装到 <项目>/.dsh/skills）
├── data/                    Maya 2020 / 2022 / 2025 文档 + MANIFEST.json
├── docs/                    设计、工具参考、配置、数据
├── scripts/                 sync-docs · install-skills · enable · link-dsh-modules
├── examples/                walk-scene.mjs · edit-scene.mjs（可脱离 DSH 直接跑）
├── test/smoke.mjs           集成测试（真实 Cordis + 真实工具注册表）
└── .github/workflows/ci.yml
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 架构、DSH 集成点、command port 协议、测试策略 |
| [docs/tools.md](docs/tools.md) | 每个工具的参数、返回值、输出示例、错误行为 |
| [docs/configuration.md](docs/configuration.md) | 配置字段、安装方式、验证、排错 |
| [docs/data.md](docs/data.md) | 数据来源、JSON 结构、更新流程 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

## 验证

`npm test` 把插件挂进真实的 Cordis 上下文和真实的 `@deepseek-ai/dsh-tools` 注册表，
并通过 `ctx.tools.execute` 派发调用，所以 schema 投影、参数校验、结果渲染都被覆盖。
`maya_cmd` 用假命令端口测试——假端口的"Maya"是真正的 Python 解释器，执行客户端发过去的
payload；`maya_standalone` 和 `maya_session` 在装有 `mayapy.exe` 时跑真 Maya，没装就跳过，
因此 CI 也能跑。会话部分会建场景、存盘、重新打开、遍历大纲并读回属性。

```powershell
npm install   # 仅 devDependencies：cordis、dsh-system-prompt、dsh-tools
npm test
```

## 已知限制

- 命令端口**无认证、仅限本机**，不要暴露到公网。
- `maya_cmd` 的代码跑在 Maya 主线程上，长任务会卡住界面；客户端能超时返回，但**无法取消
  Maya 里已在执行的代码**。
- `maya_cmd` 是实时场景通道，**不做沙箱**；无人值守的场景请用 `maya_standalone`。
- 文档是静态快照，用 `scripts/sync-docs.mjs` 更新。
- 还没有视口截图。加一个返回图片的 `maya_playblast` 工具是下一步最有价值的补充。

## 致谢

文档数据来自 [maya-doc](https://github.com/juewee/maya-doc) 对 Autodesk 官方 Maya 中文
技术文档的爬取。本仓库的 MIT 协议覆盖插件代码，不覆盖爬取内容。

## 协议

[MIT](LICENSE)
