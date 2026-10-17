'use strict';
const { sleep, uuid, nowIso, galleryFolderName, stripTags } = require('./util');

const ACTIVE_STATUSES = ['queued', 'downloading'];

/** 校验外部传入的元数据（油猴脚本推送时附带，服务端即可零元数据请求、纯 CDN 下载） */
function sanitizeMeta(raw, gid) {
    if (!raw || typeof raw !== 'object') return null;
    const mediaId = String(raw.mediaId == null ? '' : raw.mediaId).trim();
    const numPages = parseInt(raw.numPages, 10);
    if (!/^\d+$/.test(mediaId) || !Number.isFinite(numPages) || numPages <= 0 || numPages > 2000) return null;

    const okExts = ['jpg', 'png', 'gif', 'webp'];
    const extMap = Array.isArray(raw.extMap)
        ? raw.extMap.slice(0, numPages).map(e => (okExts.includes(String(e).toLowerCase()) ? String(e).toLowerCase() : 'jpg'))
        : [];

    let coverHost = null;
    const host = String(raw.coverHost == null ? '' : raw.coverHost).trim().replace(/\/+$/, '');
    if (/^https?:\/\/[a-z0-9.\-]+(:\d+)?$/i.test(host)) coverHost = host;

    return { gid: String(gid || raw.gid || ''), mediaId, numPages, extMap, coverHost, title: sanitizeTitle(raw.title) };
}

/** 提取推送附带的标题（raw.title 或 meta.title），清洗后与 gid 相同/为空则返回 '' 交由调用方兜底 */
function sanitizeTitle(v) {
    const t = stripTags(String(v == null ? '' : v)).replace(/\s+/g, ' ').trim().slice(0, 300);
    return t;
}

/**
 * 下载队列：FIFO 后台自动排队下载，
 * 支持暂停/继续、取消、失败重试、按 gid 去重、任务间隔。
 */
class QueueManager {
    constructor(store, config, logger, downloader) {
        this.store = store;
        this.config = config;
        this.logger = logger;
        this.downloader = downloader;
        this.paused = false;
        this.running = false;
        this.current = null;      // 当前任务 id
        this._controller = null;
        this._loopPromise = null;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this._loopPromise = this._loop();
    }

    async stop() {
        this.running = false;
        if (this._controller) this._controller.abort();
        if (this._loopPromise) {
            try { await this._loopPromise; } catch (e) { /* ignore */ }
        }
        this.store.flush();
    }

    pause() {
        this.paused = true;
        if (this.logger) this.logger.warn('队列已暂停（当前任务将继续完成）');
    }

    resume() {
        this.paused = false;
        if (this.logger) this.logger.info('队列已继续');
    }

    /**
     * 入队。items: [{gid, title?}]
     * 返回 { added: [task], skipped: [{gid, reason}] }
     */
    enqueue(items) {
        const added = [];
        const skipped = [];
        for (const raw of items || []) {
            const gid = String(raw && raw.gid != null ? raw.gid : '').trim();
            if (!/^\d+$/.test(gid)) { skipped.push({ gid, reason: 'gid 无效' }); continue; }

            const all = this.store.findByGid(gid);
            const existing = all.find(t => ACTIVE_STATUSES.includes(t.status) || t.status === 'completed' || t.status === 'completed_with_errors');
            if (existing) {
                skipped.push({ gid, reason: existing.status.startsWith('completed') ? '已下载完成' : `队列中已存在 (${existing.status})` });
                continue;
            }

            // 标题优先级：推送标题 > 元数据标题 > gid 兜底。
            // 与 gid 相同的占位标题视为无效（DOM 提取失败时前端会回退成 gid），改用元数据标题。
            const t1 = sanitizeTitle(raw.title);
            const t2 = sanitizeTitle(raw.meta && raw.meta.title);
            const title = (t1 && t1 !== gid ? t1 : (t2 && t2 !== gid ? t2 : gid));
            // 失败/取消的任务直接复活重新入队
            const revivable = all.find(t => t.status === 'failed' || t.status === 'cancelled');
            if (revivable) {
                revivable.status = 'queued';
                revivable.title = title;
                revivable.folder = galleryFolderName(title, gid);
                revivable.error = null;
                revivable.createdAt = nowIso();
                revivable.startedAt = null;
                revivable.finishedAt = null;
                const revMeta = sanitizeMeta(raw.meta, gid);
                if (revMeta) revivable.meta = revMeta;
                added.push(revivable);
                if (this.logger) this.logger.info(`任务重新入队: ${gid} ${title}`);
                continue;
            }

            const task = {
                id: uuid(),
                gid,
                title,
                folder: galleryFolderName(title, gid),
                status: 'queued',
                pages: [],
                total: 0,
                done: 0,
                failed: 0,
                error: null,
                downloadedBytes: 0,
                convertedToWebp: false,
                meta: sanitizeMeta(raw.meta, gid),
                createdAt: nowIso(),
                startedAt: null,
                finishedAt: null
            };
            this.store.add(task);
            added.push(task);
            if (this.logger) this.logger.info(`任务入队: ${gid} ${title}`);
        }
        return { added, skipped };
    }

