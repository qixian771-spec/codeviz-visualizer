# CodeViz Skill 方案（v2 · 对齐 Spec Kit）

> 给 Spec Kit 补上缺失的那块可视化
> 一份 skill，所有 CLI（Claude Code / Codex / Gemini / WorkBuddy / Cursor）通用

---

## 一、定位（一句话）

**Spec Kit 把"一问到底生成大纲"这件事做完了，但没有可视化。我们只补这一块。**

```
Spec Kit（已有）              CodeViz Skill（要做）
─────────────────            ─────────────────────
/speckit.constitution         tasks.md ──→ 实时导图
/speckit.specify                         ──→ 进度联动
/speckit.plan                            ──→ 多项目看板
/speckit.tasks ──→ tasks.md              
/speckit.implement                      
```

**职责边界：**
- Spec Kit 负责"规划"和"执行"——它写 spec/plan/tasks，它跑 implement
- CodeViz Skill 只负责"看"——读 tasks.md，渲染成导图，监听变化，更新颜色

---

## 二、为什么不重新造大纲格式

调研发现 Spec Kit 已经是事实标准：
- 2026 年 GitHub 官方维护，跨 30+ AI 代理通用
- tasks.md 按用户故事分阶段，含依赖排序、`[P]` 并行标记、文件路径、TDD 顺序
- 任务 ID 用 `T0XX` 格式（如 T001-T043）

重新造格式等于跟标准对着干，没意义。**直接吃 tasks.md**。

---

## 三、核心场景（全部支持）

### 场景 A：新项目，从一开始就用
```
specify init --integration claude
/speckit.constitution → /speckit.specify → /speckit.plan → /speckit.tasks
                                                              ↓
                                              用户说"开始可视化"
                                                              ↓
                                              CodeViz 启动 → 浏览器弹出导图（全灰）
                                                              ↓
                                              /speckit.implement 开始写代码
                                                              ↓
                                              导图实时变绿
```

### 场景 B：项目写到一半才接入
```
已有代码，没规划文件
        ↓
用户说"接上可视化"
        ↓
CodeViz 扫描代码 + git log → 反推任务 → 生成初版 tasks.md
        ↓
已有代码对应的任务自动标绿
        ↓
后续 /speckit.implement 正常联动
```

### 场景 C：多 CLI 协作
```
GSD/Spec Kit 改 tasks.md → CodeViz 检测到 → 导图结构更新
Claude/Codex 写代码 → CodeViz 监听 → 导图颜色更新
```

### 场景 D：多项目并行
```
一个 CodeViz 后台服务
        ↓
监听多个项目目录
        ↓
网页左侧项目列表，右侧导图
        ↓
点不同项目切换看
```

---

## 四、tasks.md 格式（兼容 Spec Kit）

Spec Kit 的 tasks.md 由 `/speckit.tasks` 自动生成，含：
- 按用户故事分阶段（Phase）
- 任务 ID `T0XX`
- 依赖排序
- `[P]` 并行标记
- 文件路径
- TDD 顺序（测试任务在前）

**CodeViz 解析时识别这些字段，并支持通用 Markdown 任务列表作为降级方案：**

```markdown
# Tasks: 博客系统

## Phase 1: 用户认证

### T001 - 创建 User 模型
- files: src/models/User.ts
- [ ] implement User model with email/password

### T002 - 实现注册接口 [P]
- depends: T001
- files: src/api/auth/register.ts
- [ ] POST /auth/register endpoint

## Phase 2: 文章管理

### T003 - 创建 Post 模型
- depends: T001
- files: src/models/Post.ts
- [x] Post model with title/content/author  ← 已完成
```

**状态识别规则：**
- `[x]` 或 `[X]` → done（绿）
- `[ ]` → 看文件是否存在：存在 → in-progress（黄）；不存在 → pending（灰）
- 任务前后出现"FAILED"或"ERROR" → error（红）

---

## 五、文件结构

