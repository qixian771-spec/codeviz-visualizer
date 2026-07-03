/**
 * git-tracker.js - 抓 git commit 记录
 * 零依赖，用 child_process 调 git 命令
 */

const { execSync } = require('child_process');
const path = require('path');

/**
 * 获取项目最近 N 条 commit
 * @param {string} projectRoot - 项目根目录
 * @param {number} limit - 最多取多少条
 * @returns {Array<{hash: string, message: string, author: string, date: string, files: string[]}>}
 */
function getRecentCommits(projectRoot, limit = 50) {
  try {
    // 获取 commit 列表
    const logOutput = execSync(
      `git log --pretty=format:"%H|%an|%ad|%s" --date=iso -n ${limit}`,
      { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 }
    ).trim();

    if (!logOutput) return [];

    const commits = logOutput.split('\n').map(line => {
      const [hash, author, date, ...msgParts] = line.split('|');
      return {
        hash: hash.trim(),
        author: author.trim(),
        date: date.trim(),
        message: msgParts.join('|').trim()
      };
    });

    // 为每个 commit 获取变更文件
    return commits.map(commit => {
      try {
        const filesOutput = execSync(
          `git show --pretty="" --name-only ${commit.hash}`,
          { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 }
        ).trim();
        commit.files = filesOutput ? filesOutput.split('\n').map(f => f.trim()).filter(Boolean) : [];
      } catch (e) {
        commit.files = [];
      }
      return commit;
    });
  } catch (e) {
    // 不是 git 仓库或 git 命令失败
    return [];
  }
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
        const normTask = path.normalize(taskFile).toLowerCase();
        const normCommit = path.normalize(commitFile).toLowerCase();
        return normCommit === normTask || normCommit.endsWith(normTask) || normTask.endsWith(normCommit);
      })
    );
  }

  return false;
}

module.exports = { getRecentCommits, extractTaskIds, isCommitRelatedToTask };
