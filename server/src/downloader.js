'use strict';
const fs = require('fs');
const path = require('path');
const { sleep, parseRetryAfter, formatBytes } = require('./util');
const { fetchGalleryMeta } = require('./nhentai');
const { createZipFromDir, readZipEntries } = require('./zip');

/**************************************************************************
 * 文件头魔数校验 —— “下载完整”的核心判定：非空 + 格式文件头匹配
 **************************************************************************/
const MAGIC = {
    jpg: buf => buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF,
    png: buf => buf.length > 7 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47,
    gif: buf => buf.length > 5 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38,
    webp: buf => buf.length > 15 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP'
};

function sniffMagic(buf, ext) {
    const fn = MAGIC[String(ext || '').toLowerCase()];
    return fn ? !!fn(buf) : buf.length > 0;
}

function extOfFile(name) {
    const m = String(name).match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
}

/** 生成测试用伪图片字节（含合法文件头，供 mock 与单测使用） */
function magicBlob(ext, payload) {
    switch (String(ext).toLowerCase()) {
        case 'jpg': return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from(payload || 'jfif-test-data')]);
        case 'png': return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from(payload || 'png-test-data')]);
        case 'gif': return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from(payload || 'gif-test-data')]);
        case 'webp': return Buffer.concat([
            Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.from(payload || 'webp-test-data')
        ]);
        default: return Buffer.from(payload || 'bin');
    }
}

/** WebP 转换器：sharp 为可选依赖，未安装时自动降级为“保留原格式” */
class WebpConverter {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.sharp = null;
        this.checked = false;
        this.available = false;
    }

    _load() {
        if (this.checked) return this.available;
        this.checked = true;
        try {
            // eslint-disable-next-line global-require
            this.sharp = require('sharp');
            this.available = true;
            if (this.logger) this.logger.info('sharp 已加载：WebP 统一转换可用（gif -> 动态 WebP）');
        } catch (e) {
            this.available = false;
            if (this.logger) {
                this.logger.warn('未检测到 sharp（可选依赖），WebP 转换已禁用，图片保留原始格式。' +
                    '如需转换请在 server 目录执行: npm install sharp');
            }
        }
        return this.available;
    }

    /**
     * 将图片转换为 WebP：jpg/png -> webp；gif -> 动态 webp（保留动画）。
     * 返回转换后文件名；转换失败或未启用时返回 null（调用方保留原文件）。
     */
    async convert(filePath) {
        if (!this.config.get('convertToWebp')) return null;
        const ext = extOfFile(filePath);
        if (ext === 'webp') return path.basename(filePath);
        if (!this._load()) return null;
        const outPath = filePath.replace(/\.[a-z0-9]+$/i, '.webp');
        const isGif = ext === 'gif';
        try {
            const img = this.sharp(filePath, isGif ? { animated: true } : {});
            const opts = Object.assign({ quality: this.config.get('webpQuality') }, isGif ? { animated: true } : {});
            await img.webp(opts).toFile(outPath);
            if (!this.config.get('keepOriginal')) {
                try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            }
            return path.basename(outPath);
        } catch (e) {
            if (this.logger) this.logger.warn(`WebP 转换失败，保留原格式 ${path.basename(filePath)}: ${e.message}`);
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e2) { /* ignore */ }
            return null;
        }
    }
}

/** 删除文件夹（SMB/FUSE 占用场景下重试 3 次），返回是否成功 */
async function removeDirWithRetry(dir) {
    for (let i = 1; i <= 3; i++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return true;
        } catch (e) {
            if (i >= 3) return false;
            await sleep(1000 * i);   // .fuse_hidden* 被 SMB 占用时稍候会自动释放
        }
    }
    return false;
}

/**************************************************************************
 * 下载引擎：多 CDN 轮询 + 超时重传 + 完整性校验 + 间隔控制 + WebP 统一
 **************************************************************************/
