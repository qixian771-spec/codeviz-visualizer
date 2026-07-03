/**
 * watcher.js - 监听 tasks.md 和代码文件变化
 * 用 Node fs.watch（递归监听）
 */

const fs = require('fs');
const path = require('path');

class FileWatcher {
  /**
   * @param {string} projectRoot - 项目根目录
   * @param {Function} onChange - 回调 (event) => void
   *   event: { type: 'tasks'|'code', file: string, projectRoot: string }
   */
  constructor(projectRoot, onChange) {
    this.projectRoot = projectRoot;
    this.onChange = onChange;
    this.watchers = [];
    this.debounceTimer = null;
  }

  start() {
    try {
      // 递归监听整个项目（排除 node_modules / .git）
      const watcher = fs.watch(
        this.projectRoot,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;

          // 过滤噪音
          if (this._shouldIgnore(filename)) return;

          this._debounce({
            type: filename.endsWith('tasks.md') ? 'tasks' : 'code',
            file: filename,
            projectRoot: this.projectRoot
          });
        }
      );

      this.watchers.push(watcher);
    } catch (e) {
      // recursive watch 在某些系统不支持，降级到非递归
      console.error('[codeviz] 递归监听失败，尝试非递归:', e.message);
      this._startNonRecursive();
    }
  }

  _startNonRecursive() {
    try {
      const watcher = fs.watch(this.projectRoot, (eventType, filename) => {
        if (!filename || this._shouldIgnore(filename)) return;
        this._debounce({
          type: filename.endsWith('tasks.md') ? 'tasks' : 'code',
          file: filename,
          projectRoot: this.projectRoot
        });
      });
      this.watchers.push(watcher);
    } catch (e) {
      console.error('[codeviz] 监听失败:', e.message);
    }
  }

  _shouldIgnore(filename) {
    const ignored = [
      'node_modules/',
      '.git/',
      '.DS_Store',
      'dist/',
      'build/',
      '.next/',
      '.cache/'
    ];
    return ignored.some(prefix => filename.includes(prefix));
  }

  _debounce(event) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.onChange(event);
      this.debounceTimer = null;
    }, 300); // 300ms 防抖
  }

  stop() {
    this.watchers.forEach(w => {
      try { w.close(); } catch (e) {}
    });
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

module.exports = { FileWatcher };
