# CodeViz Skill 项目记忆

## 项目目标
做一个可视化联动 skill，解决 CLI/桌面版开发无法实时可视化的痛点。
用 HTML 网页实时可视化，支持 Claude Code / Codex / Gemini / WorkBuddy 等所有主流 CLI。

## 关键技术认知（2026-07-03 确认，重要！）
**MCP（Model Context Protocol）已成跨厂商通用标准**，截至 2026 年 4 月：
- Claude Code ✓ 支持 MCP
- Codex CLI ✓ 支持 MCP
- Gemini CLI ✓ 支持 MCP
- OpenCode ✓ 支持 MCP（模型无关）
- WorkBuddy ✓ 支持 MCP

**SKILL.md 格式（Markdown + YAML frontmatter）也跨 CLI 可移植**：
- Claude / OpenCode / Gemini 都用 Markdown + YAML
- 仅 Codex 用 TOML，需小翻译
- 各 CLI 发现路径不同（.claude/ .opencode/ .gemini/ 等），但内容可移植

## 架构决策（纠偏后）
- ❌ 旧方案：5 个适配器（基于"每家插口不同"的错误认知）
- ✅ 新方案：**一个 MCP Server 通用所有 CLI**，几乎不需要适配器
- 核心引擎 = MCP Server（WebSocket + File Watcher + 可视化模板）
- 仅需一个轻量 SKILL.md 分发脚本，把同一份 skill 放到各 CLI 目录

## 用户偏好
- MVP 范围：极简
- 通信方式：WebSocket
- 前端栈：原生 HTML/CSS/JS（零依赖，符合 Skill 轻量原则）
- 用户会质疑不准确的表述 → 必须查证后再说，不能凭记忆想当然

## 核心需求场景（用户 2026-07-03 明确）
用户要的不是"代码预览"，而是**项目进度可视化导图**：
1. 规划阶段：用 GSD（规划类 CLI）一问到底 → 生成项目大纲（类似装修设计图）
2. skill 启动 HTML 服务 → 把大纲渲染成导图（全灰=未开始）
3. 开发阶段：换 Claude 等开发类 CLI 写代码
4. git commit 提交后 → 对应任务节点变色（灰→黄→绿）
5. 双屏工作流：左屏终端开发，右屏导图实时看进度

关键设计点：
- 数据源1：规划 CLI 生成的大纲文件（plan.md 之类）
- 数据源2：git commit 记录（匹配到任务节点）
- 可视化：树状导图，四态颜色（灰未开始/黄进行中/绿完成/红报错）
- skill 职责：解析大纲 → 渲染导图 → 监听 git → 更新颜色

## 完整需求确认（2026-07-03 一问到底后确认）
**介入时机**：一开始用 + 写到一半用，两种都要支持
**大纲来源**：GSD生成 / 手写 / skill帮生成，几种都可能
**中途接入**：skill 自动推断进度（综合文件存在+git commit+测试结果）
**标错撤回**：Claude 自己改 plan.md 改回去
**多CLI切换**：GSD规划、中途改大纲、多CLI并用，都有可能
**任务粒度**：不同项目粒度不同，skill 都要支持
**额外信息**：完成时间、代码行数、报错标红、关联commit，全都要
**难度**：skill 根据代码量自动算
**报错来源**：终端报错、浏览器报错、skill主动检查，三种都要
**多项目**：要支持多项目并行
**多设备预览**：两码事，不在本项目范围

## 架构决策（工程师拍板）
- 多项目管理：一个服务管所有项目（省资源，避免端口冲突）
- 大纲格式：skill 定标准格式 + 能导入任意 Markdown
- 导图样式：树状导图为主（看板留 v2）
- 启动方式：手动触发 + 后台常驻

## MVP 范围（第一版）
做：plan.md 解析、树状导图、文件监听+git推断、多项目管理、手动启动
不做（留v2）：测试自动跑、浏览器报错、看板视图、skill生成plan、难度计算

## 方案文档位置
/Users/niuniu/WorkBuddy/2026-07-03-05-24-57/overview.md

## 竞品调研结论（2026-07-03 搜索后确认）
**重大发现：GitHub Spec Kit 就是用户说的"GSD 一问到底"工具！**
- Spec Kit 已经定义标准流程：spec.md → plan.md → tasks.md
- 跨 CLI 通用（Claude/Cursor/Copilot/Gemini 都支持）
- 用 `specify init --ai claude` 集成，把斜杠命令写到 agent 配置目录
- **但 Spec Kit 完全没有可视化界面**，全靠 Markdown + Git 看

其他竞品：
- task-cli：有甘特图可视化，但是独立 Python CLI，不能跟 Claude/Codex 联动
- Microsoft Conductor：有 web dashboard，但可视化的是 agent 调用图，不是项目任务进度
- Claude/Codex/Gemini 本身：完全没有进度可视化

## 差异化定位（最终方案）
**不重新造轮子，只补 Spec Kit 缺的那块可视化：**
1. 不重新造大纲格式 → 直接吃 Spec Kit 的 tasks.md
2. 不重新造规划工具 → Spec Kit 已经把"一问到底"做完了
3. 只做一件事：tasks.md → 实时可视化导图 + 进度联动

## 修正后的方案
原方案的 plan.md 标准格式应改为：兼容 Spec Kit 的 tasks.md 格式
tasks.md 任务结构：标题 + 范围 + 完成条件（Done When）+ 状态标记
集成方式：用户先用 Spec Kit 生成 tasks.md，再用本 skill 渲染成导图

## 团队分工
- 高级开发工程师（吴八哥）：后端逻辑、skill 骨架、数据解析、通信
- 视觉设计师 墨白（codeviz-visual-designer）：导图视觉设计、布局、配色、动效

专家信息：
- 路径：/Users/niuniu/.workbuddy/plugins/marketplaces/my-experts/plugins/codeviz-visual-designer
- 状态：已创建并注册到 WorkBuddy 市场
- 职责：项目进度导图的视觉设计（布局、配色、动效、字体、暗色模式）
- 协作方式：墨白出 HTML/CSS/JS 视觉代码片段，吴八哥负责把视觉代码接到后端数据

## v1 代码骨架位置
/Users/niuniu/WorkBuddy/2026-07-03-05-24-57/codeviz-skill/