class Downloader {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.converter = new WebpConverter(config, logger);
        this._gateNext = 0;
    }

    /** 请求节流闸门：保证相邻图片请求的起始间隔 >= requestIntervalMs */
    async _gate() {
        const interval = this.config.get('requestIntervalMs') || 0;
        if (interval <= 0) return;
        const now = Date.now();
        const wait = this._gateNext - now;
        this._gateNext = Math.max(now, this._gateNext) + interval;
        if (wait > 0) await sleep(wait);
    }

    /** CDN 轮询节点列表：优先封面所在节点，其后是配置的 cdnBaseUrls */
    _hostList(meta) {
        const hosts = [];
        if (this.config.get('preferCoverHost') && meta.coverHost) hosts.push(meta.coverHost.replace(/\/+$/, ''));
        for (const b of this.config.get('cdnBaseUrls') || []) {
            const norm = String(b).replace(/\/+$/, '');
            if (norm && !hosts.includes(norm)) hosts.push(norm);
        }
        return hosts;
    }

    /**
     * 下载单页。
     * 策略：每一轮把所有 CDN 节点轮询一遍（超时/失败立即换下一节点），
     * 整轮失败则退避后进入下一轮，最多 maxAttempts 轮（超时重传）。
     */
    async _downloadPage(ctx, n, ext) {
        const { dir, meta, signal } = ctx;
        const hosts = ctx.hosts;
        const cfg = this.config;
        const maxRounds = Math.max(1, cfg.get('maxAttempts'));
        const timeoutMs = cfg.get('timeoutMs');
        const knownExt = !!ext;
        const extCandidates = ext ? [ext] : ['webp', 'jpg', 'png', 'gif'];
        let lastError = '未知错误';
        const startIdx = (n - 1) % hosts.length;

        for (let round = 1; round <= maxRounds; round++) {
            for (let h = 0; h < hosts.length; h++) {
                if (signal && signal.aborted) throw new Error('已取消');
                const base = hosts[(startIdx + h + round - 1) % hosts.length];

                for (const tryExt of extCandidates) {
                    const url = `${base}/galleries/${meta.mediaId}/${n}.${tryExt}`;
                    await this._gate();
                    try {
                        const res = await fetch(url, {
                            headers: Object.assign({
                                'User-Agent': cfg.get('userAgent'),
                                'Referer': 'https://nhentai.net/',
                                'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
                            }, cfg.get('nhCookie') ? { 'Cookie': cfg.get('nhCookie') } : {}),
                            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
                        });

                        if (res.status === 404) {
                            lastError = `404 (${base})`;
                            if (knownExt) break;   // 官方后缀表可信：404 视为节点问题，换下一节点
                            continue;               // 探测模式：换下一个后缀
                        }
                        if (res.status === 429) {
                            const ra = parseRetryAfter(res);
                            lastError = `429 限流 (${base})`;
                            await sleep(Math.min((ra || 5) * 1000, 60000));
                            break;
                        }
                        if (!res.ok) {
                            lastError = `HTTP ${res.status} (${base})`;
                            break;
                        }

                        const buf = Buffer.from(await res.arrayBuffer());
                        if (buf.length < 128) throw new Error(`内容过小 (${buf.length}B)`);
                        if (!sniffMagic(buf, tryExt)) throw new Error('文件头校验失败（内容不是有效图片）');

                        const fileName = `${n}.${tryExt}`;
                        const filePath = path.join(dir, fileName);
                        const tmpPath = filePath + '.part';
                        fs.writeFileSync(tmpPath, buf);
                        fs.renameSync(tmpPath, filePath);
                        return { file: fileName, bytes: buf.length };
                    } catch (e) {
                        if (signal && signal.aborted) throw new Error('已取消');
                        lastError = (e.name === 'TimeoutError' || e.name === 'AbortError')
                            ? `超时 (${timeoutMs}ms, ${base})`
                            : `${e.message} (${base})`;
                    }
                }
            }
            if (round < maxRounds) {
                const backoff = cfg.get('retryDelayMs') * round + Math.floor(Math.random() * 500);
                await sleep(backoff);
            }
        }
        throw new Error(lastError);
    }

    /** 完整性校验：逐页检查最终文件是否存在、非空、文件头合法 */
    _verify(task, dir) {
        const broken = [];
        let valid = 0;
        for (const p of task.pages) {
            const filePath = path.join(dir, p.file || `${p.n}.${p.ext || 'jpg'}`);
            let ok = false;
            try {
                const st = fs.statSync(filePath);
                if (st.size > 0) {
                    const fd = fs.openSync(filePath, 'r');
                    const head = Buffer.alloc(16);
                    fs.readSync(fd, head, 0, 16, 0);
                    fs.closeSync(fd);
                    ok = sniffMagic(head, extOfFile(p.file || ''));
                }
            } catch (e) { ok = false; }
            if (ok) valid++;
            else broken.push(p);
        }
        return { valid, broken };
    }

    /**
     * 下载整本：元数据 -> 并发逐页下载 -> WebP 转换 -> 完整性校验 -> 缺损补齐轮次。
     * 直接在 task 对象上更新进度（由队列负责持久化）。
     */
    async downloadGallery(task, opts = {}) {
        const signal = opts.signal;
        const onProgress = opts.onProgress || (() => {});
        const cfg = this.config;
        const log = (m) => { if (this.logger) this.logger.info(`[gid:${task.gid}] ${m}`); };

        // 1. 元数据
        if (!task.meta) {
            const meta = await fetchGalleryMeta(task.gid, cfg, this.logger);
            task.meta = meta;
            if (meta.title && (!task.title || task.title === task.gid)) task.title = meta.title;
            log(`元数据: media_id=${meta.mediaId}, ${meta.numPages} 页, 标题=${task.title}`);
        }
        const meta = task.meta;
        const numPages = meta.numPages;
        const dir = path.join(cfg.get('downloadDir'), task.folder);
        fs.mkdirSync(dir, { recursive: true });

        if (!task.pages || task.pages.length !== numPages) {
            task.pages = [];
            for (let i = 1; i <= numPages; i++) {
                task.pages.push({
                    n: i,
                    ext: meta.extMap && meta.extMap[i - 1] ? meta.extMap[i - 1] : null,
                    file: null,
                    status: 'pending',
                    attempts: 0,
                    bytes: 0,
                    error: null
                });
            }
        }
        task.total = numPages;
        task.done = 0;
        task.failed = 0;

        const hosts = this._hostList(meta);
        const ctx = { dir, meta, signal, hosts };
        const totalRounds = 1 + Math.max(0, cfg.get('repairRounds'));

        for (let round = 1; round <= totalRounds; round++) {
            const pending = task.pages.filter(p => p.status !== 'done');
            if (pending.length === 0) break;
            if (round > 1) log(`完整性校验发现 ${pending.length} 页缺损，进入补齐轮 ${round - 1}/${totalRounds - 1}`);

            let cursor = 0;
            const concurrency = Math.max(1, Math.min(cfg.get('pageConcurrency'), pending.length));
            const workers = [];
            for (let w = 0; w < concurrency; w++) {
                workers.push((async () => {
                    while (true) {
                        const idx = cursor++;
                        if (idx >= pending.length) return;
                        const p = pending[idx];
                        if (signal && signal.aborted) return;
                        p.attempts++;
                        p.status = 'downloading';
                        try {
                            const r = await this._downloadPage(ctx, p.n, p.ext);
                            p.file = r.file;
                            p.bytes = r.bytes;
                            p.status = 'done';
                            p.error = null;
                            if (cfg.get('convertToWebp')) {
                                const newName = await this.converter.convert(path.join(dir, r.file));
                                if (newName && newName !== r.file) {
                                    p.file = newName;
                                    p.converted = true;
                                }
                            }
                        } catch (e) {
                            p.status = 'failed';
                            p.error = e.message;
                        }
                        task.done = task.pages.filter(x => x.status === 'done').length;
                        task.failed = task.pages.filter(x => x.status === 'failed').length;
                        onProgress(task);
                    }
                })());
            }
            await Promise.all(workers);
            if (signal && signal.aborted) throw new Error('已取消');
        }

        // 2. 最终完整性校验（文件数 + 文件头）
        const check = this._verify(task, dir);
        task.done = check.valid;
        task.failed = task.pages.length - check.valid;
        for (const p of check.broken) {
            p.status = 'failed';
            if (!p.error) p.error = '完整性校验未通过';
        }
        task.downloadedBytes = task.pages.reduce((s, p) => s + (p.bytes || 0), 0);
        task.convertedToWebp = !!(cfg.get('convertToWebp') && this.converter.available);
        task.folderPath = dir;

        // 3. 完整性校验通过后压缩为 zip（名字同样以 [id] 结尾，可直接导入 LANraragi）
        if (task.failed === 0 && task.done > 0 && cfg.get('zipAfterVerify')) {
            const zipName = `${task.folder}.zip`;
            const zipPath = path.join(cfg.get('downloadDir'), zipName);
            try {
                // 清理下载残留 .part（SMB/FUSE 场景偶发）
                for (const f of fs.readdirSync(dir)) {
                    if (f.endsWith('.part')) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ } }
                }
                const r = createZipFromDir(dir, zipPath);
                const entries = readZipEntries(zipPath);
                if (entries.length !== task.done) {
                    // 条目数不符不视为任务失败：保留文件夹供人工核对（常见于 SMB 残留文件）
                    task.zipError = `压缩包条目数不符 (${entries.length}/${task.done})，保留原文件夹`;
                    log(`⚠ ${task.zipError}`);
                } else {
                    task.zipFile = zipName;
                    task.zipBytes = r.bytes;
                    log(`已压缩: ${zipName} (${formatBytes(r.bytes)}, ${r.entries} 个文件)`);
                    if (!cfg.get('keepFolderAfterZip')) {
                        if (await removeDirWithRetry(dir)) {
                            task.folderRemoved = true;
                            log(`已清理原图片文件夹: ${task.folder}`);
                        } else {
                            task.zipError = '原文件夹被占用未能删除（SMB/.fuse_hidden 占用中，稍后自动释放）';
                            log(`⚠ ${task.zipError}`);
                        }
                    }
                }
            } catch (e) {
                task.zipError = e.message;
                log(`压缩失败，保留原文件夹: ${e.message}`);
            }
        }
        onProgress(task);

        log(`结束：成功 ${task.done}/${task.total}，失败 ${task.failed}`);
        return {
            ok: task.failed === 0 && task.done > 0,
            done: task.done,
            failed: task.failed,
            total: task.total,
            dir
        };
    }
}

module.exports = { Downloader, WebpConverter, sniffMagic, extOfFile, magicBlob, MAGIC };


