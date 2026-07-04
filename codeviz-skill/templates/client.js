/**
 * client.js - CodeViz 实时进度导图前端
 * 零依赖，负责项目选择、任务渲染、自动布局、SVG 流动连线和 WebSocket 更新。
 */

class CodeVizClient {
  constructor() {
    this.ws = null;
    this.projects = [];
    this.currentProjectId = null;
    this.currentProjectName = '';
    this.phases = [];
    this.tasks = [];
    this.stats = { total: 0, done: 0, pending: 0, inProgress: 0, error: 0 };
    this.reconnectDelay = 1000;
    this.lastStatusById = new Map();
    this.resizeTimer = null;
    this.themeChoice = localStorage.getItem('codeviz-theme') || 'system';

    this.dom = {
      projectSelect: document.getElementById('project-select'),
      stats: document.getElementById('stats'),
      ringFill: document.getElementById('ring-fill'),
      ringText: document.getElementById('ring-text'),
      conn: document.getElementById('conn'),
      status: document.getElementById('status'),
      canvas: document.getElementById('canvas'),
      phaseLayer: document.getElementById('phase-layer'),
      nodeLayer: document.getElementById('node-layer'),
      linesGroup: document.getElementById('flow-lines'),
      particlesGroup: document.getElementById('flow-particles'),
      error: document.getElementById('error'),
      themeToggle: document.getElementById('theme-toggle')
    };
  }

  async start() {
    this.applyTheme();
    this.bindEvents();
    await this.loadProjects();
    this.connect();
  }

