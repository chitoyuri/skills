# chitoyuri Skills

个人 Agent Skills 聚合仓库。这里集中维护可复用的 Skill，并通过统一的
`skills/` 发布目录供 [`skills`](https://skills.sh/) CLI 发现和安装。

## 可用 Skills

完整清单、用途及特殊安装要求见 [`SKILLS.md`](SKILLS.md)。

## 快速开始

先查看仓库中可安装的 Skill：

```bash
npx skills add chitoyuri/skills --list
```

安装指定 Skill：

```bash
npx skills add chitoyuri/skills --skill ip-as-logo
```

默认安装到当前项目；如需安装到用户级目录，追加 `--global`。也可以把
`ip-as-logo` 替换为 [`SKILLS.md`](SKILLS.md) 中的其他 Skill 名称。

## 本地开发

环境要求：Node.js `>=22.20.0`、pnpm `10.34.4`。

```bash
git clone --recurse-submodules https://github.com/chitoyuri/skills.git
cd skills
pnpm install
```

如果克隆时没有初始化子模块，可稍后执行：

```bash
pnpm run sources:init
```

### 目录结构

```text
.
├── skills/                # 对外发布、可被 skills CLI 发现的 Skill
│   └── <skill-name>/
│       ├── SKILL.md       # Skill 入口
│       ├── references/    # 可选：详细参考资料
│       ├── scripts/       # 可选：可执行工具
│       └── assets/        # 可选：输出素材
├── sources/               # 通过 Git submodule 引用的 Skill 来源
├── scripts/               # 仓库维护脚本
├── site/                  # Astro 静态网站源码
├── skills.config.json     # Skill 分类、来源、依赖与运行要求
├── .claude-plugin/        # 从分类配置生成的 CLI 分组清单
├── .gitmodules            # Git submodule 配置
└── AGENTS.md              # 仓库维护约定
```

`sources/` 只保存外部项目的子模块引用；真正供 CLI 发现和安装的内容始终位于
`skills/`。安装器通常不会递归拉取子模块，因此外部 Skill 也必须同步到发布目录。

## 添加 Skill

### 添加仓库内维护的 Skill

在 `skills/<skill-name>/` 下创建 `SKILL.md`。目录名和 frontmatter 中的 `name`
必须一致，并且只能使用小写字母、数字和连字符：

```yaml
---
name: example-skill
description: 简洁说明该 Skill 在什么情况下使用。
---
```

`SKILL.md` 应遵循 [Agent Skills 规范](https://agentskills.io/specification)。仓库内
自行维护的 Skill 可按需要使用规范支持的 frontmatter 字段；较长的说明、工具和
素材应分别放入 `references/`、`scripts/` 和 `assets/`。

### 添加外部 Skill

运行交互式命令，一次完成添加来源和登记配置：

```bash
pnpm run sources:add
```

按提示输入仓库 URL 和项目名称。项目名称默认从 URL 推导，回车即可接受，来源
保存到 `sources/<project-name>`。子模块添加成功后，命令自动查找 Git 已跟踪的
`SKILL.md`：只有一个 Skill 时自动选中，多个时通过勾选列表选择，默认全选。
随后为本次新增的 Skill 统一选择分类，默认“其他”，并自动写入
`skills.config.json` 中的名称、子模块路径、Skill 相对路径和分类。

同一来源包含同名 Skill 的多个版本时，优先使用已登记的路径，其次使用
`skills/<name>`；仍无法确定来源目录时提示重名冲突。

也可以通过参数提供已知信息，其余选项仍由交互提示补充：

```bash
# 输入项目名称及后续选项
pnpm run sources:add -- <repository-url>

# 指定来源目录，也可将第二个参数写为 <project-name>
pnpm run sources:add -- <repository-url> sources/<project-name>

# 无交互登记全部 Skill，并指定分类
pnpm run sources:add -- <repository-url> sources/<project-name> --all --category development

# 无交互登记指定 Skill，--skill 可重复使用
pnpm run sources:add -- <repository-url> sources/<project-name> --skill example-skill --category development
```

非交互环境中必须提供 URL，省略项目名称时从 URL 推导，省略分类时使用“其他”；
发现多个 Skill 时必须通过 `--all` 或 `--skill` 指定选择。

已有子模块且来源 URL 一致时，重复运行会重新扫描并补充登记。已登记且来源相同
的条目会保留原有分类和运行要求；同名但来源不同则提示冲突。中途取消注册会
保留已添加的子模块，可以使用相同命令重试。

登记完成后，运行以下命令同步到发布目录、生成分组清单并校验：

```bash
pnpm run update -- <skill-name>
pnpm run groups:generate
pnpm run check
```

不要直接修改由外部来源同步生成的 `skills/<skill-name>/`；同步时保持上游目录和
frontmatter 原样。改动应先在来源项目中完成，再同步到本仓库。

### 维护 Skill 分类

分类只在 `skills.config.json` 的对应 Skill 条目中维护，使用可选的 `category`
字段。仓库内维护的 Skill 也可以只登记分类。

| category | 网站名称 |
| --- | --- |
| `development` | 开发工程 |
| `repository-workflow` | 仓库工作流 |
| `diagramming` | 图表可视化 |
| `visual-design` | 视觉创作 |
| `productivity` | 效率与思考 |
| `other` 或未配置 | 其他 |

分类 ID 和显示名统一定义在 `scripts/skill-categories.mjs`。添加、删除 Skill
或调整分类后，生成并提交 CLI 分组清单：

```bash
pnpm run groups:generate
pnpm run check
```

`.claude-plugin/marketplace.json` 是生成文件，请勿手动维护。
`skills` CLI 读取它显示安装分组，仍可安装到 Codex 等支持的 Agent；网站直接读取
分类配置，提供“全部”和各分类按钮，可与关键词搜索组合使用。
无需修改上游 Skill 的 frontmatter 或调整发布目录结构。

## 更新外部 Skills

添加或更新外部 Skill 后，统一使用 `update` 获取上游最新版本并复制到发布目录：

```bash
# 交互选择要更新的外部 Skill
pnpm run update

# 直接更新指定 Skill，可传入多个名称
pnpm run update -- <skill-name> [<skill-name>...]

# 直接更新全部外部 Skills
pnpm run update -- --all
```

无参数时，命令在交互终端中显示已登记来源的外部 Skill 列表，默认不勾选。
使用空格勾选，至少选择一项后回车开始更新；按 `Ctrl+C` 可取消，选择完成前
不会执行 Git 操作。指定名称或 `--all` 时直接更新，不显示选择菜单。
CI 等非交互环境必须传入名称或 `--all`，无参数调用会提示用法并退出。

命令会初始化对应子模块，并更新到其远程跟踪分支的最新提交；分支由 `.gitmodules`
或本地 Git 配置指定，未指定时使用远程默认分支。仓库内维护的 Skill 会自动跳过。
同一次运行中，每个来源只拉取一次，再同步选中的 Skill，完成后汇总更新数量。
多个 Skill 共用来源时，更新其中一个也会移动共享子模块的提交指针，发布目录
只同步选中的 Skill。

更新完成后，需要同时提交子模块指针和对应的 `skills/<skill-name>/` 发布内容；
命令不会自动执行 Git 提交。

## 校验

提交前运行：

```bash
pnpm run check
```

该命令校验分组清单、检查 Skill 发现结果并运行测试，不会修改仓库文件。
清单缺失或过期时会提示运行 `pnpm run groups:generate`。
`pnpm run site:check` 还会构建网站并检查站内链接。链接检查根据 `skills.config.json`
中的 `submodule` 排除外部 Skill 的文件预览页和原始下载文件内部的链接；本站页面、
Skill 详情页及指向预览和下载文件的链接仍受校验。
也可以使用以下命令单独查看结果：

```bash
pnpm run skills:list
pnpm run groups:check
```

## 网站开发

网站直接读取 Git 已跟踪的 `skills/*/SKILL.md`，并在构建时生成详情页、文件预览、
搜索索引和单 Skill ZIP，不需要数据库或后端服务。

```bash
# 启动本地开发服务器
pnpm run site:dev

# 完整执行 Skill、类型、构建和站内链接检查
pnpm run site:check
```

GitHub Actions 会在 push 和 PR 上执行构建校验。外部 Skill 的来源和同步路径登记在
`skills.config.json`；Skill 的安装依赖
和运行要求使用其中的可选 `skillDependencies` 与 `requirements` 字段维护，仓库内
维护的 Skill 也可以只登记这两个字段。

网站通过 Cloudflare Workers Static Assets 发布，配置见 [`wrangler.jsonc`](wrangler.jsonc)；
响应头与缓存规则见 [`site/public/_headers`](site/public/_headers)。构建时通过 `URL`
设置正式站点地址，用于生成规范链接和站点地图。

## 脚本测试

仓库使用 Vitest 测试 `scripts/` 下的维护脚本。测试只操作临时目录和临时 Git
仓库，不会同步、删除或修改真实的 Skill 来源与发布目录。

```bash
# 运行全部脚本测试
pnpm test

# 运行测试并逐文件检查覆盖率
pnpm run test:coverage
```

每个脚本的行覆盖率与函数覆盖率不得低于 90%，分支覆盖率不得低于 80%。
GitHub Actions 会在 Ubuntu 和 Windows 上执行覆盖率检查。
