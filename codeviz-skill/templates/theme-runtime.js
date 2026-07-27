/**
 * Shared live-data shell for the four visual themes.
 * The server injects __CODEVIZ_THEME_DATA__ before each theme's renderer runs.
 */
(function () {
  'use strict';

  const data = window.__CODEVIZ_THEME_DATA__;
  const themeKey = window.__CODEVIZ_THEME_KEY__;
  if (!data || !themeKey) return;

  const THEMES = [
    ['formation', '周天星阵'],
    ['ascension', '飞升天梯'],
    ['constellation', '星灵觉醒'],
    ['starforge', '星核锻造']
  ];

  document.documentElement.dataset.liveTheme = themeKey;
  document.body.classList.add('codeviz-live-theme');

  // The concept art uses a 1600×900 coordinate system. Fit that canvas to the
  // actual browser instead of cropping it on smaller screens.
  let canvas = document.querySelector('#stage, .stage');
  if (!canvas) {
    canvas = document.createElement('div');
    canvas.className = 'cv-theme-canvas';
    for (const node of [...document.body.childNodes]) canvas.appendChild(node);
    document.body.appendChild(canvas);
  }
  canvas.classList.add('cv-theme-canvas');
  Object.assign(canvas.style, {
    position: 'absolute',
    right: 'auto',
    bottom: 'auto',
    width: '1600px',
    height: '900px',
    transformOrigin: '0 0'
  });
  Object.assign(document.documentElement.style, {
    width: '100%',
    height: '100%',
    overflow: 'hidden'
  });
  Object.assign(document.body.style, {
    width: '100%',
    height: '100%',
    overflow: 'hidden'
  });

  let resizeFrame = 0;
  function fitThemeCanvas() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const scale = Math.min(innerWidth / 1600, innerHeight / 900);
      const fittedWidth = 1600 * scale;
      const fittedHeight = 900 * scale;
      canvas.style.left = `${Math.max(0, (innerWidth - fittedWidth) / 2)}px`;
      canvas.style.top = `${Math.max(0, (innerHeight - fittedHeight) / 2)}px`;
      canvas.style.transform = `scale(${scale})`;
      document.documentElement.style.setProperty('--cv-theme-scale', String(scale));
    });
  }
  fitThemeCanvas();
  addEventListener('resize', fitThemeCanvas, { passive: true });

  const style = document.createElement('style');
  style.textContent = `
    .cv-live-controls{position:fixed;z-index:100;left:50%;top:70px;transform:translateX(-50%);
      display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:999px;
      color:#dce7f4;background:rgba(5,9,17,.82);border:1px solid rgba(147,170,205,.26);
      box-shadow:0 8px 28px rgba(0,0,0,.32);backdrop-filter:blur(16px);
      font:12px/1.2 -apple-system,"PingFang SC","Helvetica Neue",sans-serif}
    .cv-live-controls select,.cv-live-controls a{height:27px;border-radius:999px;
      border:1px solid rgba(147,170,205,.24);background:rgba(20,28,43,.88);color:#dce7f4;
      padding:0 25px 0 10px;font:inherit;text-decoration:none;outline:none}
    .cv-live-controls a{display:inline-flex;align-items:center;padding:0 11px}
    .cv-live-controls select:focus-visible,.cv-live-controls a:focus-visible{
      border-color:#2ee6a8;box-shadow:0 0 0 2px rgba(46,230,168,.18)}
    .cv-live-state{display:inline-flex;align-items:center;gap:6px;padding:0 4px;color:#9fb2c8}
    .cv-live-dot{width:7px;height:7px;border-radius:50%;background:#ffc65c;
      box-shadow:0 0 8px rgba(255,198,92,.75)}
    .cv-live-state.online .cv-live-dot{background:#2ee6a8;box-shadow:0 0 9px rgba(46,230,168,.8)}
    .cv-live-state.offline .cv-live-dot{background:#ff6b6b;box-shadow:0 0 9px rgba(255,107,107,.75)}
    @media(max-width:900px){.cv-live-controls{top:68px;max-width:calc(100vw - 20px);flex-wrap:wrap;
      justify-content:center;border-radius:16px}}
  `;
  document.head.appendChild(style);

  const controls = document.createElement('div');
  controls.className = 'cv-live-controls';
  controls.setAttribute('aria-label', 'CodeViz 实时主题控制');

  const projectSelect = document.createElement('select');
  projectSelect.setAttribute('aria-label', '选择项目');

  const themeSelect = document.createElement('select');
  themeSelect.setAttribute('aria-label', '选择视觉主题');
  for (const [id, name] of THEMES) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    option.selected = id === themeKey;
    themeSelect.appendChild(option);
  }

  const liveState = document.createElement('span');
  liveState.className = 'cv-live-state';
  liveState.innerHTML = '<i class="cv-live-dot"></i><span>连接中</span>';

  const mapLink = document.createElement('a');
  mapLink.href = '/';
  mapLink.textContent = '标准导图';

  controls.append(projectSelect, themeSelect, liveState, mapLink);
  document.body.appendChild(controls);

  const selectedProjectId = data.projectId;
  const targetUrl = (nextTheme, projectId) =>
    `/theme/${encodeURIComponent(nextTheme)}?project=${encodeURIComponent(projectId)}`;

  themeSelect.addEventListener('change', () => {
    location.href = targetUrl(themeSelect.value, projectSelect.value || selectedProjectId);
  });
  projectSelect.addEventListener('change', () => {
    location.href = targetUrl(themeKey, projectSelect.value);
  });

  fetch('/api/projects')
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((result) => {
      projectSelect.textContent = '';
      for (const project of result.projects || []) {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name;
        option.selected = project.id === selectedProjectId;
        projectSelect.appendChild(option);
      }
    })
    .catch(() => {
      const option = document.createElement('option');
      option.value = selectedProjectId;
      option.textContent = data.projectName || '当前项目';
      projectSelect.replaceChildren(option);
    });

  let reconnectDelay = 1000;
  let reloadTimer = null;

  function setConnection(label, state) {
    liveState.className = `cv-live-state ${state}`;
    liveState.querySelector('span').textContent = label;
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);

    socket.addEventListener('open', () => {
      reconnectDelay = 1000;
      setConnection('实时数据', 'online');
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (message.type !== 'tasks.updated' || message.projectId !== selectedProjectId) return;
      setConnection('正在更新', 'online');
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => location.reload(), 180);
    });
    socket.addEventListener('close', () => {
      setConnection('重新连接', 'offline');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(Math.round(reconnectDelay * 1.5), 5000);
    });
    socket.addEventListener('error', () => setConnection('连接异常', 'offline'));
  }

  connect();
  window.__CODEVIZ_LIVE_READY__ = true;
})();
