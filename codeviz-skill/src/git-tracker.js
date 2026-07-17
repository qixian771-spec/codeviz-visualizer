/**
 * git-tracker.js - 抓 git commit 记录
 * 零依赖，用 child_process 调 git 命令
 */

const { execFile } = require('child_process');
const path = require('path');

/**
 * 内存缓存：key 为 projectRoot，value 为 { data, ts }
 * @type {Map<string, {data: Array, ts: number}>}
 */
const _commitCache = new Map();

/** 缓存有效期（毫秒） */
const CACHE_TTL = 5000;

/**
 * 清除指定项目的 commit 缓存
 * @param {string} projectRoot - 项目根目录
 */
function clearCommitCache(projectRoot) {
  _commitCache.delete(projectRoot);
}

/**
 * execFile 的 Promise 包装
 * @param {string} file
 * @param {string[]} args
 * @param {Object} options
 * @returns {Promise<string>}
 */
function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

/**
 * 获取项目最近 N 条 commit
 * @param {string} projectRoot - 项目根目录
 * @param {number} limit - 最多取多少条
 * @returns {Promise<Array<{hash: string, message: string, author: string, date: string, files: string[]}>>}
 */
async function getRecentCommits(projectRoot, limit = 50) {
  // 检查缓存
  const cached = _commitCache.get(projectRoot);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached.data;
  }

  try {
    const logOutput = await execFileAsync(
      'git',
      ['log', '--name-status', '--pretty=format:COMMIT:%H|%an|%ad|%s', '-n', String(limit)],
      { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 }
    );

    const commits = parseNameStatus(logOutput);

    // 写入缓存
    _commitCache.set(projectRoot, { data: commits, ts: Date.now() });
    return commits;
  } catch (e) {
    // 不是 git 仓库或 git 命令失败
    return [];
  }
}

/**
 * 解析 git log --name-status 输出成 commit 数组
 * @param {string} logOutput
 * @returns {Array<{hash: string, message: string, author: string, date: string, files: string[]}>}
 */
function parseNameStatus(logOutput) {
  const trimmed = (logOutput || '').trim();
  if (!trimmed) return [];

  const commits = [];
  let currentCommit = null;

  for (const line of trimmed.split('\n')) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) continue;

    if (lineTrimmed.startsWith('COMMIT:')) {
      const payload = lineTrimmed.substring(7);
      const [hash, author, date, ...msgParts] = payload.split('|');
      currentCommit = {
        hash: hash.trim(),
        author: author.trim(),
        date: date.trim(),
        message: msgParts.join('|').trim(),
        files: []
      };
      commits.push(currentCommit);
    } else if (currentCommit) {
      // --name-status 行形如 "M\tpath" 或 "R100\told\tnew"；
      // 路径可能含空格，必须按 \t 切分；rename/copy 把旧、新路径都记上
      const parts = lineTrimmed.split('\t');
      if (parts.length >= 2) {
        for (const p of parts.slice(1)) {
          const file = p.trim();
          if (file) currentCommit.files.push(file);
        }
      } else {
        currentCommit.files.push(lineTrimmed);
      }
    }
  }

  return commits;
}

/**
 * 从 commit 消息中提取任务 ID
 * 支持 T001、T01、T1 等格式
 * @param {string} message
 * @returns {Array<string>}
 */
function extractTaskIds(message) {
  const ids = [];
  const regex = /T0*(\d+)/gi;
  let match;
  while ((match = regex.exec(message)) !== null) {
    ids.push(`T${match[1].padStart(3, '0')}`);
  }
  return ids;
}

/**
 * 判断 commit 是否跟某个任务相关
 * @param {Object} commit
 * @param {Object} task - { id, files }
 * @returns {boolean}
 */
function isCommitRelatedToTask(commit, task) {
  // 1. commit 消息提到任务 ID
  const idsInMessage = extractTaskIds(commit.message);
  if (idsInMessage.includes(task.id)) return true;

  // 2. commit 改了任务关联的文件
  if (task.files && task.files.length > 0) {
    return task.files.some(taskFile =>
      commit.files.some(commitFile => {
        const normTask = normalizePathForMatch(taskFile);
        const normCommit = normalizePathForMatch(commitFile);
        // 相等，或 commit 路径在路径段边界上以任务文件结尾
        // （git 输出是仓库根相对路径，任务文件通常是项目相对路径，可能更浅）。
        // 不做反向后缀匹配：裸 endsWith 会让 latest.js 撞上 test.js 这类误报。
        return normCommit === normTask || normCommit.endsWith('/' + normTask);
      })
    );
  }

  return false;
}

function normalizePathForMatch(p) {
  return path.normalize(String(p)).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

module.exports = { getRecentCommits, parseNameStatus, extractTaskIds, isCommitRelatedToTask, clearCommitCache };
