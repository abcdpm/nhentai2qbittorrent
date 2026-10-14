'use strict';
const { stripTags, parseRetryAfter, sleep } = require('./util');

const TYPE_MAP = { j: 'jpg', p: 'png', g: 'gif', w: 'webp' };

/**
 * 从本子详情页 HTML 中提取元数据（与油猴脚本同一套解析逻辑）。
 * 返回：{ gid, mediaId, numPages, title, extMap, coverHost }
 */
function parseGalleryHtml(html, gid) {
    let mediaId = null;
    let numPages = null;
    let extMap = [];
    let coverHost = null;

    const mediaMatch = html.match(/"media_id":\s*"?(\d+)"?/) || html.match(/\/galleries\/(\d+)\//);
    if (mediaMatch) mediaId = mediaMatch[1];

    const numMatch = html.match(/"num_pages":\s*(\d+)/);
    if (numMatch) numPages = parseInt(numMatch[1], 10);
    if (!numPages) {
        const pm = html.match(/pages%3A(\d+)/) || html.match(/Pages:[\s\S]*?<span class="name">(\d+)<\/span>/);
        if (pm) numPages = parseInt(pm[1], 10);
    }

    // 封面 CDN 节点推导：t2.nhentai.net -> i2.nhentai.net（保留其余域名部分，兼容镜像/测试源）
    const coverMatch = html.match(/https:\/\/((t\d+)\.[^"'/]+)\/galleries\/\d+\/cover\.(jpg|png|gif|webp)/);
    if (coverMatch) {
        coverHost = 'https://' + coverMatch[2].replace(/^t/, 'i') + coverMatch[1].slice(coverMatch[2].length);
    }

    const pagesBlock = html.match(/"pages":\s*\[(.*?)\]/);
    if (pagesBlock) {
        const tMatches = [...pagesBlock[1].matchAll(/"t":"([jpgw])"/g)];
        if (tMatches.length > 0) extMap = tMatches.map(m => TYPE_MAP[m[1]] || 'jpg');
    }

    let title = null;
    const h = html.match(/<h[12][^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h[12]>/);
    if (h) title = stripTags(h[1]).replace(/\s+/g, ' ').trim();
    if (!title) {
        const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/);
        if (og) title = stripTags(og[1]).replace(/\s*\|\s*nhentai.*$/i, '').trim();
    }
    if (!title) title = `gallery-${gid}`;

    return { gid: String(gid), mediaId, numPages, title, extMap, coverHost };
}

/** 解析官方 JSON API（/api/gallery/{gid}）响应，与 HTML 解析结果同构 */
function parseGalleryApi(json, gid) {
    if (!json || typeof json !== 'object') return null;
    const pages = json.images && Array.isArray(json.images.pages) ? json.images.pages : [];
    const mediaId = json.media_id != null ? String(json.media_id) : null;
    const numPages = json.num_pages || pages.length;
    const title = (json.title && (json.title.pretty || json.title.english || json.title.japanese)) || `gallery-${gid}`;
    const extMap = pages.map(p => TYPE_MAP[p && p.t] || 'jpg');
    return { gid: String(gid), mediaId, numPages, title, extMap, coverHost: null };
}

class RateLimitError extends Error {
    constructor(retryAfterSec) {
        super(`429 Too Many Requests${retryAfterSec ? ` (retry after ${retryAfterSec}s)` : ''}`);
        this.name = 'RateLimitError';
        this.retryAfterSec = retryAfterSec || 30;
    }
}

/** 浏览器风格请求头（可选带 Cookie —— Cloudflare 403 的常用解法） */
function browserHeaders(config, isApi) {
    const headers = {
        'User-Agent': config.get('userAgent'),
        'Accept': isApi
            ? 'application/json, text/javascript, */*; q=0.01'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8,zh-CN;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };
    if (!isApi) {
        headers['Upgrade-Insecure-Requests'] = '1';
        headers['Sec-Fetch-Dest'] = 'document';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'none';
        headers['Sec-Fetch-User'] = '?1';
    }
    const cookie = config.get('nhCookie');
    if (cookie) headers['Cookie'] = cookie;
    return headers;
}

/** 带退避重试的 GET：429 按 Retry-After 退避；403 短暂退避后重试仍 403 则快速失败 */
async function requestGet(url, config, logger, isApi) {
    const attempts = 3;
    for (let i = 1; i <= attempts; i++) {
        let res;
        try {
            res = await fetch(url, {
                headers: browserHeaders(config, isApi),
                signal: AbortSignal.timeout(20000)
            });
        } catch (e) {
            if (i === attempts) throw new Error(`请求失败: ${e.message}`);
            await sleep(1500 * i);
            continue;
        }

        if (res.status === 429) {
            const ra = parseRetryAfter(res);
            if (logger) logger.warn(`429 限流 ${url}，${ra || 30}s 后重试 (${i}/${attempts})`);
            if (i === attempts) throw new RateLimitError(ra);
            await sleep((ra || 5) * 1000);
            continue;
        }
        if (res.status === 403) {
            if (i === attempts) {
                const err = new Error('403 被拦截（Cloudflare/反爬）');
                err.status = 403;
                throw err;
            }
            await sleep(2000);
            continue;
        }
        if (res.status === 404) {
            const err = new Error('404 不存在');
            err.status = 404;
            throw err;
        }
        if (!res.ok) {
            if (i === attempts) throw new Error(`HTTP ${res.status}`);
            await sleep(1500 * i);
            continue;
        }
        return res;
    }
    throw new Error('请求失败');
}

/** 源1：详情页 HTML */
async function fetchMetaFromHtml(gid, config, logger) {
    const url = String(config.get('metaUrlTemplate')).replace('{gid}', encodeURIComponent(gid));
    const res = await requestGet(url, config, logger, false);
    const html = await res.text();
    const meta = parseGalleryHtml(html, gid);
    if (!meta.mediaId || !meta.numPages) {
        throw new Error('页面未包含 media_id / num_pages（可能被 Cloudflare 拦截）');
    }
    return meta;
}

/** 源2（备用）：官方 JSON API */
async function fetchMetaFromApi(gid, config, logger) {
    const url = String(config.get('apiUrlTemplate')).replace('{gid}', encodeURIComponent(gid));
    const res = await requestGet(url, config, logger, true);
    let json;
    try { json = await res.json(); } catch (e) { throw new Error('API 响应不是 JSON'); }
    const meta = parseGalleryApi(json, gid);
    if (!meta || !meta.mediaId || !meta.numPages) throw new Error('API 响应缺少 media_id / num_pages');
    return meta;
}

/**
 * 抓取并解析本子元数据（双源回退）：
 *   1) 详情页 HTML；失败（403/404/解析失败等）
 *   2) 官方 JSON API 备用源。
 * 双源都失败时抛出聚合错误；403 时提示配置浏览器 Cookie（nhCookie）。
 */
async function fetchGalleryMeta(gid, config, logger) {
    const errors = [];

    try {
        return await fetchMetaFromHtml(gid, config, logger);
    } catch (e) {
        if (e instanceof RateLimitError && e.retryAfterSec > 20) throw e; // 严格限流时不浪费备用源
        errors.push(`详情页: ${e.message}`);
        if (logger) logger.warn(`本子 ${gid} 详情页元数据获取失败(${e.message})，回退 JSON API 备用源`);
    }

    try {
        return await fetchMetaFromApi(gid, config, logger);
    } catch (e) {
        errors.push(`API: ${e.message}`);
    }

    const all403 = errors.length > 0 && errors.every(m => /403/.test(m));
    const hint = all403
        ? '（403 被 Cloudflare 拦截：请复制浏览器登录 nhentai 后的 Cookie，填到 Web 设置 → 高级 → 浏览器 Cookie，再重试任务）'
        : '';
    const err = new Error(`元数据获取失败：${errors.join('；')}${hint}`);
    if (errors.some(m => /429|限流/.test(m))) err.retryAfterSec = 30;
    throw err;
}

module.exports = { parseGalleryHtml, parseGalleryApi, fetchGalleryMeta, RateLimitError, TYPE_MAP };
