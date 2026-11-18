# 可用 Skills

本目录汇总仓库当前可安装的 Skill。通用安装方法见
[`README.md`](README.md#快速开始)。

网站提供“全部、开发工程、仓库工作流、图表可视化、视觉创作、效率与思考、其他”分类筛选，可与搜索组合使用。
分类在 [`skills.config.json`](skills.config.json) 中统一维护；修改后运行
`pnpm run groups:generate` 更新安装菜单清单，维护方法见
[`README.md`](README.md#维护-skill-分类)。

| Skill | 用途 |
| --- | --- |
| [`excalidraw-diagram`](skills/excalidraw-diagram/) | 根据自然语言创建 Excalidraw 图表，并通过渲染检查迭代优化视觉效果。 |
| [`excalidraw-diagram-generator`](skills/excalidraw-diagram-generator/) | 根据自然语言生成 Excalidraw 流程图、架构图和关系图。 |
| [`ian-xiaohei-illustrations`](skills/ian-xiaohei-illustrations/) | 为中文文章规划并生成 Ian 小黑风格的 16:9 白底手绘正文配图。 |
| [`ip-as-logo`](skills/ip-as-logo/) | 创建简洁、拟人化的方形角色图标与 IP 形象候选。 |

## 特殊安装与依赖

### `excalidraw-diagram`

预览渲染器依赖 `uv` 和 Playwright。安装 Skill 后可让 Agent 按随附的
[`README.md`](skills/excalidraw-diagram/README.md#setup) 完成首次配置。

### `drawio-skill`

导出图片时需要安装 draw.io 桌面版，并确保其 CLI 可调用；Graphviz 仅在使用
可选的自动布局功能时需要。

### `ian-xiaohei-illustrations`

生成或编辑配图时需要运行环境提供内置 `image_gen` 工具；仅规划配图策略时无需生图工具。
Skill 由 [Ian](https://github.com/helloianneo) 创建，随附示例图用于风格校准。
