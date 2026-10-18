'use strict';
/**
 * 全链路自测：mock 源站 + 队列下载 + API 鉴权
 * 运行：npm test  （或 node test/run-tests.js）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { Config } = require('../src/config');
const { Logger } = require('../src/logger');
const { KeyStore } = require('../src/keys');
const { TaskStore } = require('../src/store');
const { Downloader, magicBlob, sniffMagic } = require('../src/downloader');
const { QueueManager } = require('../src/queue');
const { createHandler } = require('../src/api');
const { parseGalleryHtml, parseGalleryApi, fetchGalleryMeta } = require('../src/nhentai');
const { galleryFolderName, sanitizeFileName } = require('../src/util');
const { readZipEntries, extractZipEntry, crc32, numericNameCompare, createZipFromDir } = require('../src/zip');
const { StateStore } = require('../src/state');
const { FolderJanitor } = require('../src/janitor');
const { AuthManager } = require('../src/auth');

/**************************************************************************
 * mock 源站：/g/:gid/ 详情页 + /:cdn/galleries/:media/:file 图片
 * plans: '1.jpg' -> ['500','ok'] 或 'cdn1|1.jpg' -> [...]（按 host 区分）
 *************************************************************************/
function createMockSite(galleries) {
    const state = {
        galleries,
        plans: new Map(),
        hits: [],
        pending: [],
        metaHits: [],
        lrrUploads: []
    };

    function planFor(hostSeg, file) {
        for (const key of [`${hostSeg}|${file}`, file]) {
            const plan = state.plans.get(key);
            if (plan === undefined) continue;
            if (Array.isArray(plan)) return plan.length ? plan.shift() : 'ok';
            return plan;   // 常量行为（如恒定 '403'）
        }
        return 'ok';
    }

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const parts = u.pathname.split('/').filter(Boolean);

        if (parts[0] === 'g' && parts[1]) {
            state.metaHits.push({ kind: 'html', id: parts[1], cookie: req.headers.cookie || '' });
            const action = planFor('html', parts[1]);
            if (action === '403') { res.writeHead(403); res.end('cf challenge'); return; }
            const g = state.galleries[parts[1]];
            if (!g) { res.writeHead(404); res.end('not found'); return; }
            const pagesJson = g.types.map(t => `{"t":"${t}"}`).join(',');
            const html = `<!DOCTYPE html><html><head><title>${g.title}</title></head><body>
<div id="info"><h2 class="title">${g.title}</h2></div>
<script>window._gallery = {"media_id":"${g.mediaId}","num_pages":${g.types.length},"pages":[${pagesJson}]};</script>
<img src="https://t2.mockhost/galleries/${g.mediaId}/cover.jpg">
</body></html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        }

        if (parts[0] === 'api' && parts[1] === 'archives') {
            // LANraragi 模拟：PUT /api/archives/upload、GET /api/archives
            let bodyBuf = Buffer.alloc(0);
            req.on('data', c => { bodyBuf = Buffer.concat([bodyBuf, c]); });
            req.on('end', () => {
                if (parts[2] === 'upload') {
                    state.lrrUploads.push({
                        auth: req.headers.authorization || '',
                        method: req.method,
                        size: bodyBuf.length,
                        hasZipName: bodyBuf.includes('.zip'),
                        hasTitle: bodyBuf.includes('测试本子标题'),
                        hasSource: bodyBuf.includes('source:nhentai.net/g/'),
                        hasSha1Field: bodyBuf.includes('file_checksum')
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ arcid: 'a'.repeat(40), success: 1 }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify([{ arcid: 'x'.repeat(40) }]));
                }
            });
            return;
        }

        if (parts[0] === 'api' && parts[1]) {
            state.metaHits.push({ kind: 'api', id: parts[1], cookie: req.headers.cookie || '', auth: req.headers.authorization || '' });
            const action = planFor('api', parts[1]);
            if (action === '403') { res.writeHead(403); res.end('cf challenge'); return; }
            const g = state.galleries[parts[1]];
            if (!g) { res.writeHead(404); res.end('not found'); return; }
            const typeMap = { j: 'jpg', p: 'png', g: 'gif', w: 'webp' };
            // 官方 v2 API 格式：pages[].path 含精确文件名
            const json = {
                id: Number(parts[1]),
                media_id: g.mediaId,
                title: { pretty: g.title, english: g.title },
                num_pages: g.types.length,
                pages: g.types.map((t, i) => ({ number: i + 1, path: `galleries/${g.mediaId}/${i + 1}.${typeMap[t]}` }))
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(json));
            return;
        }

        if (parts[0] && parts[0].startsWith('cdn') && parts[1] === 'galleries') {
            const file = parts[3];
            const hostSeg = parts[0];
            state.hits.push({ host: hostSeg, file });
            const action = planFor(hostSeg, file);
            if (action === 'hang') { state.pending.push(res); return; }
            if (action === '404') { res.writeHead(404); res.end('nope'); return; }
            if (action === '500') { res.writeHead(500); res.end('err'); return; }
            if (action === '429') { res.writeHead(429, { 'Retry-After': '1' }); res.end('rate'); return; }
            if (action === 'jpeg') {
                // 后缀错位场景：URL 是 .png 但实际内容是 JPEG（nhentai 真实存在的老文件）
                const buf = magicBlob('jpg', Buffer.alloc(300, 7));
                res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
                res.end(buf);
                return;
            }
            if (action === 'html') {
                // 非图片内容（拦截页/错误页）
                const buf = Buffer.from('<html><body>Just a moment...</body></html>'.padEnd(300, ' '));
                res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': buf.length });
                res.end(buf);
                return;
            }
            const ext = (file.match(/\.[a-z0-9]+$/i) || ['.bin'])[0].slice(1);
            const buf = magicBlob(ext, Buffer.alloc(300, 7));
            res.writeHead(200, { 'Content-Type': 'image/' + ext, 'Content-Length': buf.length });
            res.end(buf);
            return;
        }

        res.writeHead(404); res.end('not found');
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({
                port,
                state,
                plan(key, actions) { state.plans.set(key, Array.isArray(actions) ? actions.slice() : actions); },
                close() {
                    for (const res of state.pending) { try { res.destroy(); } catch (e) { /* ignore */ } }
                    server.close();
                }
            });
        });
    });
}

function makeEnv(mock, tmpName) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tmpName || 'nh-test-'));
    const config = new Config(tmp);
    config.data.downloadDir = path.join(tmp, 'dl');
    config.data.requestIntervalMs = 0;
    config.data.galleryIntervalMs = 0;
    config.data.pageConcurrency = 2;
    config.data.timeoutMs = 1200;
    config.data.maxAttempts = 3;
    config.data.retryDelayMs = 80;
    config.data.repairRounds = 2;
    config.data.convertToWebp = false;
    config.data.zipAfterVerify = false;
    config.data.preferCoverHost = false;
    config.data.metaUrlTemplate = `http://127.0.0.1:${mock.port}/g/{gid}/`;
    config.data.apiUrlTemplate = `http://127.0.0.1:${mock.port}/api/{gid}`;
    config.data.cdnBaseUrls = [`http://127.0.0.1:${mock.port}/cdn1`, `http://127.0.0.1:${mock.port}/cdn2`];
    fs.mkdirSync(config.data.downloadDir, { recursive: true });

    const logger = new Logger(200);
    const origLog = logger.log.bind(logger);
    logger.log = (level, msg, meta) => { if (process.env.VERBOSE) origLog(level, msg, meta); };

    const store = new TaskStore(tmp);
    const downloader = new Downloader(config, logger);
    const queue = new QueueManager(store, config, logger, downloader);
    return { tmp, config, logger, store, downloader, queue };
}

async function waitFor(fn, timeoutMs, what) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const v = fn();
        if (v) return v;
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('等待超时: ' + what);
}

function filesOf(dir) {
    try { return fs.readdirSync(dir).filter(f => !f.endsWith('.part')).sort(); } catch (e) { return []; }
}

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

const GALLERY_1 = {
    '123001': { mediaId: '900001', title: '[作者A] 测试本子标题', types: ['j', 'p', 'w'] },
    '123002': { mediaId: '900002', title: '[作者B] 旋转与重试', types: ['j', 'j'] },
    '123003': { mediaId: '900003', title: '[作者C] 完整性补齐', types: ['j', 'j', 'p'] },
    '123004': { mediaId: '900004', title: '[作者D] 限流处理', types: ['j', 'w'] },
    '123005': { mediaId: '900005', title: '[作者E] WebP转换', types: ['j', 'g'] },
    '123009': { mediaId: '900009', title: '[作者G] 后缀错位', types: ['p'] }
};

