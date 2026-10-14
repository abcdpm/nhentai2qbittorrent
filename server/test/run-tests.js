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
const { readZipEntries, extractZipEntry, crc32, numericNameCompare } = require('../src/zip');

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
        metaHits: []
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

        if (parts[0] === 'api' && parts[1]) {
            state.metaHits.push({ kind: 'api', id: parts[1], cookie: req.headers.cookie || '' });
            const action = planFor('api', parts[1]);
            if (action === '403') { res.writeHead(403); res.end('cf challenge'); return; }
            const g = state.galleries[parts[1]];
            if (!g) { res.writeHead(404); res.end('not found'); return; }
            const json = {
                id: parts[1],
                media_id: g.mediaId,
                num_pages: g.types.length,
                title: { pretty: g.title, english: g.title },
                images: { pages: g.types.map(t => ({ t })) }
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
    '123005': { mediaId: '900005', title: '[作者E] WebP转换', types: ['j', 'g'] }
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

test('元数据 403 自动回退 JSON API 备用源，并携带配置的 Cookie', async () => {
    const mock = await createMockSite(GALLERY_1);
    mock.plan('html|123001', '403');          // 详情页持续 403
    const env = makeEnv(mock);
    env.config.data.nhCookie = 'cf_clearance=abc123';
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

        const apiHit = mock.state.metaHits.find(h => h.kind === 'api' && h.id === '123001');
        assert.ok(apiHit, '应请求过 JSON API 备用源');
        assert.strictEqual(apiHit.cookie, 'cf_clearance=abc123', '元数据请求应携带配置的 Cookie');
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
        const css = await fetch(base + '/style.css');
        assert.strictEqual(css.status, 200);
        const js = await fetch(base + '/app.js');
        assert.strictEqual(js.status, 200);
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

