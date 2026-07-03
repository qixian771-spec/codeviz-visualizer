/**
 * inferencer.js - 自动推断任务进度
 * 综合三个信号：手动标记（tasks.md）> git commit > 文件存在
 */

const fs = require('fs');
const path = require('path');
const { getRecentCommits, isCommitRelatedToTask } = require('./git-tracker');

/**
 * 推断所有任务的当前状态
 * @param {Array} tasks - 解析出来的任务列表
 * @param {string} projectRoot - 项目根目录
 * @param {Object} options - { useGit: true, useFiles: true }
 * @returns {Array} 更新状态后的任务列表
 */
function inferProgress(tasks, projectRoot, options = {}) {
  const { useGit = true, useFiles = true } = options;

  // 先拿一次 git commits，复用
  const commits = useGit ? getRecentCommits(projectRoot, 100) : [];

  return tasks.map(task => {
    const inferred = { ...task };

    // 优先级 1：tasks.md 里的手动标记（done / error 已经被 parser 标了）
    // 如果已经是 done 或 error，直接保留
    if (inferred.status === 'done' || inferred.status === 'error') {
      return inferred;
    }

    // 优先级 2：git commit 记录
    if (useGit && commits.length > 0) {
      const relatedCommits = commits.filter(c => isCommitRelatedToTask(c, inferred));
      if (relatedCommits.length > 0) {
        // 有相关 commit → 至少 in-progress
        inferred.status = 'in-progress';
        inferred.relatedCommits = relatedCommits.slice(0, 5).map(c => ({
          hash: c.hash.substring(0, 7),
          message: c.message,
          date: c.date
        }));
        inferred.lastCommitDate = relatedCommits[0].date;
      }
    }

    // 优先级 3：文件是否存在
    if (useFiles && inferred.files && inferred.files.length > 0) {
      const existingFiles = inferred.files.filter(f => {
        const fullPath = path.resolve(projectRoot, f);
        try {
          return fs.existsSync(fullPath);
        } catch (e) {
          return false;
        }
      });

      inferred.fileStats = {
        total: inferred.files.length,
        existing: existingFiles.length
      };

      // 文件存在但还没标 in-progress，标成 in-progress
      if (existingFiles.length > 0 && inferred.status === 'pending') {
        inferred.status = 'in-progress';
      }

      // 所有文件都存在且 git 也有记录，倾向 done（但不覆盖手动标记）
      if (existingFiles.length === inferred.files.length && inferred.status === 'in-progress') {
        // 这里不自动标 done，留给手动或测试判断
        // 但可以给个"可能完成"的提示
        inferred.maybeDone = true;
      }
    }

    return inferred;
  });
}

module.exports = { inferProgress };
