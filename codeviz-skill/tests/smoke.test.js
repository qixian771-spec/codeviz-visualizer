#!/usr/bin/env node
/**
 * smoke.test.js - CodeViz 零依赖冒烟测试
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseTasksMd, getStats } = require('../src/parser');
const { ProjectManager } = require('../src/project-manager');
const { createProjectPayload, renderThemePage, THEMES } = require('../src/server');
const { isCommitRelatedToTask, parseNameStatus } = require('../src/git-tracker');

const root = path.resolve(__dirname, '..');
const exampleRoot = path.join(root, 'examples');
const templateIndex = path.join(root, 'templates', 'index.html');
const templateClient = path.join(root, 'templates', 'client.js');
const themeRuntime = path.join(root, 'templates', 'theme-runtime.js');
const themesDir = path.join(root, 'templates', 'themes');

function testExampleParsing() {
  const content = fs.readFileSync(path.join(exampleRoot, 'tasks.md'), 'utf-8');
  const { phases, tasks } = parseTasksMd(content);
  const stats = getStats(tasks);

  assert.strictEqual(phases.length, 6, 'example should contain 6 phases');
  assert.strictEqual(tasks.length, 16, 'example should contain 16 tasks');
  assert.strictEqual(stats.done, 5, 'example should contain 5 done tasks');
  assert.deepStrictEqual(tasks.find(task => task.id === 'T005').depends, ['T003', 'T004']);
}

function testSpecKitListFormat() {
  const content = `# Tasks: Demo

## Phase 1: Setup
- [ ] T001 [P] Create scaffold (files: package.json, src/main.js)
- depends: T000
- [x] T002 - Configure app depends: T001

## Phase 2: UI
- [ ] T003 Build dashboard files: src/App.vue depends: T001, T002
`;

  const { phases, tasks } = parseTasksMd(content);
  assert.strictEqual(phases.length, 2, 'list format should keep phases');
  assert.strictEqual(tasks.length, 3, 'list format should parse tasks');
  assert.strictEqual(tasks[0].id, 'T001');
  assert.strictEqual(tasks[0].parallel, true);
  assert.deepStrictEqual(tasks[0].files, ['package.json', 'src/main.js']);
  assert.strictEqual(tasks[1].status, 'done');
  assert.deepStrictEqual(tasks[1].depends, ['T001']);
  assert.deepStrictEqual(tasks[2].depends, ['T001', 'T002']);
}

async function testProjectPayload() {
  const manager = new ProjectManager();
  const project = manager.addProject(exampleRoot);
  const payload = await createProjectPayload(project, { useGit: false, useFiles: false });

  assert.strictEqual(payload.projectName, 'examples');
  assert.strictEqual(payload.phases.length, 6);
  assert.strictEqual(payload.tasks.length, 16);
  assert.strictEqual(payload.stats.total, 16);
}

function testTemplates() {
  const index = fs.readFileSync(templateIndex, 'utf-8');
  const client = fs.readFileSync(templateClient, 'utf-8');

  assert(index.includes('id="canvas"'), 'index should include canvas');
  assert(index.includes('id="theme-toggle"'), 'index should include theme toggle');
  assert(index.includes('/client.js'), 'index should load client.js');
  assert(index.includes('id="visual-select"'), 'index should expose the visual template selector');
  assert(client.includes('drawLines()'), 'client should draw SVG flow lines');
  assert(client.includes('applyTheme()'), 'client should support theme switching');
  assert(client.includes('/theme/'), 'client should navigate to live visual themes');
}

function testLiveThemes() {
  const runtime = fs.readFileSync(themeRuntime, 'utf-8');
  assert(runtime.includes("new WebSocket"), 'theme runtime should connect to realtime updates');
  assert(runtime.includes("fetch('/api/projects')"), 'theme runtime should support project switching');
  assert(runtime.includes('__CODEVIZ_LIVE_READY__'), 'theme runtime should expose a browser acceptance signal');
  assert(runtime.includes('fitThemeCanvas'), 'theme runtime should fit the 1600x900 artboard to the viewport');

  for (const [themeKey, theme] of Object.entries(THEMES)) {
    const filePath = path.join(themesDir, theme.file);
    assert(fs.existsSync(filePath), `${themeKey} theme source should exist`);
    const source = fs.readFileSync(filePath, 'utf-8');
    assert(source.includes('__CODEVIZ_THEME_DATA__'),
      `${themeKey} should consume injected project data`);
    assert(source.includes('data-status'),
      `${themeKey} should expose task status in the rendered DOM`);
  }

  const html = renderThemePage('formation', {
    projectId: 'proj-test',
    projectName: '</script><script>bad()</script>',
    phases: [],
    tasks: [],
    stats: { total: 0, done: 0, inProgress: 0, pending: 0, error: 0 }
  });
  assert(html.includes('window.__CODEVIZ_THEME_DATA__='), 'server should inject theme payload');
  assert(html.includes('/theme-runtime.js'), 'server should inject the shared live runtime');
  assert(!html.includes('</script><script>bad()'), 'inline payload must escape script-breaking markup');
  assert.strictEqual(renderThemePage('missing-theme', {}), null, 'unknown themes should not render');
}

// --- Regression tests for confirmed bugs (see review) ---

function testInlineFilesDependsNoCollision() {
  // Bug 1: inline "files: a.ts depends: T002" must not let files swallow depends,
  // and the display name must be stripped clean of both clauses.
  const content = `# Tasks: X
## Phase 1
### T001 - Init files: a.ts depends: T002
- [ ] do
### T002 - Next files: c.ts depends: T001
- [ ] do
`;
  const { tasks } = parseTasksMd(content);
  assert.deepStrictEqual(tasks[0].files, ['a.ts'], 'T001 files should be [a.ts]');
  assert.deepStrictEqual(tasks[0].depends, ['T002'], 'T001 depends should be [T002]');
  assert.strictEqual(tasks[0].name, 'Init', 'T001 name should be clean');
  assert.deepStrictEqual(tasks[1].files, ['c.ts'], 'T002 files should be [c.ts]');
  assert.deepStrictEqual(tasks[1].depends, ['T001'], 'T002 depends should be [T001]');
  assert.strictEqual(tasks[1].name, 'Next', 'T002 name should be clean');
}

function testDuplicateTaskIdDedup() {
  // Bug 4: duplicate task IDs must be deduped so nodes stay uniquely addressable.
  const content = `# Tasks: X
## Phase 1
### T001 - A
- [ ] x
### T001 - B
- [ ] y
### T002 - C
- [ ] z
`;
  const { tasks } = parseTasksMd(content);
  assert.deepStrictEqual(tasks.map(t => t.id), ['T001', 'T001-2', 'T002'], 'duplicate ids should be suffixed');
  const ids = new Set(tasks.map(t => t.id));
  assert.strictEqual(ids.size, tasks.length, 'all task ids should be unique');
}

function testNonPhaseHeadingIgnored() {
  // Bug 3: a bare "## Overview" with no tasks must not pollute the phase list,
  // but "## Phase N" and bare headings that DO have tasks must still register.
  const withOverview = parseTasksMd(`# Tasks: X
## Overview
Some intro text.
## Phase 1: Setup
### T001 - Foo
- [ ] do it
`);
  assert.strictEqual(withOverview.phases.length, 1, 'Overview (no tasks) should not become a phase');
  assert.strictEqual(withOverview.phases[0].name, 'Setup');
  assert.strictEqual(withOverview.tasks[0].phase, withOverview.phases[0].id);

  const bareWithTasks = parseTasksMd(`# Tasks: X
## Setup
### T001 - Foo
- [ ] do it
## Deploy
### T002 - Bar
- [ ] do it
`);
  assert.strictEqual(bareWithTasks.phases.length, 2, 'bare headings with tasks should register');
  assert.deepStrictEqual(bareWithTasks.phases.map(p => p.name), ['Setup', 'Deploy']);

  const emptyExplicit = parseTasksMd(`# Tasks: X
## Phase 1: Setup
## Phase 2: Deploy
### T001 - Foo
- [ ] do it
`);
  assert.strictEqual(emptyExplicit.phases.length, 2, 'explicit ## Phase N should register even when empty');
  assert.strictEqual(emptyExplicit.tasks[0].phase, 'phase-2', 'task should land in phase-2');
}

function testDuplicatePhaseNamesDistinctIds() {
  // Bug 2 (parser side): two same-named phases must still get distinct ids so the
  // frontend can label them by id instead of colliding on name.
  const { phases } = parseTasksMd(`# Tasks: X
## Phase 1: Setup
### T001 - A
- [ ] x
## Phase 2: Setup
### T002 - B
- [ ] y
`);
  assert.strictEqual(phases.length, 2, 'two Setup phases should both register');
  assert.deepStrictEqual(phases.map(p => p.name), ['Setup', 'Setup']);
  const ids = new Set(phases.map(p => p.id));
  assert.strictEqual(ids.size, 2, 'phase ids must be unique even when names match');
}

function testSubChecklistDoesNotCompleteParent() {
  // Bug: 勾选任意一个子清单项曾把父任务整体标成 done。
  // 正确语义：全部勾选 → done；部分勾选 → in-progress；一个没勾 → 保持原状态
  const partial = parseTasksMd(`# Tasks: X
## Phase 1
- [ ] T001 主任务
- [x] 子步骤A
- [ ] 子步骤B
`);
  assert.strictEqual(partial.tasks.length, 1, 'sub items should not become tasks');
  assert.strictEqual(partial.tasks[0].status, 'in-progress', 'partially checked sub-items mean in-progress, not done');

  const all = parseTasksMd(`# Tasks: X
## Phase 1
### T001 - 主任务
- [x] 子步骤A
- [x] 子步骤B
`);
  assert.strictEqual(all.tasks[0].status, 'done', 'all sub-items checked means done');

  const none = parseTasksMd(`# Tasks: X
## Phase 1
### T001 - 主任务
- [ ] 子步骤A
`);
  assert.strictEqual(none.tasks[0].status, 'pending', 'no checked sub-items keeps pending');
}

function testErrorMarkerPrecision() {
  // Bug: 描述里出现 error 单词就误报；纯中文 失败/错误 因 \b 对中文无效检测不到
  const mention = parseTasksMd(`# Tasks: X
## Phase 1
### T001 - 添加 error handling 逻辑
这个任务要处理 error 场景
`);
  assert.strictEqual(mention.tasks[0].status, 'pending', 'mentioning "error" must not flag the task');

  const zhColon = parseTasksMd(`# Tasks: X
## Phase 1
### T002 - 部署
构建失败：内存不足
`);
  assert.strictEqual(zhColon.tasks[0].status, 'error', 'Chinese 失败： marker should be detected');

  const upper = parseTasksMd(`# Tasks: X
## Phase 1
### T003 - CI
Build FAILED
`);
  assert.strictEqual(upper.tasks[0].status, 'error', 'uppercase FAILED should be detected');

  const colon = parseTasksMd(`# Tasks: X
## Phase 1
### T004 - X
error: cannot find module
`);
  assert.strictEqual(colon.tasks[0].status, 'error', 'error: prefix should be detected');

  const zhEnd = parseTasksMd(`# Tasks: X
## Phase 1
### T005 - Y
部署到生产环境失败
`);
  assert.strictEqual(zhEnd.tasks[0].status, 'error', 'Chinese marker at line end should be detected');

  const zhMid = parseTasksMd(`# Tasks: X
## Phase 1
### T006 - Z
处理登录失败的情况
`);
  assert.strictEqual(zhMid.tasks[0].status, 'pending', 'Chinese marker mid-sentence must not flag');
}

function testCommitFileMatchBoundary() {
  // Bug: endsWith 无路径边界，latest.js 误匹配 test.js
  const noise = { message: 'refactor', files: ['src/latest.js'] };
  assert.strictEqual(isCommitRelatedToTask(noise, { id: 'T009', files: ['test.js'] }), false,
    'latest.js must not match task file test.js');

  const nested = { message: 'x', files: ['src/app/test.js'] };
  assert.strictEqual(isCommitRelatedToTask(nested, { id: 'T009', files: ['test.js'] }), true,
    'suffix match on a path segment boundary should still work');

  const reverse = { message: 'x', files: ['test.js'] };
  assert.strictEqual(isCommitRelatedToTask(reverse, { id: 'T009', files: ['app/test.js'] }), false,
    'root-level test.js should not match nested task path on bare suffix');
}

function testNameStatusParsing() {
  // Bug: --name-status 行按 \s+ 切分，带空格文件名被截断，rename 只取旧路径
  const out = [
    'COMMIT:abc123|me|2026-07-16|feat T001 done',
    'M\tsrc/my file.txt',
    'R100\told name.js\tnew name.js',
    'A\tsrc/plain.js'
  ].join('\n');
  const commits = parseNameStatus(out);
  assert.strictEqual(commits.length, 1);
  assert(commits[0].files.includes('src/my file.txt'), 'filename with spaces must stay intact');
  assert(commits[0].files.includes('new name.js'), 'rename should capture the new path');
  assert(commits[0].files.includes('src/plain.js'), 'plain path should parse');
}

function testClientRegressionCanaries() {
  const client = fs.readFileSync(templateClient, 'utf-8');
  // Bug 2 回归：formatPhaseLabel 必须拿到整个 phaseBox（含 id），不能只传 name
  assert(!client.includes('formatPhaseLabel(phaseBox.name)'),
    'phase label must not be looked up by name only');
  assert(client.includes('formatPhaseLabel(phaseBox)'),
    'phase label should be formatted from the phase box (id-based)');
  // 美术：默认主题必须是深色（首次打开、无本地偏好时）
  assert(/localStorage\.getItem\('codeviz-theme'\)\s*\|\|\s*'dark'/.test(client),
    'default theme should be dark');
  // 断线重连后必须重新拉取当前项目，否则界面停留旧数据
  assert(client.includes('this.loadProject(this.currentProjectId)'),
    'reconnect should reload current project');
}

async function run() {
  const tests = [
    testExampleParsing,
    testSpecKitListFormat,
    testProjectPayload,
    testTemplates,
    testLiveThemes,
    testInlineFilesDependsNoCollision,
    testDuplicateTaskIdDedup,
    testNonPhaseHeadingIgnored,
    testDuplicatePhaseNamesDistinctIds,
    testSubChecklistDoesNotCompleteParent,
    testErrorMarkerPrecision,
    testCommitFileMatchBoundary,
    testNameStatusParsing,
    testClientRegressionCanaries
  ];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log('\nCodeViz smoke tests passed.');
}

run();