```
codeviz-skill/
├── SKILL.md                    ← CLI 读这个，知道怎么触发
├── bin/
│   └── codeviz.js              ← 启动入口（Node 22，零依赖）
├── src/
│   ├── server.js               ← HTTP + WebSocket 服务
│   ├── watcher.js              ← 监听 tasks.md 和代码文件
│   ├── parser.js               ← 解析 tasks.md 成树结构
│   ├── inferencer.js           ← 自动推断进度（文件 + git + 手动标记）
│   ├── git-tracker.js          ← 抓 git commit 记录
│   └── project-manager.js      ← 管理多项目
└── templates/
    ├── index.html              ← 导图主页面（含内联 CSS/JS）
    ├── mindmap.js              ← 树状导图渲染
    └── client.js               ← 浏览器端 WebSocket 客户端
```

**零依赖原则：** 全用 Node.js 内置模块（http、ws、fs、child_process），不装 npm 包。

---

## 六、进度推断逻辑

**优先级（高 → 低）：**

| 信号 | 怎么用 | 权重 |
|------|--------|------|
| tasks.md 手动标记 | `[x]` / `[ ]` 直接决定状态 | 最高 |
| git commit 记录 | commit 消息提到任务 ID 或文件 | 中 |
| 文件是否存在 | tasks.md 里写的 files 字段 | 低 |

**状态转换：**
```
pending（灰）──文件出现──→ in-progress（黄）──测试通过──→ done（绿）
                                                              │
                                                       测试失败
                                                              ↓
                                                          error（红）
任意状态 ←──Claude 改 tasks.md──→ 直接跳转
```

---

## 七、导图展示

每个任务节点：
- 任务名 + ID（T001）
- 状态颜色（灰/黄/绿/红）
- 完成时间（done 才显示）
- 代码行数（统计关联文件）
- 关联 commit（点开看列表）
- `[P]` 并行标记用图标显示
- 依赖关系用连线表示

---

## 八、MVP 范围

**做（v1 必须有）：**
- 解析 tasks.md（兼容 Spec Kit 格式 + 通用 Markdown）
- 树状导图渲染
- 文件监听 + 进度推断（文件存在 + git commit + 手动标记）
- 多项目管理（一个服务管多个）
- 手动触发启动 + 后台常驻
- 示例 tasks.md 用于演示

**不做（留 v2）：**
- 测试自动跑
- 浏览器报错收集
- 看板视图
- skill 帮生成 tasks.md（让 Spec Kit 干这个）
- 难度自动计算

---

## 九、技术栈

- **运行时**：Node.js 22（零 npm 依赖）
- **通信**：WebSocket（Node 原生）+ HTTP（Node http 模块）
- **前端**：原生 HTML/CSS/JS
- **文件监听**：Node fs.watch
- **Git**：child_process 调 git 命令

---

## 十、触发方式

用户在任何 CLI 里说：
- "开始可视化"
- "显示进度"
- "打开导图"

→ CLI 读 SKILL.md → 执行 `node bin/codeviz.js` → 浏览器自动打开 `http://localhost:7878`

---

## 待办

- [x] 调研同类方案
- [x] 确定差异化定位
- [x] 写方案文档（本文档）
- [x] 搭骨架代码
- [x] 写示例 tasks.md 测试
- [x] 整合 v4 视觉方案到正式页面
- [x] 接入真实 tasks.md 数据渲染
- [x] 验证本地服务与 API 输出

---

## 十一、2026-07-03 开发收尾

本轮已把视觉专家确认的 v4 方案接入正式 CodeViz 页面：

- `templates/index.html`：升级为单屏 Phase 分区、玻璃拟态任务节点、动态 SVG 流动连线，并补齐浅色/深色/系统主题切换。
- `templates/client.js`：重写为真实数据驱动渲染，支持项目选择、Phase 自动布局、任务节点状态更新、依赖连线和 WebSocket 实时刷新。
- `src/server.js`：API 不再只返回 Markdown 原文，而是返回解析后的 `phases/tasks/stats`，前端直接消费结构化数据。
- `bin/codeviz.js`：复用服务端统一 payload 生成逻辑，文件变化后广播完整任务结构。

验证结果：
- JavaScript 语法检查通过：`client.js` / `server.js` / `bin/codeviz.js`
- 示例服务启动成功：`http://localhost:7879`
- 示例 API 返回：6 个 Phase、16 个任务、5 个已完成任务
