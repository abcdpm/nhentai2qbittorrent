'use strict';
const path = require('path');
const { readJson, atomicWriteJson, nowIso } = require('./util');

/**
 * 任务持久化：data/tasks.json（原子写 + 防抖）。
 * 任务结构：
 * {
 *   id, gid, title, folder, status,
 *   pages: [{ n, ext, file, status, attempts, bytes, error }],
 *   total, done, failed, error, downloadedBytes, convertedToWebp,
 *   createdAt, startedAt, finishedAt
 * }
 * status: queued | downloading | completed | completed_with_errors | failed | cancelled
 */
class TaskStore {
    constructor(dataDir) {
        this.file = path.join(dataDir, 'tasks.json');
        const loaded = readJson(this.file, { tasks: [] });
        this.tasks = Array.isArray(loaded.tasks) ? loaded.tasks : [];
        this._timer = null;
        this._dirty = false;
    }

    add(task) {
        this.tasks.push(task);
        this.persist();
        return task;
    }

    get(id) {
        return this.tasks.find(t => t.id === id) || null;
    }

    findByGid(gid) {
        return this.tasks.filter(t => String(t.gid) === String(gid));
    }

    list(filter = {}) {
        let out = this.tasks.slice();
        if (filter.status) out = out.filter(t => t.status === filter.status);
        if (filter.gid) out = out.filter(t => String(t.gid) === String(filter.gid));
        return out;
    }

    remove(id) {
        const idx = this.tasks.findIndex(t => t.id === id);
        if (idx === -1) return false;
        this.tasks.splice(idx, 1);
        this.persist();
        return true;
    }

    counts() {
        const c = { total: this.tasks.length, queued: 0, downloading: 0, completed: 0, completed_with_errors: 0, failed: 0, cancelled: 0 };
        for (const t of this.tasks) {
            if (c[t.status] !== undefined) c[t.status]++;
        }
        return c;
    }

    persist() {
        this._dirty = true;
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this.flush();
        }, 300);
        if (this._timer.unref) this._timer.unref();
    }

    flush() {
        if (!this._dirty) return;
        this._dirty = false;
        try {
            atomicWriteJson(this.file, { updatedAt: nowIso(), tasks: this.tasks });
        } catch (e) {
            this._dirty = true;
        }
    }

    /** 服务重启时把中断的 downloading 任务放回队列 */
    recoverInterrupted() {
        let n = 0;
        for (const t of this.tasks) {
            if (t.status === 'downloading') {
                t.status = 'queued';
                t.error = '服务重启，任务已自动放回队列';
                t.startedAt = null;
                n++;
            }
        }
        if (n > 0) this.flush();
        return n;
    }
}

module.exports = { TaskStore };
