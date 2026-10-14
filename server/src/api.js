'use strict';
const fs = require('fs');
const path = require('path');
const { parse } = require('url');

const VERSION = '1.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
        });
        req.on('error', reject);
    });
}

function extractApiKey(req, query) {
    const h = req.headers['x-api-key'];
    if (h) return String(h).trim();
    const auth = req.headers.authorization;
    if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    if (query && query.api_key) return String(query.api_key).trim();
    return null;
}

function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
                if (err2) { res.writeHead(404); res.end('Not Found'); return; }
                res.writeHead(200, { 'Content-Type': MIME['.html'] });
                res.end(html);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
}

/**
 * 创建请求处理器。依赖注入：{ config, store, keys, queue, logger, downloader }
 * 所有 /api/* 均需 X-API-Key 鉴权（避免公网骚扰）。
 */
function createHandler(ctx) {
    const { config, store, keys, queue, logger, downloader } = ctx;

    return async function handler(req, res) {
        const parsed = parse(req.url, true);
        const pathname = decodeURIComponent(parsed.pathname || '/');
        const query = parsed.query || {};
        const method = req.method || 'GET';

        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
            });
            res.end();
            return;
        }

        if (!pathname.startsWith('/api/')) {
            serveStatic(res, pathname);
            return;
        }

        // ---- 鉴权 ----
        const rawKey = extractApiKey(req, query);
        const keyInfo = rawKey ? keys.verify(rawKey) : null;
        if (!keyInfo) {
            sendJson(res, 401, { ok: false, error: '未授权：请提供有效的 API Key（请求头 X-API-Key 或 Authorization: Bearer）' });
            return;
        }

        try {
            if (pathname === '/api/stats' && method === 'GET') {
                sendJson(res, 200, {
                    ok: true,
                    version: VERSION,
                    counts: store.counts(),
                    paused: queue.paused,
                    currentTaskId: queue.current,
                    sharpAvailable: downloader.converter._load(),
                    cookieSet: !!config.get('nhCookie'),
                    downloadDir: config.get('downloadDir'),
                    keyName: keyInfo.name
                });
                return;
            }

            // ---- 任务 ----
            if (pathname === '/api/tasks' && method === 'GET') {
                const list = store.list({ status: query.status, gid: query.gid });
                sendJson(res, 200, { ok: true, tasks: list, counts: store.counts() });
                return;
            }

            if (pathname === '/api/tasks' && method === 'POST') {
                const body = await readBody(req);
                let items = [];
                if (Array.isArray(body.items)) items = body.items;
                else if (Array.isArray(body.gids)) {
                    const titles = Array.isArray(body.titles) ? body.titles : [];
                    items = body.gids.map((g, i) => ({ gid: g, title: titles[i] || '' }));
                }
                if (items.length === 0) {
                    sendJson(res, 400, { ok: false, error: '请求体为空：请提供 items:[{gid,title}] 或 gids:[gid]' });
                    return;
                }
                const result = queue.enqueue(items);
                sendJson(res, 200, {
                    ok: true,
                    added: result.added.map(t => ({ id: t.id, gid: t.gid, title: t.title, folder: t.folder, status: t.status })),
                    skipped: result.skipped,
                    counts: store.counts()
                });
                return;
            }

            const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(retry|cancel))?$/);
            if (taskMatch) {
                const id = taskMatch[1];
                const action = taskMatch[2];
                const task = store.get(id);
                if (!task) { sendJson(res, 404, { ok: false, error: '任务不存在' }); return; }

                if (!action && method === 'GET') { sendJson(res, 200, { ok: true, task }); return; }
                if (!action && method === 'DELETE') { sendJson(res, 200, queue.remove(id)); return; }
                if (action === 'retry' && method === 'POST') {
                    const r = queue.retry(id);
                    sendJson(res, r.ok ? 200 : 400, r);
                    return;
                }
                if (action === 'cancel' && method === 'POST') {
                    const r = queue.cancel(id);
                    sendJson(res, r.ok ? 200 : 400, r);
                    return;
                }
                sendJson(res, 405, { ok: false, error: '方法不允许' });
                return;
            }

            // ---- 队列控制 ----
            if (pathname === '/api/queue/pause' && method === 'POST') {
                queue.pause();
                sendJson(res, 200, { ok: true, paused: true });
                return;
            }
            if (pathname === '/api/queue/resume' && method === 'POST') {
                queue.resume();
                sendJson(res, 200, { ok: true, paused: false });
                return;
            }
            if (pathname === '/api/queue/retry-failed' && method === 'POST') {
                sendJson(res, 200, queue.retryFailed());
                return;
            }

            // ---- Cookie 同步（油猴脚本自动上传浏览器 Cookie，解除 Cloudflare 403）----
            if (pathname === '/api/cookie' && method === 'POST') {
                const body = await readBody(req);
                const cookie = String(body.cookie || '').trim();
                if (!cookie) {
                    sendJson(res, 400, { ok: false, error: 'cookie 为空' });
                    return;
                }
                if (cookie.length > 8192) {
                    sendJson(res, 400, { ok: false, error: 'cookie 过长' });
                    return;
                }
                const r = config.update({ nhCookie: cookie });
                if (!r.ok) { sendJson(res, 400, { ok: false, error: r.errors.join('；') }); return; }
                logger.info('浏览器 Cookie 已同步（将用于元数据/图片请求；内容不记录日志）');
                sendJson(res, 200, { ok: true });
                return;
            }

            // ---- 设置 ----
            if (pathname === '/api/settings' && method === 'GET') {
                sendJson(res, 200, { ok: true, settings: config.all(), sharpAvailable: downloader.converter._load() });
                return;
            }
            if (pathname === '/api/settings' && method === 'PUT') {
                const body = await readBody(req);
                const r = config.update(body.settings || body);
                if (!r.ok) { sendJson(res, 400, { ok: false, error: r.errors.join('；') }); return; }
                logger.info('设置已更新');
                sendJson(res, 200, { ok: true, settings: r.data });
                return;
            }

            // ---- API 密钥管理 ----
            if (pathname === '/api/keys' && method === 'GET') {
                sendJson(res, 200, { ok: true, keys: keys.list() });
                return;
            }
            if (pathname === '/api/keys' && method === 'POST') {
                const body = await readBody(req);
                const created = keys.create(body.name || '新密钥');
                logger.info(`已生成新 API Key: ${created.record.name} (${created.record.prefix}…)`);
                sendJson(res, 200, { ok: true, key: created.record, rawKey: created.raw });
                return;
            }
            const keyMatch = pathname.match(/^\/api\/keys\/([^/]+)$/);
            if (keyMatch && method === 'DELETE') {
                const r = keys.revoke(keyMatch[1]);
                if (r.ok) logger.warn('已吊销一枚 API Key');
                sendJson(res, r.ok ? 200 : 400, r);
                return;
            }

            // ---- 日志 ----
            if (pathname === '/api/logs' && method === 'GET') {
                sendJson(res, 200, { ok: true, logs: logger.since(query.since), latest: logger.seq });
                return;
            }

            sendJson(res, 404, { ok: false, error: '接口不存在' });
        } catch (e) {
            if (e.message === 'JSON 解析失败' || e.message === '请求体过大') {
                sendJson(res, 400, { ok: false, error: e.message });
                return;
            }
            logger.error(`API 处理异常: ${e.message}`);
            sendJson(res, 500, { ok: false, error: e.message });
        }
    };
}

module.exports = { createHandler, VERSION };