  bindEvents() {
    if (this.dom.projectSelect) {
      this.dom.projectSelect.addEventListener('change', () => {
        this.loadProject(this.dom.projectSelect.value);
      });
    }

    if (this.dom.themeToggle) {
      this.dom.themeToggle.addEventListener('click', (event) => {
        const button = event.target.closest('[data-theme-choice]');
        if (!button) return;
        this.themeChoice = button.dataset.themeChoice;
        localStorage.setItem('codeviz-theme', this.themeChoice);
        this.applyTheme();
      });
    }

    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    systemTheme.addEventListener('change', () => {
      if (this.themeChoice === 'system') this.applyTheme();
    });

    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        // 窗口宽度变化可能触发宽/窄布局切换，需要完整重排
        if (this.tasks.length) {
          this.render(false);
        } else {
          this.drawLines();
        }
      }, 150);
    });
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.setStatus('实时', 'online');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        this.showError('实时消息解析失败: ' + e.message);
      }
    };

    this.ws.onclose = () => {
      this.setStatus('重连中', 'connecting');
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 5000);
    };

    this.ws.onerror = () => {
      this.setStatus('离线', 'offline');
    };
  }

  handleMessage(msg) {
    if (msg.type !== 'tasks.updated') return;
    if (this.currentProjectId && msg.projectId !== this.currentProjectId) return;

    this.currentProjectId = msg.projectId;
    this.currentProjectName = msg.projectName || this.currentProjectName;
    this.phases = Array.isArray(msg.phases) ? msg.phases : this.groupPhasesFromTasks(msg.tasks || []);
    this.tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
    this.stats = msg.stats || this.computeStats(this.tasks);
    this.hideError();
    this.render(true);
  }

  async loadProjects() {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      this.projects = data.projects || [];
      this.renderProjectSelect();

      if (this.projects.length > 0) {
        await this.loadProject(this.projects[0].id);
      } else {
        this.renderEmpty('还没有项目', '启动 CodeViz 时传入一个项目目录，例如 node bin/codeviz.js /path/to/project');
      }
    } catch (e) {
      this.showError('项目列表加载失败: ' + e.message);
    }
  }

  renderProjectSelect() {
    if (!this.dom.projectSelect) return;
    if (this.projects.length === 0) {
      this.dom.projectSelect.innerHTML = '<option>无项目</option>';
      return;
    }

    this.dom.projectSelect.innerHTML = this.projects.map(project => (
      `<option value="${this.escapeAttr(project.id)}">${this.escape(project.name)}</option>`
    )).join('');
  }

  async loadProject(projectId) {
    if (!projectId) return;
    this.currentProjectId = projectId;
    if (this.dom.projectSelect) this.dom.projectSelect.value = projectId;

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
      const data = await res.json();
      if (!res.ok || data.error) {
        this.showError(data.error || '任务加载失败');
        this.renderEmpty('找不到 tasks.md', data.error || '请先在项目根目录或 specs 目录创建 tasks.md');
        return;
      }

      this.currentProjectName = data.projectName || '';
      this.phases = Array.isArray(data.phases) ? data.phases : this.groupPhasesFromTasks(data.tasks || []);
      this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      this.stats = data.stats || this.computeStats(this.tasks);
      this.hideError();
      this.render(false);
    } catch (e) {
      this.showError('任务加载失败: ' + e.message);
    }
  }

  render(animateChanges = false) {
    this.renderStats();
    this.renderMap(animateChanges);
  }

  renderStats() {
    const stats = this.stats || this.computeStats(this.tasks);
    const total = stats.total || 0;
    const done = stats.done || 0;
    const inProgress = stats.inProgress || 0;
    const error = stats.error || 0;
    const pending = Math.max(0, stats.pending ?? (total - done - inProgress - error));
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;

    if (this.dom.stats) {
      this.dom.stats.innerHTML = `
        <div class="stat-pill done"><span class="dot"></span>完成 <span class="num">${done}</span></div>
        <div class="stat-pill progress"><span class="dot"></span>进行中 <span class="num">${inProgress}</span></div>
        <div class="stat-pill error"><span class="dot"></span>报错 <span class="num">${error}</span></div>
        <div class="stat-pill pending"><span class="dot"></span>未开始 <span class="num">${pending}</span></div>
      `;
    }

    if (this.dom.ringFill) {
      const circumference = 113.1;
      const offset = circumference - (circumference * percent / 100);
      this.dom.ringFill.setAttribute('stroke-dashoffset', String(offset));
    }
    if (this.dom.ringText) this.dom.ringText.textContent = `${percent}%`;
  }

  renderMap(animateChanges) {
    if (!this.dom.canvas || !this.dom.phaseLayer || !this.dom.nodeLayer) return;

    this.dom.phaseLayer.innerHTML = '';
    this.dom.nodeLayer.innerHTML = '';
    this.clearLines();

    if (!this.tasks.length) {
      this.renderEmpty('还没有任务', '先创建或导入 Spec Kit 的 tasks.md，CodeViz 就会把它变成进度图。');
      return;
    }

    this.removeEmpty();

    const layout = this.computeLayout();

    // 设置 canvas 内容层的最小高度，确保能容纳所有节点
    const contentHeight = layout.contentHeight || 0;
    this.dom.canvas.style.minHeight = contentHeight + 'px';
    this.dom.phaseLayer.style.height = contentHeight + 'px';
    this.dom.nodeLayer.style.height = contentHeight + 'px';

    // SVG 也要跟着撑高
    const flowSvg = this.dom.canvas.querySelector('.flow');
    if (flowSvg) {
      flowSvg.style.height = contentHeight + 'px';
    }

    layout.phases.forEach(phaseBox => this.dom.phaseLayer.appendChild(this.createPhaseElement(phaseBox)));
    layout.nodes.forEach((nodeBox, index) => this.dom.nodeLayer.appendChild(this.createNodeElement(nodeBox, index, animateChanges)));

    requestAnimationFrame(() => this.drawLines());
    this.lastStatusById = new Map(this.tasks.map(task => [task.id, this.normalizeStatus(task.status)]));
  }

  computeLayout() {
    const phaseSource = this.normalizePhases();
    const phaseCount = Math.max(phaseSource.length, 1);

    // 像素常量
    const NODE_HEIGHT = 95;       // 节点卡片高度（含 padding）
    const NODE_GAP = 12;          // 节点之间最小垂直间距
    const NODE_STEP = NODE_HEIGHT + NODE_GAP;  // 每个节点占的垂直空间
    const PHASE_TOP_PAD = 46;     // Phase 区域内，第一个节点距顶部（留空给 label）
    const PHASE_BOTTOM_PAD = 20;  // Phase 区域底部留白
    const CANVAS_TOP = 10;        // 距 canvas 顶部的初始间距
    const SECTION_GAP = 18;       // 窄屏单列模式下 Phase 之间的间距

    const canvasWidth = this.dom.canvas ? this.dom.canvas.clientWidth : window.innerWidth;
    const narrowMode = canvasWidth < 760;

    const phases = [];
    const nodes = [];
    let maxContentBottom = 0;

    if (narrowMode) {
      // 小窗口/内嵌预览：纵向单列，节点用像素宽度确保不溢出。
      const phaseLeft = 0;
      const phaseWidth = 100;
      const canvasPad = 16;
      const nodeWidth = Math.max(120, Math.min(220, canvasWidth - canvasPad * 2 - 20));
      const nodeLeft = canvasPad;
      let currentTop = CANVAS_TOP;

      phaseSource.forEach((phase, phaseIndex) => {
        const phaseTasks = this.tasks.filter(task => (task.phase || 'phase-1') === phase.id);
        const phaseStatus = this.getPhaseStatus(phaseTasks);
        const taskCount = Math.max(phaseTasks.length, 1);
        const phaseContentHeight = PHASE_TOP_PAD + taskCount * NODE_STEP + PHASE_BOTTOM_PAD;

        phases.push({
          ...phase,
          left: phaseLeft,
          topPx: currentTop,
          width: phaseWidth,
          heightPx: phaseContentHeight,
          status: phaseStatus
        });

        phaseTasks.forEach((task, taskIndex) => {
          const nodeTopPx = currentTop + PHASE_TOP_PAD + taskIndex * NODE_STEP;
          nodes.push({
            task,
            phase,
            left: nodeLeft,
            topPx: nodeTopPx,
            width: nodeWidth,
            narrowMode: true,
            delay: phaseIndex * 90 + taskIndex * 55
          });
          maxContentBottom = Math.max(maxContentBottom, nodeTopPx + NODE_HEIGHT);
        });

        maxContentBottom = Math.max(maxContentBottom, currentTop + phaseContentHeight);
        currentTop += phaseContentHeight + SECTION_GAP;
      });

      return { phases, nodes, contentHeight: maxContentBottom + 90, narrowMode };
    }

    // 宽屏：横向阶段布局
    const gapPercent = phaseCount > 6 ? 1 : (phaseCount > 4 ? 2 : 3);
    const side = 1;
    const widthPercent = Math.max(14, (100 - side * 2 - gapPercent * (phaseCount - 1)) / phaseCount);

    phaseSource.forEach((phase, phaseIndex) => {
      const left = side + phaseIndex * (widthPercent + gapPercent);
      const phaseTasks = this.tasks.filter(task => (task.phase || 'phase-1') === phase.id);
      const phaseStatus = this.getPhaseStatus(phaseTasks);
      const taskCount = Math.max(phaseTasks.length, 1);

      // Phase 高度由任务数决定（像素）
      const phaseContentHeight = PHASE_TOP_PAD + taskCount * NODE_STEP + PHASE_BOTTOM_PAD;

      phases.push({
        ...phase,
        left,
        topPx: CANVAS_TOP,
        width: widthPercent,
        heightPx: phaseContentHeight,
        status: phaseStatus
      });

      // 节点左偏移（百分比）
      const nodeLeft = left + Math.max(1.0, Math.min(3.0, widthPercent * 0.15));

      phaseTasks.forEach((task, taskIndex) => {
        const nodeTopPx = CANVAS_TOP + PHASE_TOP_PAD + taskIndex * NODE_STEP;
        nodes.push({
          task,
          phase,
          left: nodeLeft,
          topPx: nodeTopPx,
          delay: phaseIndex * 90 + taskIndex * 55
        });
        maxContentBottom = Math.max(maxContentBottom, nodeTopPx + NODE_HEIGHT);
      });

      maxContentBottom = Math.max(maxContentBottom, CANVAS_TOP + phaseContentHeight);
    });

    // 内容总高度（给 canvas 滚动用）
    const contentHeight = maxContentBottom + 40; // 底部多留 40px

    return { phases, nodes, contentHeight, narrowMode };
  }

  normalizePhases() {
    if (this.phases && this.phases.length) {
      return this.phases.map((phase, index) => ({
        id: phase.id || `phase-${index + 1}`,
        name: this.cleanPhaseName(phase.name || `Phase ${index + 1}`)
      }));
    }

    const grouped = this.groupPhasesFromTasks(this.tasks);
    return grouped.length ? grouped : [{ id: 'phase-1', name: '任务' }];
  }

  groupPhasesFromTasks(tasks) {
    const ids = Array.from(new Set((tasks || []).map(task => task.phase || 'phase-1')));
    return ids.map((id, index) => ({ id, name: `Phase ${index + 1}` }));
  }

  getPhaseStatus(tasks) {
    if (!tasks.length) return 'pending';
    if (tasks.some(task => this.normalizeStatus(task.status) === 'error')) return 'blocked';
    if (tasks.some(task => this.normalizeStatus(task.status) === 'in-progress')) return 'active';
    if (tasks.every(task => this.normalizeStatus(task.status) === 'done')) return 'complete';
    return 'pending';
  }

  createPhaseElement(phaseBox) {
    const el = document.createElement('div');
    el.className = `phase-zone ${phaseBox.status === 'complete' ? 'complete' : phaseBox.status === 'active' ? 'active' : phaseBox.status === 'blocked' ? 'blocked' : ''}`;
    el.style.left = `${phaseBox.left}%`;
    el.style.top = `${phaseBox.topPx}px`;
    el.style.width = `${phaseBox.width}%`;
    el.style.height = `${phaseBox.heightPx}px`;
    el.innerHTML = `<span class="phase-zone-label"><span class="phase-dot"></span>${this.escape(this.formatPhaseLabel(phaseBox.name))}</span>`;
    return el;
  }

  createNodeElement(nodeBox, index, animateChanges) {
    const task = nodeBox.task;
    const status = this.normalizeStatus(task.status);
    const previousStatus = this.lastStatusById.get(task.id);
    const flash = animateChanges && previousStatus && previousStatus !== status ? ' flash' : '';
    const el = document.createElement('div');

    el.className = `node ${status}${flash}`;
    el.dataset.id = task.id;
    el.title = this.buildNodeTitle(task);

    // 窄屏单列模式下用像素定位宽度，避免百分比 + 固定 156px 冲突
    if (nodeBox.narrowMode) {
      el.style.left = `${nodeBox.left}px`;
      el.style.width = `${nodeBox.width}px`;
    } else {
      el.style.left = `${nodeBox.left}%`;
    }
    el.style.top = `${nodeBox.topPx}px`;
    el.style.animationDelay = `${nodeBox.delay || index * 45}ms`;

    const meta = this.getTaskMeta(task);
    const icon = this.getStatusIcon(status);
    el.innerHTML = `
      <span class="node-glow"></span>
      <div class="node-head">
        <span class="node-icon">${icon}</span>
        <span class="node-id">${this.escape(task.id || '')}</span>
        ${task.parallel ? '<span class="node-tag">P</span>' : ''}
      </div>
      <div class="node-name">${this.escape(task.name || task.description || '未命名任务')}</div>
      <div class="node-meta">${this.escape(meta)}</div>
    `;
    return el;
  }

  drawLines() {
    if (!this.dom.canvas || !this.dom.linesGroup || !this.dom.particlesGroup) return;
    this.clearLines();

    const canvasRect = this.dom.canvas.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) return;

    let lineIndex = 0;
    const tasksById = new Map(this.tasks.map(task => [task.id, task]));

    this.tasks.forEach(toTask => {
      const dependencies = Array.isArray(toTask.depends) ? toTask.depends : [];
      dependencies.forEach(fromId => {
        const fromTask = tasksById.get(fromId);
        if (!fromTask) return;

        const fromNode = this.dom.nodeLayer.querySelector(`[data-id="${CSS.escape(fromId)}"]`);
        const toNode = this.dom.nodeLayer.querySelector(`[data-id="${CSS.escape(toTask.id)}"]`);
        if (!fromNode || !toNode) return;

        const fromRect = fromNode.getBoundingClientRect();
        const toRect = toNode.getBoundingClientRect();
        const fromX = fromRect.left + fromRect.width / 2 - canvasRect.left;
        const fromY = fromRect.top + fromRect.height / 2 - canvasRect.top;
        const toX = toRect.left + toRect.width / 2 - canvasRect.left;
        const toY = toRect.top + toRect.height / 2 - canvasRect.top;
        const dx = toX - fromX;
        const cp1x = fromX + dx * 0.52;
        const cp1y = fromY;
        const cp2x = toX - dx * 0.52;
        const cp2y = toY;
        const d = `M ${fromX} ${fromY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${toX} ${toY}`;
        const status = this.normalizeStatus(toTask.status);

        const path = this.createSvg('path', {
          d,
          id: `flow-${lineIndex}`,
          class: `flow-line ${status === 'in-progress' ? 'active' : status}`
        });
        const marker = status === 'error' ? 'url(#arr-error)' : status === 'in-progress' ? 'url(#arr-active)' : status === 'done' ? '' : 'url(#arr-flow)';
        if (marker) path.setAttribute('marker-end', marker);
        this.dom.linesGroup.appendChild(path);

        if (status !== 'done') {
          const count = status === 'in-progress' || status === 'error' ? 2 : 1;
          const duration = status === 'in-progress' ? 1500 : status === 'error' ? 1200 : 3000;
          for (let i = 0; i < count; i++) {
            const particle = this.createSvg('circle', {
              r: '2.5',
              class: `flow-particle ${status === 'in-progress' ? 'active' : status === 'error' ? 'error' : ''}`
            });
            const motion = this.createSvg('animateMotion', {
              dur: `${duration}ms`,
              repeatCount: 'indefinite',
              path: d,
              begin: `${i * (duration / count)}ms`
            });
            particle.appendChild(motion);
            this.dom.particlesGroup.appendChild(particle);
          }
        }

        lineIndex++;
      });
    });
  }

  clearLines() {
    if (this.dom.linesGroup) this.dom.linesGroup.innerHTML = '';
    if (this.dom.particlesGroup) this.dom.particlesGroup.innerHTML = '';
  }

  createSvg(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    return el;
  }

  renderEmpty(title, detail) {
    this.removeEmpty();
    this.clearLines();
    if (this.dom.phaseLayer) this.dom.phaseLayer.innerHTML = '';
    if (this.dom.nodeLayer) this.dom.nodeLayer.innerHTML = '';
    if (!this.dom.canvas) return;

    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = `<strong>${this.escape(title)}</strong><span>${this.escape(detail)}</span>`;
    this.dom.canvas.appendChild(el);
    this.renderStats();
  }

  removeEmpty() {
    if (!this.dom.canvas) return;
    this.dom.canvas.querySelectorAll('.empty').forEach(el => el.remove());
  }

  getTaskMeta(task) {
    if (task.errorMessage) return String(task.errorMessage).replace(/^[-\s]*/, '').slice(0, 34);
    if (task.relatedCommits && task.relatedCommits.length) return `${task.relatedCommits.length} commits`;
    if (task.fileStats) return `${task.fileStats.existing}/${task.fileStats.total} 文件`;
    if (task.files && task.files.length) return `${task.files.length} 文件`;
    if (task.lastCommitDate) return task.lastCommitDate.substring(0, 10);
    return task.description || '等待开始';
  }

  getStatusIcon(status) {
    return {
      pending: '○',
      'in-progress': '◐',
      done: '✓',
      error: '✕'
    }[status] || '○';
  }

  normalizeStatus(status) {
    if (status === 'inProgress') return 'in-progress';
    if (status === 'in-progress' || status === 'done' || status === 'error') return status;
    return 'pending';
  }

  computeStats(tasks) {
    const stats = { total: tasks.length, done: 0, pending: 0, inProgress: 0, error: 0 };
    tasks.forEach(task => {
      const status = this.normalizeStatus(task.status);
      if (status === 'done') stats.done++;
      else if (status === 'in-progress') stats.inProgress++;
      else if (status === 'error') stats.error++;
      else stats.pending++;
    });
    return stats;
  }

  cleanPhaseName(name) {
    return String(name).replace(/^Phase\s+\d+\s*[:：-]?\s*/i, '').trim() || name;
  }

  formatPhaseLabel(name) {
    const index = this.normalizePhases().findIndex(phase => phase.name === name);
    return index >= 0 ? `Phase ${index + 1} · ${name}` : name;
  }

  buildNodeTitle(task) {
    const lines = [
      `${task.id} - ${task.name}`,
      `状态: ${this.normalizeStatus(task.status)}`
    ];
    if (task.description) lines.push(task.description);
    if (task.files && task.files.length) lines.push('文件: ' + task.files.join(', '));
    if (task.depends && task.depends.length) lines.push('依赖: ' + task.depends.join(', '));
    return lines.join('\n');
  }

  applyTheme() {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = this.themeChoice === 'system' ? (systemDark ? 'dark' : 'light') : this.themeChoice;
    document.documentElement.dataset.theme = resolved;

    if (this.dom.themeToggle) {
      // 容错处理：不仅寻找子按钮，如果 themeToggle 本身有 data-theme-choice，也一并处理
      const buttons = Array.from(this.dom.themeToggle.querySelectorAll('[data-theme-choice]'));
      if (this.dom.themeToggle.hasAttribute('data-theme-choice')) {
        buttons.push(this.dom.themeToggle);
      }
      buttons.forEach(button => {
        button.classList.toggle('active', button.dataset.themeChoice === this.themeChoice);
      });
    }
  }

  setStatus(text, mode) {
    if (this.dom.status) this.dom.status.textContent = text;
    if (this.dom.conn) {
      this.dom.conn.classList.remove('offline', 'connecting');
      if (mode === 'offline') this.dom.conn.classList.add('offline');
      if (mode === 'connecting') this.dom.conn.classList.add('connecting');
    }
  }

  showError(message) {
    if (!this.dom.error) return;
    this.dom.error.textContent = message;
    this.dom.error.style.display = 'block';
  }

  hideError() {
    if (!this.dom.error) return;
    this.dom.error.style.display = 'none';
  }

  escape(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  escapeAttr(value) {
    return this.escape(value).replace(/"/g, '&quot;');
  }
}

window.codevizClient = new CodeVizClient();
window.codevizClient.start();
