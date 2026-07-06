#!/usr/bin/env node
/**
 * smoke.test.js - CodeViz 零依赖冒烟测试
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseTasksMd, getStats } = require('../src/parser');
const { ProjectManager } = require('../src/project-manager');
const { createProjectPayload } = require('../src/server');

const root = path.resolve(__dirname, '..');
const exampleRoot = path.join(root, 'examples');
const templateIndex = path.join(root, 'templates', 'index.html');
const templateClient = path.join(root, 'templates', 'client.js');

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
  assert(client.includes('drawLines()'), 'client should draw SVG flow lines');
  assert(client.includes('applyTheme()'), 'client should support theme switching');
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

async function run() {
  const tests = [
    testExampleParsing,
    testSpecKitListFormat,
    testProjectPayload,
    testTemplates,
    testInlineFilesDependsNoCollision,
    testDuplicateTaskIdDedup,
    testNonPhaseHeadingIgnored,
    testDuplicatePhaseNamesDistinctIds
  ];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log('\nCodeViz smoke tests passed.');
}

run();