test('元数据解析：media_id / num_pages / 后缀表 / 标题 / CDN 主机', () => {
    const html = `<div id="info"><h2 class="title">[作者A] 测试本子标题</h2></div>
        <script>"media_id":"900001","num_pages":3,"pages":[{"t":"j"},{"t":"p"},{"t":"w"}]</script>
        <img src="https://t2.nhentai.net/galleries/900001/cover.jpg">`;
    const meta = parseGalleryHtml(html, '123001');
    assert.strictEqual(meta.mediaId, '900001');
    assert.strictEqual(meta.numPages, 3);
    assert.deepStrictEqual(meta.extMap, ['jpg', 'png', 'webp']);
    assert.strictEqual(meta.title, '[作者A] 测试本子标题');
    assert.strictEqual(meta.coverHost, 'https://i2.nhentai.net');
});

test('文件夹命名规则：本子名 [本子id]（非法字符/Windows保留名/长度双平台限制）', () => {
    assert.strictEqual(galleryFolderName('[作者A] 测试本子标题', '123001'), '[作者A] 测试本子标题 [123001]');
    const name = galleryFolderName('标题/含:非法*字符?  ', '42');
    assert.strictEqual(name, '标题 含 非法 字符 [42]');
    assert.ok(!/[\\/:*?"<>|]/.test(name));
    assert.strictEqual(sanitizeFileName('  a..b  '), 'a..b');

    // 超长标题（中文 300 字 = 900 字节）：截掉最后面的文字，但保留末端 [id]
    const longName = galleryFolderName('很长的标题'.repeat(60), '123456');
    assert.ok(Buffer.byteLength(longName, 'utf8') <= 180, `总长应 ≤180 字节, 实际 ${Buffer.byteLength(longName, 'utf8')}`);
    assert.ok(/\ \[123456\]$/.test(longName), '必须保留末端 [id] 标记');
    assert.ok(longName.startsWith('很长的标题'), '截断必须从标题尾部进行');

    // ASCII 超长同样限字节
    const ascii = galleryFolderName('A'.repeat(300), '1');
    assert.ok(Buffer.byteLength(ascii, 'utf8') <= 180);

    // Windows 保留设备名 / 结尾点与空格
    assert.strictEqual(galleryFolderName('con', '1'), 'con_ [1]');
    assert.strictEqual(galleryFolderName('NUL', '2'), 'NUL_ [2]');
    assert.strictEqual(galleryFolderName('标题. . ', '2'), '标题 [2]');
});

test('文件头魔数校验', () => {
    assert.ok(sniffMagic(magicBlob('jpg'), 'jpg'));
    assert.ok(sniffMagic(magicBlob('png'), 'png'));
    assert.ok(sniffMagic(magicBlob('gif'), 'gif'));
    assert.ok(sniffMagic(magicBlob('webp'), 'webp'));
    assert.ok(!sniffMagic(magicBlob('png'), 'jpg'));
});

test('完整下载：多格式 (jpg/png/webp) + 目录名 + 队列状态', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    try {
        const { added } = env.queue.enqueue([{ gid: '123001', title: '[作者A] 测试本子标题' }]);
        assert.strictEqual(added.length, 1);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && t.status !== 'queued' && t.status !== 'downloading' ? t : null;
        }, 15000, '任务完成');

        assert.strictEqual(task.status, 'completed', '应全部完成, got: ' + task.status + ' err=' + task.error);
        assert.strictEqual(task.done, 3);
        const dir = path.join(env.config.get('downloadDir'), '[作者A] 测试本子标题 [123001]');
        assert.deepStrictEqual(filesOf(dir), ['1.jpg', '2.png', '3.webp']);
        assert.strictEqual(task.folder, '[作者A] 测试本子标题 [123001]');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('多 CDN 轮询：节点1 持续失败自动切到节点2', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('cdn1|1.jpg', ['500', '500', '500', '500', '500', '500']);
    const env = makeEnv(mock);
    try {
        const { added } = env.queue.enqueue([{ gid: '123002', title: '[作者B] 旋转与重试' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');

        assert.strictEqual(task.status, 'completed');
        const okOnCdn2 = mock.state.hits.some(h => h.host === 'cdn2' && h.file === '1.jpg');
        assert.ok(okOnCdn2, '应轮询到 CDN2 并下载成功');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('超时重传：首次请求挂起超时后自动换节点重试', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('1.jpg', ['hang', 'ok']);
    const env = makeEnv(mock);
    env.config.data.timeoutMs = 500;
    try {
        const { added } = env.queue.enqueue([{ gid: '123002', title: '[作者B] 旋转与重试' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');

        assert.strictEqual(task.status, 'completed');
        const hits = mock.state.hits.filter(h => h.file === '1.jpg');
        assert.ok(hits.length >= 2, `超时后应重传, 实际请求 ${hits.length} 次`);
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('完整性校验 + 缺损补齐：首次全失败后补齐轮重传成功', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('3.png', ['500', '500', 'ok']);   // 第一轮两个节点均失败，补齐轮恢复
    const env = makeEnv(mock);
    env.config.data.maxAttempts = 1;
    env.config.data.repairRounds = 2;
    try {
        const { added } = env.queue.enqueue([{ gid: '123003', title: '[作者C] 完整性补齐' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');

        assert.strictEqual(task.status, 'completed', '补齐后应完整, got ' + task.status);
        assert.strictEqual(task.done, 3);
        const dir = path.join(env.config.get('downloadDir'), '[作者C] 完整性补齐 [123003]');
        assert.deepStrictEqual(filesOf(dir), ['1.jpg', '2.jpg', '3.png']);
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('间隔下载：图片请求按 requestIntervalMs 节流', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    env.config.data.pageConcurrency = 1;
    env.config.data.requestIntervalMs = 250;
    try {
        const t0 = Date.now();
        const { added } = env.queue.enqueue([{ gid: '123001', title: '[作者A] 测试本子标题' }]);
        env.queue.start();
        await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= 500, `3 页间隔 250ms 至少耗时 500ms, 实际 ${elapsed}ms`);
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('429 限流退避后重试成功', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('1.jpg', ['429', 'ok']);
    const env = makeEnv(mock);
    try {
        const { added } = env.queue.enqueue([{ gid: '123004', title: '[作者D] 限流处理' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');
        assert.strictEqual(task.status, 'completed');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('环境变量覆盖配置（Docker 部署：NH_* 优先级最高）', () => {
    process.env.NH_REQUEST_INTERVAL_MS = '777';
    process.env.NH_CONVERT_TO_WEBP = 'true';
    process.env.NH_CDN_BASE_URLS = 'http://a.test, http://b.test';
    process.env.NH_DOWNLOAD_DIR = '/data/dl';
    process.env.NH_HOST = '0.0.0.0';
    try {
        const cfg = new Config(os.tmpdir());
        assert.strictEqual(cfg.get('requestIntervalMs'), 777);
        assert.strictEqual(cfg.get('convertToWebp'), true);
        assert.deepStrictEqual(cfg.get('cdnBaseUrls'), ['http://a.test', 'http://b.test']);
        assert.strictEqual(cfg.get('downloadDir'), '/data/dl');
        assert.strictEqual(cfg.get('host'), '0.0.0.0');
    } finally {
        delete process.env.NH_REQUEST_INTERVAL_MS;
        delete process.env.NH_CONVERT_TO_WEBP;
        delete process.env.NH_CDN_BASE_URLS;
        delete process.env.NH_DOWNLOAD_DIR;
        delete process.env.NH_HOST;
    }
});

test('入队去重：重复 gid 与非法 gid 被跳过', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    try {
        env.queue.pause();
        const r1 = env.queue.enqueue([{ gid: '123001', title: 'A' }, { gid: 'abc', title: 'bad' }, { gid: '123001', title: 'A' }]);
        assert.strictEqual(r1.added.length, 1);
        assert.strictEqual(r1.skipped.length, 2);
        assert.strictEqual(r1.skipped[0].reason, 'gid 无效');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('WebP 统一转换：jpg/png → webp，gif → 动态 webp（sharp 缺失时优雅降级保留原格式）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    env.config.data.convertToWebp = true;
    const sharpAvailable = env.downloader.converter._load();
    try {
        const { added } = env.queue.enqueue([{ gid: '123005', title: '[作者E] WebP转换' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');
        assert.strictEqual(task.status, 'completed');

        const dir = path.join(env.config.get('downloadDir'), '[作者E] WebP转换 [123005]');
        const files = filesOf(dir);
        if (sharpAvailable) {
            assert.deepStrictEqual(files, ['1.webp', '2.webp'], 'jpg 与 gif 均应转为 webp');
            assert.ok(task.convertedToWebp);
        } else {
            console.log('    [SKIP] 未安装 sharp，验证降级路径：保留原始 jpg/gif');
            assert.deepStrictEqual(files, ['1.jpg', '2.gif']);
        }
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('CRC32 标准向量与 zip 条目数值排序', () => {
    assert.strictEqual(crc32(Buffer.from('123456789', 'utf8')), 0xCBF43926);
    assert.deepStrictEqual(['10.jpg', '2.jpg', '1.jpg'].sort(numericNameCompare), ['1.jpg', '2.jpg', '10.jpg']);
});

test('完整性校验通过后压缩 zip 并清理原文件夹', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    env.config.data.zipAfterVerify = true;
    env.config.data.keepFolderAfterZip = false;
    try {
        const { added } = env.queue.enqueue([{ gid: '123001', title: '[作者A] 测试本子标题' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');
        assert.strictEqual(task.status, 'completed');

        const dl = env.config.get('downloadDir');
        const zipPath = path.join(dl, '[作者A] 测试本子标题 [123001].zip');
        assert.ok(fs.existsSync(zipPath), '应生成 zip 压缩包');
        assert.ok(!fs.existsSync(path.join(dl, '[作者A] 测试本子标题 [123001]')), '默认应删除原图片文件夹');

        const entries = readZipEntries(zipPath);
        assert.deepStrictEqual(entries.map(e => e.name), ['1.jpg', '2.png', '3.webp'], '条目按页码排序');
        const raw = extractZipEntry(zipPath, entries[0]);
        assert.ok(sniffMagic(raw, 'jpg'), '解压内容应与源图片一致');
        assert.strictEqual(task.zipFile, '[作者A] 测试本子标题 [123001].zip');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('keepFolderAfterZip=true 时压缩后保留原文件夹', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    env.config.data.zipAfterVerify = true;
    env.config.data.keepFolderAfterZip = true;
    try {
        const { added } = env.queue.enqueue([{ gid: '123002', title: '[作者B] 旋转与重试' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');
        assert.strictEqual(task.status, 'completed');
        const dl = env.config.get('downloadDir');
        assert.ok(fs.existsSync(path.join(dl, '[作者B] 旋转与重试 [123002].zip')), 'zip 应生成');
        assert.ok(fs.existsSync(path.join(dl, '[作者B] 旋转与重试 [123002]')), '原文件夹应保留');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('JSON API 元数据解析（备用源）', () => {
    const meta = parseGalleryApi({
        media_id: '555', num_pages: 2,
        title: { pretty: 'Pretty Title' },
        images: { pages: [{ t: 'j' }, { t: 'g' }] }
    }, '42');
    assert.strictEqual(meta.mediaId, '555');
    assert.strictEqual(meta.numPages, 2);
    assert.strictEqual(meta.title, 'Pretty Title');
    assert.deepStrictEqual(meta.extMap, ['jpg', 'gif']);
});

test('官方 v2 API 元数据解析（pages.path 精确扩展名）', () => {
    const meta = parseGalleryApi({
        id: 687629, media_id: '4238061',
        title: { pretty: '小目与小潘多拉', english: '[ふぇぇり] 小目与小潘多拉' },
        num_pages: 3,
        pages: [
            { number: 1, path: 'galleries/4238061/1.webp' },
            { number: 2, path: 'galleries/4238061/2.jpg' },
            { number: 3, path: 'galleries/4238061/3.gif' }
        ]
    }, '687629');
    assert.strictEqual(meta.mediaId, '4238061');
    assert.strictEqual(meta.numPages, 3);
    assert.strictEqual(meta.title, '小目与小潘多拉');
    assert.deepStrictEqual(meta.extMap, ['webp', 'jpg', 'gif']);
});

test('任务自带 meta（脚本随推送附带）→ 零元数据请求，纯 CDN 下载', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    try {
        const { added } = env.queue.enqueue([{
            gid: '123001',
            title: '[作者A] 测试本子标题',
            meta: { mediaId: '900001', numPages: 3, extMap: ['jpg', 'png', 'webp'], coverHost: null }
        }]);
        assert.strictEqual(added[0].meta.mediaId, '900001', 'meta 应随任务保存');

        // 非法 meta 应被拒绝（回退为服务端自行抓取）
        const bad = env.queue.enqueue([{ gid: '123002', title: 'x', meta: { mediaId: '', numPages: 0 } }]);
        assert.strictEqual(bad.added[0].meta, null, '非法 meta 应置空');
        env.queue.remove(bad.added[0].id);   // 移除，避免其抓取元数据干扰零请求断言

        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');

        assert.strictEqual(task.status, 'completed');
        const dir = path.join(env.config.get('downloadDir'), '[作者A] 测试本子标题 [123001]');
        assert.deepStrictEqual(filesOf(dir), ['1.jpg', '2.png', '3.webp']);
        assert.strictEqual(mock.state.metaHits.length, 0, '应零元数据请求（纯 CDN 下载）');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('元数据 HTML 失败时回退 API 模板（显式配置时），并携带 Cookie / API Key', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('html|123001', '403');          // 详情页持续 403 → 回退 API
    const env = makeEnv(mock);
    env.config.data.nhCookie = 'cf_clearance=abc123';
    env.config.data.nhApiKey = 'k-123';
    try {
        const { added } = env.queue.enqueue([{ gid: '123001', title: '[作者A] 测试本子标题' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 20000, '任务完成');

        assert.strictEqual(task.status, 'completed', '应经 API 备用源完成, got: ' + task.status + ' err=' + task.error);
        const dir = path.join(env.config.get('downloadDir'), '[作者A] 测试本子标题 [123001]');
        assert.deepStrictEqual(filesOf(dir), ['1.jpg', '2.png', '3.webp']);

        const htmlHit = mock.state.metaHits.find(h => h.kind === 'html' && h.id === '123001');
        assert.ok(htmlHit, '应先尝试详情页 HTML（原逻辑）');
        assert.strictEqual(htmlHit.cookie, 'cf_clearance=abc123', 'HTML 请求应携带 Cookie');
        const apiHit = mock.state.metaHits.find(h => h.kind === 'api' && h.id === '123001');
        assert.ok(apiHit, 'HTML 失败后应回退 API 模板');
        assert.strictEqual(apiHit.auth, 'Key k-123', 'API 请求应携带 Authorization: Key <nhApiKey>');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('apiUrlTemplate 留空（默认）时绝不请求官方 API', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('html|123001', '403');          // HTML 也失败
    const env = makeEnv(mock);
    env.config.data.apiUrlTemplate = '';      // 默认禁用官方 API
    try {
        const { added } = env.queue.enqueue([{ gid: '123001', title: '[作者A] 测试本子标题' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 20000, '任务完成');

        assert.strictEqual(task.status, 'failed');
        assert.ok(/重新推送|已禁用/.test(task.error || ''), '错误应提示重新推送/说明 API 已禁用');
        assert.ok(!mock.state.metaHits.some(h => h.kind === 'api'), '默认不得请求官方 API');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('HTTP API：鉴权 / 入队 / 去重 / 密钥管理 / 设置校验', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const call = async (p, method, body, key) => {
        const res = await fetch(base + p, {
            method: method || 'GET',
            headers: Object.assign(
                key === null ? {} : { 'X-API-Key': key || created.raw },
                body ? { 'Content-Type': 'application/json' } : {}
            ),
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    };

    try {
        // 鉴权
        let r = await call('/api/stats', 'GET', null, null);
        assert.strictEqual(r.status, 401, '无密钥必须 401');
        r = await call('/api/stats', 'GET', null, 'nhk_wrong_key');
        assert.strictEqual(r.status, 401, '错误密钥必须 401');
        r = await call('/api/stats');
        assert.strictEqual(r.status, 200, '有效密钥放行');
        assert.strictEqual(r.data.ok, true);

        // Bearer 也支持
        const res2 = await fetch(base + '/api/stats', { headers: { 'Authorization': 'Bearer ' + created.raw } });
        assert.strictEqual(res2.status, 200);

        // 入队 + 去重
        env.queue.pause();
        r = await call('/api/tasks', 'POST', { items: [{ gid: '123001', title: 'A' }, { gid: '123001', title: 'A' }, { gid: 'x' }] });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.added.length, 1);
        assert.strictEqual(r.data.skipped.length, 2);

        // 查询任务
        r = await call('/api/tasks?gid=123001');
        assert.strictEqual(r.data.tasks.length, 1);
        assert.strictEqual(r.data.tasks[0].folder, 'A [123001]');

        // 密钥管理
        r = await call('/api/keys', 'POST', { name: '第二把钥匙' });
        assert.strictEqual(r.status, 200);
        assert.ok(r.data.rawKey.startsWith('nhk_'));
        const newKeyId = r.data.key.id;
        r = await call('/api/keys');
        assert.strictEqual(r.data.keys.length, 2);
        assert.ok(!JSON.stringify(r.data).includes(created.raw), '列表不得回显明文');
        r = await call('/api/keys/' + newKeyId, 'DELETE');
        assert.strictEqual(r.status, 200);

        // 最后一把密钥不可吊销
        r = await call('/api/keys/' + created.record.id, 'DELETE');
        assert.strictEqual(r.status, 400, '至少保留一把密钥');

        // 设置校验：未知键拒绝，合法键保存
        r = await call('/api/settings', 'PUT', { settings: { evilKey: 1 } });
        assert.strictEqual(r.status, 400);
        r = await call('/api/settings', 'PUT', { settings: { requestIntervalMs: 321, convertToWebp: true } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.settings.requestIntervalMs, 321);

        // 日志接口
        r = await call('/api/logs?since=0');
        assert.strictEqual(r.status, 200);
        assert.ok(Array.isArray(r.data.logs));
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('POST /api/cookie：脚本自动同步浏览器 Cookie（解 403）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (p, method, body) => {
        const res = await fetch(base + p, {
            method: method || 'GET',
            headers: Object.assign({ 'X-API-Key': created.raw }, body ? { 'Content-Type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    try {
        let r = await call('/api/cookie', 'POST', { cookie: 'cf_clearance=xyz; session=abc' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(env.config.get('nhCookie'), 'cf_clearance=xyz; session=abc', 'Cookie 应保存到 nhCookie');

        r = await call('/api/stats');
        assert.strictEqual(r.data.cookieSet, true, 'stats 应报告 cookieSet=true');

        r = await call('/api/cookie', 'POST', { cookie: '' });
        assert.strictEqual(r.status, 400, '空 cookie 应被拒绝');

        const noKey = await fetch(base + '/api/cookie', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie: 'x=1' })
        });
        assert.strictEqual(noKey.status, 401, '无密钥不得写入 Cookie');
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('GET/PUT /api/state：前端状态云端持久化（并集 + 快照替换 + 鉴权）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const state = new StateStore(env.tmp);
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (p, method, body) => {
        const res = await fetch(base + p, {
            method: method || 'GET',
            headers: Object.assign({ 'X-API-Key': created.raw }, body ? { 'Content-Type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    try {
        // 上传浏览器状态（含非法 gid 应被过滤）
        let r = await call('/api/state', 'PUT', { state: {
            downloadedGids: ['111', '222', 'abc'],
            checked: { '333': '标题A', '444': '标题B' },
            downloadingGids: ['555'],
            pushedGids: { '555': 1700000000000 }
        } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([...r.data.state.downloadedGids].sort(), ['111', '222'], '非法 gid 应过滤');
        assert.strictEqual(r.data.state.checked['333'], '标题A');

        // 快照替换：取消勾选 444 应同步移除
        r = await call('/api/state', 'PUT', { state: { checked: { '333': '标题A' } } });
        assert.deepStrictEqual(Object.keys(r.data.state.checked), ['333'], '勾选状态快照替换');

        // 并集：已下载清单不回退
        r = await call('/api/state', 'PUT', { state: { downloadedGids: ['666'] } });
        assert.deepStrictEqual([...r.data.state.downloadedGids].sort(), ['111', '222', '666'], '已下载并集合并');

        // GET 应合并服务端已完成任务的 gid
        env.store.add({ id: 'fake-done', gid: '999', status: 'completed', title: 't', folder: 'f', pages: [], createdAt: '2026-01-01T00:00:00Z' });
        r = await call('/api/state', 'GET');
        assert.ok(r.data.state.downloadedGids.includes('999'), 'GET 应包含已完成任务');
        assert.ok(r.data.state.downloadedGids.includes('666'), 'GET 应包含云端清单');

        // 无密钥不得读写
        const noKey = await fetch(base + '/api/state', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        assert.strictEqual(noKey.status, 401);
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('POST /api/queue/clear-completed：清空已下载记录（磁盘保留）+ 历史记录备份/导入', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const state = new StateStore(env.tmp);
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (p, method, body) => {
        const res = await fetch(base + p, {
            method: method || 'GET',
            headers: Object.assign({ 'X-API-Key': created.raw }, body ? { 'Content-Type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    try {
        // 造两条已完成 + 一条排队中的任务
        env.store.add({ id: 'd1', gid: '111', status: 'completed', title: '本子A', folder: 'f', pages: [], createdAt: '2026-01-01T00:00:00Z' });
        env.store.add({ id: 'd2', gid: '222', status: 'completed', title: '本子B', folder: 'f', pages: [], createdAt: '2026-01-02T00:00:00Z' });
        env.store.add({ id: 'q1', gid: '333', status: 'queued', title: '本子C', folder: 'f', pages: [], createdAt: '2026-01-03T00:00:00Z' });

        // 历史记录导入（油猴备份格式：纯数组 / 对象格式）
        let r = await call('/api/history/import', 'POST', ['444', '555', '444']);
        assert.strictEqual(r.data.added, 2, '去重后新增 2 条');
        r = await call('/api/history/import', 'POST', { gids: ['666'] });
        assert.strictEqual(r.data.added, 1, '对象格式 {gids:[...]} 亦可导入');

        // 历史列表：云端清单 ∪ 已完成任务（仅记录 gid，不记录/返回标题）
        r = await call('/api/history');
        const gids = r.data.gids;
        for (const g of ['444', '555', '666', '111', '222']) assert.ok(gids.includes(g), `历史应含 ${g}`);
        assert.ok(!gids.includes('333'), '排队中的任务不算历史下载');
        assert.ok(gids.every(g => typeof g === 'string'), '历史条目应仅为 gid 字符串');
        assert.ok(!JSON.stringify(r.data).includes('本子A'), '历史接口不应记录/返回标题');

        // 导出为与前端一致的 JSON 数组
        const res2 = await fetch(base + '/api/history/export', { headers: { 'X-API-Key': created.raw } });
        assert.strictEqual(res2.status, 200);
        assert.ok(/attachment/.test(res2.headers.get('content-disposition') || ''), '导出应为附件下载');
        const arr = await res2.json();
        assert.ok(Array.isArray(arr) && arr.includes('444') && arr.includes('111'), '导出为 gid 数组');

        // 清空已下载：仅移除 completed 任务记录（磁盘保留）
        r = await call('/api/queue/clear-completed', 'POST');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.removed, 2);
        assert.strictEqual(env.store.list({ status: 'completed' }).length, 0);
        assert.strictEqual(env.store.list({ status: 'queued' }).length, 1, '排队中的任务应保留');

        // 清空后：云端导入的历史记录仍然保留
        r = await call('/api/history');
        const gids2 = r.data.gids;
        for (const g of ['444', '555', '666']) assert.ok(gids2.includes(g), `清空后云端历史应保留 ${g}`);
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('POST /api/cdn/test：CDN 节点延迟测量（含不可达节点）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state: new StateStore(env.tmp)
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const res = await fetch(base + '/api/cdn/test', {
            method: 'POST',
            headers: { 'X-API-Key': created.raw, 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: [`http://127.0.0.1:${mock.port}/cdn1`, `http://127.0.0.1:${mock.port}/cdn2`, 'http://127.0.0.1:1/unreachable'] })
        });
        assert.strictEqual(res.status, 200);
        const d = await res.json();
        assert.strictEqual(d.results.length, 3);
        assert.ok(d.results[0].ok && typeof d.results[0].latencyMs === 'number', '可达节点应有延迟数值');
        assert.ok(d.results[1].ok, '第二个节点可达');
        const bad = d.results.find(r => r.url.includes('unreachable'));
        assert.ok(bad && !bad.ok, '不可达节点应标记失败');
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('部分失败重试：仅重新下载失败的页（成功页不重复请求）', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('2.png', ['500', '500']);   // 首轮两个节点均失败
    const env = makeEnv(mock);
    env.config.data.maxAttempts = 1;
    env.config.data.repairRounds = 0;
    try {
        const { added } = env.queue.enqueue([{
            gid: '123001', title: '[作者A] 测试本子标题',
            meta: { mediaId: '900001', numPages: 3, extMap: ['jpg', 'png', 'webp'], coverHost: null }
        }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '首次下载');
        assert.strictEqual(task.status, 'completed_with_errors', '应为部分失败');
        assert.strictEqual(task.done, 2);
        assert.strictEqual(task.failed, 1);

        const hitsOf = (f) => mock.state.hits.filter(h => h.file === f).length;
        const before = { '1.jpg': hitsOf('1.jpg'), '2.png': hitsOf('2.png'), '3.webp': hitsOf('3.webp') };

        env.queue.retry(task.id);
        const done = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t.status === 'completed' ? t : null;
        }, 15000, '补齐完成');
        assert.strictEqual(done.done, 3, '补齐后全部完成');
        assert.strictEqual(hitsOf('1.jpg'), before['1.jpg'], '成功页不应重复请求');
        assert.strictEqual(hitsOf('3.webp'), before['3.webp'], '成功页不应重复请求');
        assert.ok(hitsOf('2.png') > before['2.png'], '仅失败页被重新请求');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('zip 打包排除 SMB/FUSE 垃圾文件（.fuse_hidden / Thumbs.db / .part）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    env.config.data.zipAfterVerify = true;
    env.config.data.keepFolderAfterZip = true;
    try {
        const { added } = env.queue.enqueue([{
            gid: '123001', title: '[作者A] 测试本子标题',
            meta: { mediaId: '900001', numPages: 3, extMap: ['jpg', 'png', 'webp'], coverHost: null }
        }]);
        env.queue.start();
        await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');

        const dir = path.join(env.config.get('downloadDir'), '[作者A] 测试本子标题 [123001]');
        // 模拟 SMB/FUSE 挂载产生的垃圾文件
        fs.writeFileSync(path.join(dir, '.fuse_hidden0a798aec0000b986'), 'junk');
        fs.writeFileSync(path.join(dir, 'Thumbs.db'), 'junk');
        fs.writeFileSync(path.join(dir, 'desktop.ini'), 'junk');
        fs.writeFileSync(path.join(dir, '5.part'), 'junk');

        const zipPath = path.join(env.config.get('downloadDir'), 'junk-test.zip');
        const r = createZipFromDir(dir, zipPath);
        assert.strictEqual(r.entries, 3, '垃圾文件与 .part 不应进包');
        assert.deepStrictEqual(readZipEntries(zipPath).map(e => e.name), ['1.jpg', '2.png', '3.webp']);
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('GET /api/sync：轻量同步接口（已下载/下载中/失败/最近完成，无 pages 明细）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state: new StateStore(env.tmp)
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        env.store.add({ id: 'c1', gid: '111', status: 'completed', title: 'T1', folder: 'f', pages: [{ n: 1 }], createdAt: '2026-01-01T00:00:00Z', finishedAt: new Date().toISOString() });
        env.store.add({ id: 'q1', gid: '222', status: 'queued', title: 'T2', folder: 'f', pages: [], createdAt: '2026-01-01T00:00:00Z' });
        env.store.add({ id: 'f1', gid: '333', status: 'failed', title: 'T3', folder: 'f', pages: [], createdAt: '2026-01-01T00:00:00Z', error: 'boom' });

        const res = await fetch(base + '/api/sync', { headers: { 'X-API-Key': created.raw } });
        assert.strictEqual(res.status, 200);
        const raw = await res.text();
        assert.ok(!raw.includes('"pages"'), '轻量接口不应包含 pages 明细');
        const d = JSON.parse(raw);
        assert.ok(d.downloadedGids.includes('111'));
        assert.ok(d.downloadingGids.includes('222'));
        assert.ok((d.failed || []).some(f => f.gid === '333' && f.error === 'boom'));
        assert.ok((d.recentDone || []).some(x => x.gid === '111' && x.title === 'T1'));
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('「下载中」标记对账：云端标记保留 / 终态剪枝 / 24h TTL / 多客户端并集不互删', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const state = new StateStore(env.tmp);
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (p, method, body) => {
        const res = await fetch(base + p, {
            method: method || 'GET',
            headers: Object.assign({ 'X-API-Key': created.raw }, body ? { 'Content-Type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    try {
        const now = Date.now();
        // 页签 A 打标 555；页签 B 随后上传不含 555 的旧快照——并集合并，不得互删（多页签互扰回归测试）
        await call('/api/state', 'PUT', { state: { downloadingGids: ['555'], pushedGids: { '555': now } } });
        let r = await call('/api/state', 'PUT', { state: { downloadingGids: ['666'], pushedGids: { '666': now } } });
        assert.ok(r.data.state.downloadingGids.includes('555'), '其他页签的下载中标记不得被旧快照清掉');
        assert.ok(r.data.state.downloadingGids.includes('666'));

        // 任务：111 已完成 / 222 失败 / 333 排队中；777 无任务且推送已超 24h
        env.store.add({ id: 'n1', gid: '111', status: 'completed', title: 'T1', folder: 'f', pages: [], createdAt: '2026-01-01T00:00:00Z', finishedAt: new Date().toISOString() });
        env.store.add({ id: 'n2', gid: '222', status: 'failed', title: 'T2', folder: 'f', pages: [], createdAt: '2026-01-01T00:00:00Z', error: 'boom' });
        env.store.add({ id: 'n3', gid: '333', status: 'queued', title: 'T3', folder: 'f', pages: [], createdAt: '2026-01-01T00:00:00Z' });
        await call('/api/state', 'PUT', { state: {
            downloadingGids: ['111', '222', '333', '777'],
            pushedGids: { '111': now, '222': now, '777': now - 25 * 3600 * 1000 }
        } });

        r = await call('/api/sync');
        const d = r.data;
        assert.ok(d.downloadedGids.includes('111'), '已完成应在已下载清单');
        assert.ok(d.downloadingGids.includes('555') && d.downloadingGids.includes('666'), '云端「下载中」标记（无活动任务）不应被丢弃');
        assert.ok(d.downloadingGids.includes('333'), '活动任务应在下载中');
        assert.ok(!d.downloadingGids.includes('111'), '已完成不显示下载中');
        assert.ok(!d.downloadingGids.includes('222'), '失败任务的黄标应剪枝');
        assert.ok(!d.downloadingGids.includes('777'), '无任务且推送超 24h 的残留标记应过期');

        // 对账结果写回 state.json（唯一事实源）
        r = await call('/api/state', 'GET');
        assert.ok(!r.data.state.downloadingGids.includes('777'), '过期标记应从云端剪除');
        assert.ok(r.data.state.downloadingGids.includes('555'), '有效标记应保留在云端');
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('标题兜底与自愈：meta.title 替代 gid 占位标题；下载启动时修正标题并重算文件夹', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    try {
        // ① 入队：title 是 gid 占位（DOM 提取失败回退）→ 用 meta.title
        let r = env.queue.enqueue([{
            gid: '123001', title: '123001',
            meta: { title: '[作者A] 测试本子标题', mediaId: '900001', numPages: 3, extMap: ['jpg', 'png', 'webp'], coverHost: null }
        }]);
        assert.strictEqual(r.added[0].title, '[作者A] 测试本子标题', 'gid 占位标题应被 meta.title 替代');
        assert.strictEqual(r.added[0].folder, '[作者A] 测试本子标题 [123001]');

        // ② 无任何标题 → gid 兜底（向后兼容）
        r = env.queue.enqueue([{ gid: '123002', title: '' }]);
        assert.strictEqual(r.added[0].title, '123002', '无标题时用 gid 兜底');

        // ③ 下载自愈：title=gid 且不带 meta → 服务端抓元数据后修正标题并重算文件夹
        const { added } = env.queue.enqueue([{ gid: '123003', title: '123003' }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');

        assert.strictEqual(task.status, 'completed');
        assert.strictEqual(task.title, '[作者C] 完整性补齐', '下载启动时应自愈标题（原为 gid 占位）');
        assert.strictEqual(task.folder, '[作者C] 完整性补齐 [123003]', '文件夹名应按修正后的标题重算');
        const dir = path.join(env.config.get('downloadDir'), '[作者C] 完整性补齐 [123003]');
        assert.deepStrictEqual(filesOf(dir), ['1.jpg', '2.jpg', '3.png']);
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('元数据自愈通道：缺 meta 任务补挂 / needMeta 通告 / 旧版 apiUrlTemplate 遗留自动清理', async () => {
    // ① 旧版本遗留的官方 API 模板自动清空（否则缺 meta 的任务会去请求官方 API，与"默认禁用"不符）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-test-cfg-'));
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ apiUrlTemplate: 'https://nhentai.net/api/gallery/{gid}' }), 'utf8');
    const cfg = new Config(tmp);
    assert.strictEqual(cfg.get('apiUrlTemplate'), '', '旧版本遗留的官方 API 模板应自动清空');
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ apiUrlTemplate: 'https://example.com/api/{gid}' }), 'utf8');
    const cfg2 = new Config(tmp);
    assert.strictEqual(cfg2.get('apiUrlTemplate'), 'https://example.com/api/{gid}', '用户显式配置的其它模板不受迁移影响');

    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const state = new StateStore(env.tmp);
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        // ② 队列中缺 meta 的任务允许补挂（updated）+ gid 占位标题/文件夹名自愈
        const { added } = env.queue.enqueue([{ gid: '123001', title: '123001' }]);   // 无 meta、标题是 gid 占位
        const r2 = env.queue.enqueue([{
            gid: '123001', title: '123001',
            meta: { title: '[作者A] 测试本子标题', mediaId: '900001', numPages: 3, extMap: ['jpg', 'png', 'webp'], coverHost: null }
        }]);
        assert.strictEqual(r2.updated.length, 1, '排队中缺 meta 的任务应补挂而不是跳过');
        assert.strictEqual(r2.skipped.length, 0);
        const task = env.store.get(added[0].id);
        assert.ok(task.meta && task.meta.mediaId === '900001', 'meta 应补挂成功');
        assert.strictEqual(task.title, '[作者A] 测试本子标题', 'gid 占位标题应随 meta 自愈');
        assert.strictEqual(task.folder, '[作者A] 测试本子标题 [123001]');

        // ③ /api/sync 通告 needMeta：缺 meta 的活动/失败任务（浏览器在详情页时自动补挂）
        env.store.add({ id: 'f1', gid: '222', status: 'failed', title: 'T2', folder: 'f', pages: [], createdAt: '2026-01-01T00:00:00Z', error: 'x' });
        env.store.add({ id: 'c1', gid: '333', status: 'completed', title: 'T3', folder: 'f', pages: [], meta: { mediaId: '1' }, createdAt: '2026-01-01T00:00:00Z' });
        const res = await fetch(base + '/api/sync', { headers: { 'X-API-Key': created.raw } });
        const d = await res.json();
        assert.ok(d.needMeta.includes('222'), '缺 meta 的失败任务应通告 needMeta（浏览器可补挂后自动重新入队）');
        assert.ok(!d.needMeta.includes('123001'), '已补挂 meta 的任务不应再通告');
        assert.ok(!d.needMeta.includes('333'), '已完成任务不通告 needMeta');
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('Web 登录：账号密码 + 会话 Cookie + 登出 + 修改密码（API Key 保持可用）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    const created = keys.create('测试密钥');
    const auth = new AuthManager({ dataDir: env.tmp, config: env.config, logger: env.logger });
    const boot = auth.ensureBootstrapUser();
    assert.ok(boot && boot.username === 'admin' && boot.password, '首次启动应生成登录账号');
    assert.ok(fs.existsSync(path.join(env.tmp, 'INITIAL_PASSWORD.txt')), '初始密码应写入 INITIAL_PASSWORD.txt');

    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state: new StateStore(env.tmp), auth
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, cookie) => fetch(base + p, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
        body: JSON.stringify(body)
    });
    try {
        // 登录配置公开
        let res = await fetch(base + '/api/auth/config');
        let d = await res.json();
        assert.strictEqual(d.oidc, false, '未配置 OIDC 时 oidc=false（前端显示账号密码入口）');
        assert.strictEqual(d.passwordLogin, true);

        // 错误密码拒绝
        res = await post('/api/auth/login', { username: 'admin', password: 'wrong' });
        assert.strictEqual(res.status, 401);

        // 正确密码 → HttpOnly 会话 Cookie
        res = await post('/api/auth/login', { username: boot.username, password: boot.password });
        assert.strictEqual(res.status, 200);
        const setCookie = res.headers.get('set-cookie') || '';
        assert.ok(/nh_sid=/.test(setCookie) && /HttpOnly/.test(setCookie), '会话应为 HttpOnly Cookie');
        const sid = setCookie.split(';')[0];

        // 无凭据 401；带会话放行
        res = await fetch(base + '/api/stats');
        assert.strictEqual(res.status, 401);
        res = await fetch(base + '/api/stats', { headers: { Cookie: sid } });
        assert.strictEqual(res.status, 200, '会话 Cookie 应可访问 API');

        res = await fetch(base + '/api/auth/me', { headers: { Cookie: sid } });
        d = await res.json();
        assert.strictEqual(d.user.username, boot.username);
        assert.strictEqual(d.user.via, 'password');

        // 修改密码：旧密码失效、新密码可登录
        res = await post('/api/auth/password', { currentPassword: boot.password, newPassword: 'newpass123' }, sid);
        assert.strictEqual(res.status, 200);
        res = await post('/api/auth/login', { username: boot.username, password: boot.password });
        assert.strictEqual(res.status, 401, '旧密码应失效');
        res = await post('/api/auth/login', { username: boot.username, password: 'newpass123' });
        assert.strictEqual(res.status, 200);

        // 登出后旧会话失效
        res = await post('/api/auth/logout', {}, sid);
        assert.strictEqual(res.status, 200);
        res = await fetch(base + '/api/stats', { headers: { Cookie: sid } });
        assert.strictEqual(res.status, 401, '登出后会话应失效');

        // API Key（油猴脚本）保持可用
        res = await fetch(base + '/api/stats', { headers: { 'X-API-Key': created.raw } });
        assert.strictEqual(res.status, 200, 'API Key 鉴权应保持可用');
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('OIDC 单点登录全链路（Mock IdP：discovery / PKCE / RS256 验签 / 会话）', async () => {
    const crypto = require('crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'test-key', alg: 'RS256', use: 'sig' });
    let authReq = null;            // 由测试从授权跳转 URL 提取 { state, nonce, challenge }
    let pkceOk = false;

    const idp = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const idpBase = `http://127.0.0.1:${idp.address().port}`;
        const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (u.pathname === '/.well-known/openid-configuration') {
            json({
                issuer: idpBase,
                authorization_endpoint: idpBase + '/authorize',
                token_endpoint: idpBase + '/token',
                jwks_uri: idpBase + '/jwks'
            });
            return;
        }
        if (u.pathname === '/jwks') { json({ keys: [jwk] }); return; }
        if (u.pathname === '/token') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                const p = new URLSearchParams(body);
                // PKCE 校验：sha256(code_verifier) 必须等于授权请求里的 code_challenge
                const challenge = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
                pkceOk = challenge === authReq.challenge;
                const now = Math.floor(Date.now() / 1000);
                const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })).toString('base64url');
                const pl = Buffer.from(JSON.stringify({
                    // iss 带尾斜杠：模拟 authentik 等 IdP（配置的 Issuer 不带尾斜杠，比对应忽略尾斜杠）
                    iss: idpBase + '/', sub: 'user-001', aud: 'test-client',
                    exp: now + 600, iat: now, nonce: authReq.nonce, preferred_username: 'sso-user'
                })).toString('base64url');
                const signer = crypto.createSign('RSA-SHA256');
                signer.update(h + '.' + pl);
                const sig = signer.sign(privateKey).toString('base64url');
                json({ access_token: 'at', token_type: 'Bearer', id_token: `${h}.${pl}.${sig}` });
            });
            return;
        }
        res.writeHead(404); res.end();
    });
    await new Promise(r => idp.listen(0, '127.0.0.1', r));

    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    keys.create('k');
    env.config.data.oidcIssuer = `http://127.0.0.1:${idp.address().port}`;
    env.config.data.oidcClientId = 'test-client';
    const auth = new AuthManager({ dataDir: env.tmp, config: env.config, logger: env.logger });
    auth.ensureBootstrapUser();
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state: new StateStore(env.tmp), auth
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        // ① auth/config 报告 oidc 已启用（前端据此自动隐藏账号密码入口）
        let res = await fetch(base + '/api/auth/config');
        let d = await res.json();
        assert.strictEqual(d.oidc, true);

        // ② 发起登录 → 302 到 IdP（携带 PKCE / nonce / state）
        res = await fetch(base + '/auth/oidc/login', { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        const loc = new URL(res.headers.get('location'));
        assert.ok(loc.href.startsWith(`http://127.0.0.1:${idp.address().port}/authorize`), '应跳转到 IdP 授权端点');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.strictEqual(loc.searchParams.get('client_id'), 'test-client');
        authReq = {
            state: loc.searchParams.get('state'),
            nonce: loc.searchParams.get('nonce'),
            challenge: loc.searchParams.get('code_challenge')
        };

        // ③ 模拟 IdP 回跳 → 换 token + 验签 → 建会话
        res = await fetch(`${base}/auth/oidc/callback?code=good-code&state=${authReq.state}`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), base + '/', '登录成功应跳回应用基址（子路径部署含前缀）');
        const setCookie = res.headers.get('set-cookie') || '';
        assert.ok(/nh_sid=/.test(setCookie), 'OIDC 登录成功应创建会话');
        const sid = setCookie.split(';')[0];
        assert.ok(pkceOk, 'token 交换应通过 PKCE code_verifier 校验');

        res = await fetch(base + '/api/auth/me', { headers: { Cookie: sid } });
        d = await res.json();
        assert.strictEqual(d.user.username, 'sso-user');
        assert.strictEqual(d.user.via, 'oidc');

        // ④ 非法 state → 拒绝并引导到备用登录
        res = await fetch(`${base}/auth/oidc/callback?code=x&state=bogus`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.ok((res.headers.get('location') || '').includes('login=local'), 'OIDC 失败应引导到备用登录入口');

        // ⑤ state 一次性：重放同一 state 应失败
        res = await fetch(`${base}/auth/oidc/callback?code=good-code&state=${authReq.state}`, { redirect: 'manual' });
        assert.ok((res.headers.get('location') || '').includes('login=local'), 'state 不可重放');

        // ⑥ iss 仅忽略尾斜杠比对：不同域仍拒绝（尾斜杠兼容不等于放宽比对）
        const now6 = Math.floor(Date.now() / 1000);
        const h6 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })).toString('base64url');
        const pl6 = Buffer.from(JSON.stringify({
            iss: 'http://evil.example/', sub: 'x', aud: 'test-client', exp: now6 + 600, iat: now6
        })).toString('base64url');
        const signer6 = crypto.createSign('RSA-SHA256');
        signer6.update(h6 + '.' + pl6);
        const sig6 = signer6.sign(privateKey).toString('base64url');
        await assert.rejects(
            () => auth.verifyIdToken(`${h6}.${pl6}.${sig6}`, {
                issuer: env.config.data.oidcIssuer, audience: 'test-client',
                jwksUri: `http://127.0.0.1:${idp.address().port}/jwks`
            }),
            /iss 不匹配/,
            '不同域的 iss 必须拒绝'
        );
    } finally {
        server.close();
        idp.close();
        await env.queue.stop();
        mock.close();
    }
});

test('OIDC 跳转地址：子路径部署由 oidcRedirectUri 推导应用基址（回调/错误不丢前缀）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    keys.create('k');
    env.config.data.oidcIssuer = 'https://idp.example/application/o/app';
    env.config.data.oidcClientId = 'c';
    env.config.data.oidcRedirectUri = 'https://host.example/nhentai/auth/oidc/callback';
    const auth = new AuthManager({ dataDir: env.tmp, config: env.config, logger: env.logger });
    auth.ensureBootstrapUser();
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader, state: new StateStore(env.tmp), auth
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        // ① 回调失败（state 无效）→ 跳回带前缀的备用登录（不得丢 /nhentai）
        let res = await fetch(`${base}/auth/oidc/callback?code=x&state=bogus`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        const loc1 = res.headers.get('location') || '';
        assert.ok(loc1.startsWith('https://host.example/nhentai/?login=local'), `错误跳转应带应用基址，实际: ${loc1}`);
        assert.ok(loc1.includes('error='), '应携带错误信息');

        // ② 未配置 OIDC 时 /auth/oidc/login 同样跳回带前缀的登录页
        env.config.data.oidcIssuer = '';
        res = await fetch(`${base}/auth/oidc/login`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.ok((res.headers.get('location') || '').startsWith('https://host.example/nhentai/?login=local'),
            '未配置 OIDC 的跳转同样应带应用基址');
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

test('压缩后自动上传 LANraragi（Bearer 认证 / 标题 / source 标签 / SHA1）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    env.config.data.zipAfterVerify = true;
    env.config.data.lrrUrl = `http://127.0.0.1:${mock.port}`;
    env.config.data.lrrApiKey = 'secret';
    try {
        const { added } = env.queue.enqueue([{
            gid: '123001', title: '[作者A] 测试本子标题',
            meta: { mediaId: '900001', numPages: 3, extMap: ['jpg', 'png', 'webp'], coverHost: null }
        }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 20000, '任务完成');

        assert.strictEqual(task.status, 'completed');
        assert.ok(task.lrrUploaded && task.lrrUploaded.arcid, '任务应记录 LRR 上传结果');
        assert.ok(!task.lrrError, '不应有上传错误');

        const up = mock.state.lrrUploads[0];
        assert.ok(up, 'LANraragi 应收到上传请求');
        assert.strictEqual(up.method, 'PUT');
        assert.strictEqual(up.auth, 'Bearer ' + Buffer.from('secret', 'utf8').toString('base64'), '认证头应为 Bearer base64(api_key)');
        assert.ok(up.hasZipName && up.size > 0, '应上传 zip 文件');
        assert.ok(up.hasTitle, '应携带标题');
        assert.ok(up.hasSource, '应携带 source:nhentai.net/g/ 标签（与 LRR 插件闭环）');
        assert.ok(up.hasSha1Field, '应携带 SHA1 校验字段');

        // 默认（lrrDeleteZipAfterUpload=false）：上传成功后本地 zip 仍保留
        const zipPath = path.join(env.config.get('downloadDir'), '[作者A] 测试本子标题 [123001].zip');
        assert.ok(fs.existsSync(zipPath), '默认应保留本地 zip 压缩包');
        assert.ok(!task.zipDeletedAfterLrr, '默认不删除 zip');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('LRR 上传成功后可选自动删除本地 zip（lrrDeleteZipAfterUpload，删除仅发生在上传成功后）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    env.config.data.zipAfterVerify = true;
    env.config.data.lrrUrl = `http://127.0.0.1:${mock.port}`;
    env.config.data.lrrDeleteZipAfterUpload = true;
    try {
        const { added } = env.queue.enqueue([{
            gid: '123001', title: '[作者A] 测试本子标题',
            meta: { mediaId: '900001', numPages: 3, extMap: ['jpg', 'png', 'webp'], coverHost: null }
        }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 20000, '任务完成');

        assert.strictEqual(task.status, 'completed');
        assert.ok(task.lrrUploaded && task.lrrUploaded.arcid, '应上传成功');
        assert.ok(mock.state.lrrUploads.length >= 1, '应先完成上传再删除');
        assert.strictEqual(task.zipDeletedAfterLrr, true, '上传成功后应删除本地 zip');
        assert.ok(!task.zipDeleteError, '不应有删除错误');
        const zipPath = path.join(env.config.get('downloadDir'), '[作者A] 测试本子标题 [123001].zip');
        assert.ok(!fs.existsSync(zipPath), '本地 zip 压缩包应已删除');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('LRR 上传失败时绝不删除本地 zip（即使 lrrDeleteZipAfterUpload=true）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    env.config.data.zipAfterVerify = true;
    env.config.data.lrrUrl = 'http://127.0.0.1:1';   // 不可达地址：上传必失败
    env.config.data.lrrDeleteZipAfterUpload = true;
    try {
        const { added } = env.queue.enqueue([{
            gid: '123001', title: '[作者A] 测试本子标题',
            meta: { mediaId: '900001', numPages: 3, extMap: ['jpg', 'png', 'webp'], coverHost: null }
        }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 20000, '任务完成');

        assert.strictEqual(task.status, 'completed', '上传失败不影响任务本身');
        assert.ok(task.lrrError, '应记录上传失败');
        assert.ok(!task.zipDeletedAfterLrr, '上传失败不应删除 zip');
        const zipPath = path.join(env.config.get('downloadDir'), '[作者A] 测试本子标题 [123001].zip');
        assert.ok(fs.existsSync(zipPath), '本地 zip 压缩包应保留');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('URL 后缀与实际格式不符（1.png 实为 JPEG）→ 按实际格式保存且一次成功', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('1.png', 'jpeg');   // 每次请求 1.png 都返回 JPEG 内容（nhentai 真实存在的错位文件）
    const env = makeEnv(mock);
    try {
        const { added } = env.queue.enqueue([{
            gid: '123009', title: '[作者G] 后缀错位',
            meta: { mediaId: '900009', numPages: 1, extMap: ['png'], coverHost: null }
        }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');

        assert.strictEqual(task.status, 'completed', '内容是有效图片即应成功');
        assert.strictEqual(task.pages[0].file, '1.jpg', '应按实际格式 JPEG 保存为 1.jpg');
        const dir = path.join(env.config.get('downloadDir'), '[作者G] 后缀错位 [123009]');
        assert.deepStrictEqual(filesOf(dir), ['1.jpg']);

        assert.strictEqual(mock.state.hits.filter(h => h.file === '1.png').length, 1, '一次请求即成功，不再空转');
        assert.strictEqual(mock.state.hits.filter(h => h.file !== '1.png').length, 0, '无需尝试其它后缀/节点');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('非图片内容（拦截页）→ 报错含 content-type 与文件头十六进制', async () => {
    const mock = await createMockSite(GALLERY_1);
    for (const f of ['1.png', '1.jpg', '1.webp', '1.gif']) mock.plan(f, 'html');   // 所有后缀都返回 HTML
    const env = makeEnv(mock);
    env.config.data.maxAttempts = 1;
    env.config.data.repairRounds = 0;
    try {
        const { added } = env.queue.enqueue([{
            gid: '123009', title: '[作者G] 后缀错位',
            meta: { mediaId: '900009', numPages: 1, extMap: ['png'], coverHost: null }
        }]);
        env.queue.start();
        const task = await waitFor(() => {
            const t = env.store.get(added[0].id);
            return t && ['completed', 'completed_with_errors', 'failed'].includes(t.status) ? t : null;
        }, 15000, '任务完成');

        assert.strictEqual(task.status, 'failed');
        const err = (task.pages[0] && task.pages[0].error) || task.error || '';
        assert.ok(/内容不是图片/.test(err), '应明确说明返回的不是图片: ' + err);
        assert.ok(/text\/html/.test(err), '报错应包含 content-type');
        assert.ok(/文件头:/.test(err), '报错应包含文件头十六进制');
    } finally {
        await env.queue.stop();
        mock.close();
    }
});

test('残留文件夹清理：占用释放后自动删除（周期检测 + 队列持久化重启续跑）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-janitor-'));
    const downloads = path.join(tmp, 'dl');
    fs.mkdirSync(downloads);
    const dir1 = path.join(downloads, '残留本子 [123]');
    fs.mkdirSync(dir1);
    fs.writeFileSync(path.join(dir1, '1.jpg'), 'x');
    fs.writeFileSync(path.join(downloads, '残留本子 [123].zip'), 'zipdata');
    fs.writeFileSync(path.join(downloads, '残留本子 [123].zip.part'), 'junk');

    // 模拟占用：第一次删除抛 EBUSY，之后成功
    let calls = 0;
    const mk = (rmFn) => new FolderJanitor({
        dataDir: tmp, downloadDir: downloads, logger: null, intervalMs: 60000, rmFn
    });
    const janitor = mk((d) => {
        calls++;
        if (calls < 2) throw new Error('EBUSY: .fuse_hidden 占用中');
        fs.rmSync(d, { recursive: true, force: true });
    });

    janitor.enqueue(dir1, { gid: '123', folder: '残留本子 [123]', zip: '残留本子 [123].zip' });
    janitor.enqueue(dir1, { gid: '123' });   // 重复入队应去重
    assert.strictEqual(janitor.pending(), 1, '重复入队应去重');

    await janitor._tick();
    assert.ok(fs.existsSync(dir1), '占用中不应删除');
    assert.strictEqual(janitor.pending(), 1, '失败保留在队列继续重试');
    assert.ok(!fs.existsSync(path.join(downloads, '残留本子 [123].zip.part')), '顺带清理 .zip.part 残留');

    await janitor._tick();
    assert.ok(!fs.existsSync(dir1), '占用释放后应自动删除');
    assert.strictEqual(janitor.pending(), 0, '删除成功移出队列');

    // 重启场景：队列持久化到 cleanup.json，新实例继续清理
    const dir2 = path.join(downloads, '残留本子 [456]');
    fs.mkdirSync(dir2);
    const janitor2 = mk((d) => fs.rmSync(d, { recursive: true, force: true }));
    janitor2.enqueue(dir2, { gid: '456', folder: '残留本子 [456]' });
    const janitor3 = mk((d) => fs.rmSync(d, { recursive: true, force: true }));
    assert.strictEqual(janitor3.pending(), 1, '重启后队列从磁盘恢复');
    await janitor3._tick();
    assert.ok(!fs.existsSync(dir2), '重启后占用释放同样自动删除');

    // 安全护栏：下载目录之外的路径不删
    const outside = path.join(tmp, 'outside-dir');
    fs.mkdirSync(outside);
    const janitor4 = mk((d) => fs.rmSync(d, { recursive: true, force: true }));
    janitor4.enqueue(outside, { gid: '999' });
    await janitor4._tick();
    assert.ok(fs.existsSync(outside), '下载目录外的文件夹绝不能删');
});

test('Web 界面与静态资源可访问（无需密钥）', async () => {
    const mock = await createMockSite(GALLERY_1);
    const env = makeEnv(mock);
    const keys = new KeyStore(env.tmp, env.logger);
    keys.create('k');
    const handler = createHandler({
        config: env.config, store: env.store, keys, queue: env.queue,
        logger: env.logger, downloader: env.downloader
    });
    const server = http.createServer((req, res) => handler(req, res).catch(() => { res.writeHead(500); res.end(); }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const idx = await fetch(base + '/');
        assert.strictEqual(idx.status, 200);
        const html = await idx.text();
        assert.ok(html.includes('nHentai 下载服务'));
        assert.ok(html.includes('href="style.css') && html.includes('src="app.js') && html.includes('href="favicon.svg"'),
            '静态资源应使用相对路径（支持 /nhentai 子路径反代）');
        assert.ok(!html.includes('login=local'), '页面不得暴露备用登录入口（?login=local）');
        const css = await fetch(base + '/style.css');
        assert.strictEqual(css.status, 200);
        const js = await fetch(base + '/app.js');
        assert.strictEqual(js.status, 200);
        const jsText = await js.text();
        assert.ok(jsText.includes('data-act="open"') && jsText.includes('nhentai.net/g/'),
            '失败任务条目应提供一键跳转 nHentai 页面的按钮');
        assert.ok(jsText.includes('gid-link'), 'GID 应渲染为可点击的 nHentai 跳转链接');
    } finally {
        server.close();
        await env.queue.stop();
        mock.close();
    }
});

/**************************************************************************
 * 运行器
 *************************************************************************/
(async () => {
    let pass = 0;
    let fail = 0;
    console.log('==========================================');
    console.log(' nHentai 下载服务 自动化测试');
    console.log('==========================================');
    for (const t of tests) {
        const t0 = Date.now();
        try {
            await t.fn();
            pass++;
            console.log(`  ✓ ${t.name}  (${Date.now() - t0}ms)`);
        } catch (e) {
            fail++;
            console.error(`  ✗ ${t.name}`);
            console.error('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e));
        }
    }
    console.log('------------------------------------------');
    console.log(`  通过 ${pass} / ${tests.length}，失败 ${fail}`);
    console.log('==========================================');
    process.exit(fail > 0 ? 1 : 0);
})();

