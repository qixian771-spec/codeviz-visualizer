#!/usr/bin/env node
/**
 * realtime.test.js - 验证 WebSocket 实时刷新广播
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ProjectManager } = require('../src/project-manager');
const { createServer } = require('../src/server');

const testDir = path.join(__dirname, 'temp-project');
const testTasksMd = path.join(testDir, 'tasks.md');

// 准备临时测试项目
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}
fs.writeFileSync(testTasksMd, `# Tasks: Demo
## Phase 1: Setup
- [ ] T001 Task 1
`);

async function testRealtimeBroadcast() {
  const manager = new ProjectManager();
  const project = manager.addProject(testDir);

  const { server, broadcast, clients } = createServer(manager);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`[test] 临时测试服务启动于端口 ${port}`);

  // 用原生 HTTP client 模拟 WebSocket 握手
  const wsKey = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    port,
    host: '127.0.0.1',
    path: '/ws', // 必须传 /ws 否则会被 server.on('upgrade') 里 if (req.url !== '/ws') 拒绝
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': wsKey,
      'Sec-WebSocket-Version': '13'
    }
  });

  const wsConnected = new Promise((resolve, reject) => {
    req.on('upgrade', (res, socket) => {
      // 成功握手
      resolve(socket);
    });
    req.on('error', reject);
  });
  req.end();

  const socket = await wsConnected;
  console.log('[test] WebSocket 模拟连接成功');

  // 等待握手完成，客户端列表同步
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(clients.size, 1, 'Server should have 1 connected client');

  // 模拟文件变化，触发广播
  const messagePromise = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      // 解析 WebSocket 帧的文本内容（简化解析：不带 mask 的 text frame）
      if (chunk[0] === 0x81) {
        let len = chunk[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          len = chunk.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          len = chunk.readUInt32BE(6); // 忽略高位直接读低 32 位
          offset = 10;
        }
        const data = chunk.slice(offset, offset + len).toString('utf-8');
        resolve(JSON.parse(data));
      }
    });
  });

  // 触发广播
  broadcast({
    type: 'tasks.updated',
    projectId: project.id,
    projectName: project.name,
    tasks: [{ id: 'T001', name: 'Task 1', status: 'in-progress' }]
  });

  const received = await messagePromise;
  assert.strictEqual(received.type, 'tasks.updated');
  assert.strictEqual(received.projectId, project.id);
  assert.strictEqual(received.tasks[0].status, 'in-progress');
  console.log('✓ WebSocket broadcast verified successfully');

  // 清理
  socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(testDir, { recursive: true, force: true });
}

// 构造带 mask 的客户端帧（客户端 -> 服务端方向必须 mask）
function maskFrame(opcode, payloadBuf) {
  const mask = crypto.randomBytes(4);
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Regression: server must answer client ping with pong, and drop the client on close.
async function testWebSocketControlFrames() {
  const frameDir = path.join(__dirname, 'temp-ws-control');
  if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });
  fs.writeFileSync(path.join(frameDir, 'tasks.md'), '# Tasks: X\n## Phase 1\n- [ ] T001 Task\n');

  const manager = new ProjectManager();
  manager.addProject(frameDir);
  const { server, clients } = createServer(manager);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const wsKey = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    port,
    host: '127.0.0.1',
    path: '/ws',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': wsKey,
      'Sec-WebSocket-Version': '13'
    }
  });
  const socket = await new Promise((resolve, reject) => {
    req.on('upgrade', (res, s) => resolve(s));
    req.on('error', reject);
    req.end();
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(clients.size, 1, 'control-frame test: should have 1 client');

  // ping -> pong
  const pongPromise = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      if ((chunk[0] & 0x0f) === 0xA) resolve('pong');
    });
  });
  socket.write(maskFrame(0x9, Buffer.from('hi')));
  const gotPong = await Promise.race([
    pongPromise,
    new Promise((r) => setTimeout(() => r('timeout'), 1000))
  ]);
  assert.strictEqual(gotPong, 'pong', 'server should reply pong to client ping');

  // close -> cleanup
  socket.write(maskFrame(0x8, Buffer.alloc(0)));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(clients.size, 0, 'server should drop client on close frame');
  console.log('\u2713 WebSocket control frames (ping/pong/close) verified');

  try { socket.destroy(); } catch (e) {}
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(frameDir, { recursive: true, force: true });
}

testRealtimeBroadcast()
  .then(() => testWebSocketControlFrames())
  .then(() => {
    console.log('CodeViz realtime refresh tests passed.');
  }).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
