/**
 * parser.js - 解析 tasks.md 成结构化任务数据
 * 兼容 Spec Kit 常见格式 + 通用 Markdown 任务列表。
 */

/**
 * 解析 tasks.md 文本成任务树
 * @param {string} content - tasks.md 文件内容
 * @returns {{phases: Array, tasks: Array}}
 */
function parseTasksMd(content) {
  const lines = content.split('\n');
  const phases = [];
  const tasks = [];
  let currentPhase = null;
  let currentTask = null;
  let taskIdCounter = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('<!--')) continue;

    // Phase 标题：## Phase X: xxx、## 阶段名。跳过二级标题里的 Tasks 总标题。
    const phaseMatch = trimmed.match(/^##\s+(?:Phase\s+\d+\s*[:：-]?\s*)?(.+)$/i);
    if (phaseMatch && !/^tasks\b/i.test(phaseMatch[1].trim())) {
      currentPhase = {
        id: `phase-${phases.length + 1}`,
        name: phaseMatch[1].trim(),
        tasks: []
      };
      phases.push(currentPhase);
      currentTask = null;
      continue;
    }

    // 标题式任务：### T001 - xxx 或 ### xxx
    const taskHeaderMatch = trimmed.match(/^###\s+(?:\[([ xX])\]\s*)?(?:\[([PT])\]\s*)?(?:T(\d+)\s*[-—:]\s*)?(.+)$/i);
    if (taskHeaderMatch) {
      const checkbox = taskHeaderMatch[1];
      const prefixFlag = taskHeaderMatch[2];
      const rawId = taskHeaderMatch[3];
      const rawName = taskHeaderMatch[4];
      currentTask = createTask({ rawId, rawName, checkbox, prefixFlag, currentPhase, line: i + 1, counter: taskIdCounter });
      taskIdCounter = currentTask._nextCounter;
      delete currentTask._nextCounter;
      tasks.push(currentTask);
      if (currentPhase) currentPhase.tasks.push(currentTask);
      continue;
    }

    // Spec Kit 常见清单式任务：- [ ] T001 [P] 任务标题 或 - [x] T001 - 任务标题
    const listTaskMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(?:\[([PT])\]\s*)?(?:T(\d+)\s*(?:[-—:]\s*)?)?(.+)$/i);
    if (listTaskMatch && looksLikeTaskLine(listTaskMatch[3], listTaskMatch[4])) {
      const checkbox = listTaskMatch[1];
      const prefixFlag = listTaskMatch[2];
      const rawId = listTaskMatch[3];
      const rawName = listTaskMatch[4];
      currentTask = createTask({ rawId, rawName, checkbox, prefixFlag, currentPhase, line: i + 1, counter: taskIdCounter });
      taskIdCounter = currentTask._nextCounter;
      delete currentTask._nextCounter;
      tasks.push(currentTask);
      if (currentPhase) currentPhase.tasks.push(currentTask);
      continue;
    }

    // 任务属性行：- files: xxx, - depends: T001
    if (currentTask && trimmed.startsWith('-')) {
      const attrMatch = trimmed.match(/^-\s+([\w-]+):\s*(.+)$/);
      if (attrMatch) {
        applyAttribute(currentTask, attrMatch[1], attrMatch[2]);
        continue;
      }

      // 任务补充描述：- [ ] xxx 或 - [x] xxx
      const checkboxMatch = trimmed.match(/^-\s+\[([ xX])\]\s*(.+)$/);
      if (checkboxMatch) {
        const isChecked = checkboxMatch[1].toLowerCase() === 'x';
        const desc = checkboxMatch[2].trim();
        if (isChecked) currentTask.status = 'done';
        appendDescription(currentTask, desc);
        continue;
      }
    }

    // 检测 FAILED / ERROR 标记
    if (currentTask && /\b(FAILED|ERROR|错误|失败|报错)\b/i.test(trimmed)) {
      currentTask.status = 'error';
      currentTask.errorMessage = trimmed;
    }
  }

  return { phases, tasks };
}