    cancel(id) {
        const task = this.store.get(id);
        if (!task) return { ok: false, error: '任务不存在' };
        if (task.status === 'downloading') {
            if (this._controller) this._controller.abort();
            task.status = 'cancelled';
            task.error = '用户取消';
            task.finishedAt = nowIso();
            this.store.persist();
            return { ok: true };
        }
        if (task.status === 'queued') {
            task.status = 'cancelled';
            task.error = '用户取消';
            task.finishedAt = nowIso();
            this.store.persist();
            return { ok: true };
        }
        return { ok: false, error: `任务当前状态 (${task.status}) 不可取消` };
    }

    retry(id) {
        const task = this.store.get(id);
        if (!task) return { ok: false, error: '任务不存在' };
        if (ACTIVE_STATUSES.includes(task.status)) return { ok: false, error: '任务正在进行中' };
        task.status = 'queued';
        task.error = null;
        task.finishedAt = null;
        for (const p of (task.pages || [])) {
            if (p.status !== 'done') { p.status = 'pending'; p.error = null; }
        }
        this.store.persist();
        if (this.logger) this.logger.info(`任务重试: ${task.gid} ${task.title}`);
        return { ok: true, task };
    }

    retryFailed() {
        let n = 0;
        for (const t of this.store.list()) {
            if (t.status === 'failed' || t.status === 'completed_with_errors') {
                if (this.retry(t.id).ok) n++;
            }
        }
        return { ok: true, count: n };
    }

    remove(id) {
        const task = this.store.get(id);
        if (!task) return { ok: false, error: '任务不存在' };
        if (task.status === 'downloading') return { ok: false, error: '请先取消任务再删除' };
        this.store.remove(id);
        return { ok: true };
    }

    async _loop() {
        while (this.running) {
            try {
                if (this.paused) { await sleep(400); continue; }
                const now = Date.now();
                const next = this.store.list()
                    .filter(t => t.status === 'queued' && (!t.notBefore || t.notBefore <= now))
                    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
                if (!next) { await sleep(400); continue; }

                next.status = 'downloading';
                next.startedAt = nowIso();
                next.error = null;
                this.current = next.id;
                this._controller = new AbortController();
                this.store.persist();

                try {
                    const summary = await this.downloader.downloadGallery(next, {
                        signal: this._controller.signal,
                        onProgress: () => this.store.persist()
                    });
                    if (this._controller.signal.aborted) {
                        next.status = 'cancelled';
                        next.error = '用户取消';
                    } else {
                        next.status = summary.ok ? 'completed' : (summary.done > 0 ? 'completed_with_errors' : 'failed');
                        if (!summary.ok) next.error = `${summary.failed} 页下载失败`;
                    }
                } catch (e) {
                    if (this._controller.signal.aborted) {
                        next.status = 'cancelled';
                        next.error = '用户取消';
                    } else {
                        next.status = 'failed';
                        next.error = e.message;
                        if (this.logger) this.logger.error(`[gid:${next.gid}] 任务失败: ${e.message}`);
                    }
                } finally {
                    next.finishedAt = nowIso();
                    this.current = null;
                    this._controller = null;
                    this.store.persist();
                }

                // 任务间隔（支持间隔时间下载）
                const gap = this.config.get('galleryIntervalMs') || 0;
                if (gap > 0 && this.running && !this.paused) await sleep(gap);
            } catch (e) {
                if (this.logger) this.logger.error(`队列循环异常: ${e.message}`);
                await sleep(1000);
            }
        }
    }
}

module.exports = { QueueManager, ACTIVE_STATUSES };

