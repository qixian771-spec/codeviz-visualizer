/**
 * server.js - HTTP + WebSocket 服务
 * 零 npm 依赖，用 Node 22 内置模块
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTasksMd, getStats } = require('./parser');
const { inferProgress } = require('./inferencer');

const PORT = 7878;
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

async function createProjectPayload(project, options = {}) {
  const { useGit = true, useFiles = true } = options;
  const content = fs.readFileSync(project.tasksPath, 'utf-8');
  const { phases, tasks } = parseTasksMd(content);
  const inferred = await inferProgress(tasks, project.root, { useGit, useFiles });
  const stats = getStats(inferred);

  return {
    projectId: project.id,
    projectName: project.name,
    tasksPath: project.tasksPath,
    phases,
    tasks: inferred,
    stats,
    timestamp: new Date().toISOString()
  };
}

function createServer(projectManager) {
  const clients = new Set(); // WebSocket 客户端

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;

    // API: 兼容旧前端：获取默认项目的任务导图
    // 旧版本 client.js 会请求 /api/map；保留该端点可以避免浏览器缓存旧 JS 时页面空白。
    if (pathname === '/api/map') {
      const project = projectManager.listProjects()[0];
      if (!project) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
      }
      try {
        const payload = await createProjectPayload(project);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'tasks.md not found at ' + project.tasksPath }));
      }
      return;
    }

    // API: 获取项目列表
    if (pathname === '/api/projects') {
      const projects = projectManager.listProjects().map(p => ({
        id: p.id,
        name: p.name,
        root: p.root,
        tasksPath: p.tasksPath
      }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ projects }));
      return;
    }

    // API: 获取某项目的任务
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      const project = projectManager.getProject(projectId);
      if (!project) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
      }
      try {
        const payload = await createProjectPayload(project);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'tasks.md not found at ' + project.tasksPath }));
      }
      return;
    }

    // 静态文件
    serveStatic(req, res);
  });

  // WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    handleWebSocket(req, socket);
  });

  function serveStatic(req, res) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(TEMPLATES_DIR, filePath);

    // 安全：禁止路径穿越
    if (!filePath.startsWith(TEMPLATES_DIR)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8'
      };
      res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.end(content);
    } catch (e) {
      res.statusCode = 404;
      res.end('Not found');
    }
  }

  function handleWebSocket(req, socket) {
    // 简单的 WebSocket 握手（Node 原生实现）
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const client = { socket };
    clients.add(client);

    socket.on('end', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));

    // 监听客户端消息（暂不处理）
    socket.on('data', () => {});
  }

  // 广播消息给所有客户端
  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      try {
        sendWebSocketFrame(client.socket, data);
      } catch (e) {
        clients.delete(client);
      }
    }
  }

  function sendWebSocketFrame(socket, data) {
    const payload = Buffer.from(data);
    const payloadLen = payload.length;

    let header;
    if (payloadLen < 126) {
      header = Buffer.alloc(2);
      header[1] = payloadLen;
    } else if (payloadLen < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(payloadLen, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(payloadLen / 0x100000000), 2);
      header.writeUInt32BE(payloadLen % 0x100000000, 6);
    }
    header[0] = 0x81; // FIN + text frame

    socket.write(Buffer.concat([header, payload]));
  }

  return { server, broadcast, clients };
}

module.exports = { createServer, createProjectPayload, PORT };