function createTask({ rawId, rawName, checkbox, prefixFlag, currentPhase, line, counter }) {
  const taskId = rawId ? `T${rawId.padStart(3, '0')}` : `T${String(counter).padStart(3, '0')}`;
  let taskName = String(rawName || '').trim();

  const isParallel = /\[P\]/i.test(taskName) || String(prefixFlag || '').toUpperCase() === 'P';
  taskName = taskName
    .replace(/\[P\]/gi, '')
    .replace(/^[-—:]\s*/, '')
    .trim();

  const fileHints = extractInlineList(taskName, /\bfiles?\s*[:：]\s*([^;；]+)/i);
  const depHints = extractInlineList(taskName, /\bdepends?\s*[:：]\s*([^;；]+)/i);
  taskName = taskName
    .replace(/\s*\(?\bfiles?\s*[:：]\s*[^;；)]+\)?/i, '')
    .replace(/\s*\(?\bdepends?\s*[:：]\s*[^;；)]+\)?/i, '')
    .trim();

  const isChecked = checkbox && checkbox.toLowerCase() === 'x';
  return {
    id: taskId,
    name: taskName || taskId,
    parallel: isParallel,
    files: fileHints,
    depends: depHints,
    status: isChecked ? 'done' : 'pending',
    description: '',
    phase: currentPhase ? currentPhase.id : null,
    line,
    _nextCounter: rawId ? Math.max(counter + 1, Number(rawId) + 1) : counter + 1
  };
}

function applyAttribute(task, key, value) {
  const normalizedKey = key.toLowerCase().replace(/-/g, '_');
  const cleanValue = value.trim();

  if (normalizedKey === 'files' || normalizedKey === 'file') {
    task.files = splitList(cleanValue);
  } else if (normalizedKey === 'depends' || normalizedKey === 'dependency' || normalizedKey === 'dependencies') {
    task.depends = splitList(cleanValue).map(normalizeTaskId);
  } else if (normalizedKey === 'done' || normalizedKey === 'done_when' || normalizedKey === 'donewhen') {
    task.doneWhen = cleanValue;
  } else if (normalizedKey === 'error' || normalizedKey === 'failed') {
    task.status = 'error';
    task.errorMessage = cleanValue;
  }
}

function looksLikeTaskLine(rawId, rawName) {
  if (rawId) return true;
  const name = String(rawName || '').trim();
  if (/^T\d{2,}\b/i.test(name)) return true;
  if (/\b(files?|depends?)\s*[:：]/i.test(name)) return true;
  return false;
}

function appendDescription(task, desc) {
  task.description = (task.description ? task.description + ' ' : '') + desc;
}

function extractInlineList(text, regex) {
  const match = String(text || '').match(regex);
  return match ? splitList(match[1]).map(item => /^T\d+$/i.test(item) ? normalizeTaskId(item) : item) : [];
}

function splitList(value) {
  return String(value || '')
    .split(/[,，]/)
    .map(item => item.trim().replace(/[)）\]]+$/g, ''))
    .filter(Boolean);
}

function normalizeTaskId(value) {
  const match = String(value || '').trim().match(/^T?(\d+)$/i);
  return match ? `T${match[1].padStart(3, '0')}` : String(value || '').trim();
}

/**
 * 构建任务树（基于 depends 字段）
 * @param {Array} tasks - 扁平任务列表
 * @returns {Array} 树形结构
 */
function buildTaskTree(tasks) {
  const taskMap = new Map();
  const roots = [];

  tasks.forEach(t => taskMap.set(t.id, { ...t, children: [] }));

  taskMap.forEach(task => {
    if (task.depends && task.depends.length > 0) {
      task.depends.forEach(depId => {
        const parent = taskMap.get(depId);
        if (parent) {
          parent.children.push(task);
        } else {
          roots.push(task);
        }
      });
    } else {
      roots.push(task);
    }
  });

  return roots;
}

/**
 * 统计任务状态
 * @param {Array} tasks
 * @returns {{pending: number, inProgress: number, done: number, error: number, total: number}}
 */
function getStats(tasks) {
  const stats = { pending: 0, inProgress: 0, done: 0, error: 0, total: tasks.length };
  tasks.forEach(t => {
    if (t.status === 'done') stats.done++;
    else if (t.status === 'in-progress') stats.inProgress++;
    else if (t.status === 'error') stats.error++;
    else stats.pending++;
  });
  return stats;
}

module.exports = { parseTasksMd, buildTaskTree, getStats };
