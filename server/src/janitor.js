'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, atomicWriteJson, nowIso } = require('./util');

const DEFAULT_INTERVAL = 5 * 60 * 1000;   // 每 5 分钟检测一次占用情况

/**
 * 残留文件夹清理器（SMB/.fuse_hidden 占用场景）：
 * 压缩完成但文件夹删除失败时入队；此后每 intervalMs 检测一次占用，
 * 占用释放后自动删除该文件夹。队列持久化到 data/cleanup.json —— 服务重启后继续清理。
 */
class FolderJanitor {
    constructor(opts) {
        this.dataDir = opts.dataDir;
        this.downloadDir = opts.downloadDir;
        this.logger = opts.logger;
        this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL;
        this.rmFn = opts.rmFn || ((dir) => { fs.rmSync(dir, { recursive: true, force: true }); });
        this.file = path.join(this.dataDir, 'cleanup.json');
        this.items = readJson(this.file, []);
        if (!Array.isArray(this.items)) this.items = [];
        this._timer = null;
        this.running = false;
    }

    /** 压缩完成但文件夹被占用时调用：登记待清理项 */
    enqueue(dir, info = {}) {
        if (this.items.some(i => i.dir === dir)) return;
        this.items.push({
            dir,
            gid: String(info.gid || ''),
            folder: info.folder || path.basename(dir),
            zip: info.zip || '',
            enqueuedAt: nowIso(),
            attempts: 0,
            lastTryAt: null
        });
        this.persist();
        if (this.logger) {
            this.logger.info(`[gid:${info.gid || '?'}] 文件夹被占用，已加入自动清理队列（每 ${Math.round(this.intervalMs / 1000)}s 检测一次占用，释放后自动删除）`);
        }
    }

    start() {
        if (this.running) return;
        this.running = true;
        this._tick();                       // 启动即补一次（覆盖服务重启场景）
        this._timer = setInterval(() => this._tick(), this.intervalMs);
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        this.running = false;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this.persist();
    }

    pending() {
        return this.items.length;
    }

    async _tick() {
        // 顺带清理下载根目录残留的 *.zip.part 临时文件
        try {
            for (const f of fs.readdirSync(this.downloadDir)) {
                if (f.endsWith('.zip.part')) {
                    try {
                        fs.unlinkSync(path.join(this.downloadDir, f));
                        if (this.logger) this.logger.info(`已清理残留临时文件: ${f}`);
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }

        for (const item of [...this.items]) {
            try {
                if (!fs.existsSync(item.dir)) {
                    // 文件夹已不存在（已删/手动清理）
                    this._drop(item);
                    continue;
                }
                // 安全护栏：只删下载根目录内的文件夹
                const rel = path.relative(this.downloadDir, item.dir);
                if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
                    this._drop(item);
                    continue;
                }

                item.attempts++;
                item.lastTryAt = nowIso();
                try {
                    this.rmFn(item.dir);
                    this._drop(item);
                    if (this.logger) {
                        this.logger.info(`[gid:${item.gid || '?'}] 占用已释放，残留文件夹已自动清理: ${item.folder}`);
                    }
                } catch (e) {
                    if (this.logger && (item.attempts === 1 || item.attempts % 12 === 0)) {
                        this.logger.warn(`[gid:${item.gid || '?'}] 残留文件夹仍被占用（第 ${item.attempts} 次尝试，继续每 ${Math.round(this.intervalMs / 1000)}s 重试）: ${item.folder} · ${e.message}`);
                    }
                    this.persist();
                }
            } catch (e) {
                if (this.logger) this.logger.warn(`清理残留文件夹出错: ${e.message}`);
            }
        }
    }

    _drop(item) {
        this.items = this.items.filter(i => i !== item);
        this.persist();
    }

    persist() {
        try { atomicWriteJson(this.file, this.items); } catch (e) { /* ignore */ }
    }
}

module.exports = { FolderJanitor, DEFAULT_INTERVAL };
