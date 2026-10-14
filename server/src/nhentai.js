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

class RateLimitError extends Error {
    constructor(retryAfterSec) {
        super(`429 Too Many Requests${retryAfterSec ? ` (retry after ${retryAfterSec}s)` : ''}`);
        this.name = 'RateLimitError';
        this.retryAfterSec = retryAfterSec || 30;
    }
}

/** 抓取并解析本子元数据（带 429 退避重试） */
async function fetchGalleryMeta(gid, config, logger) {
    const url = String(config.get('metaUrlTemplate')).replace('{gid}', encodeURIComponent(gid));
    const attempts = 3;

    for (let i = 1; i <= attempts; i++) {
        let res;
        try {
            res = await fetch(url, {
                headers: {
                    'User-Agent': config.get('userAgent'),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                signal: AbortSignal.timeout(20000)
            });
        } catch (e) {
            if (i === attempts) throw new Error(`元数据请求失败: ${e.message}`);
            await sleep(1500 * i);
            continue;
        }

        if (res.status === 429) {
            const ra = parseRetryAfter(res);
            if (logger) logger.warn(`本子 ${gid} 被 429 限流，${ra || 30}s 后重试 (${i}/${attempts})`);
            if (i === attempts) throw new RateLimitError(ra);
            await sleep((ra || 5) * 1000);
            continue;
        }
        if (res.status === 404) throw new Error(`本子 ${gid} 不存在 (404)`);
        if (!res.ok) {
            if (i === attempts) throw new Error(`元数据 HTTP ${res.status}`);
            await sleep(1500 * i);
            continue;
        }

        const html = await res.text();
        const meta = parseGalleryHtml(html, gid);
        if (!meta.mediaId || !meta.numPages) {
            throw new Error('元数据提取失败（页面未包含 media_id / num_pages，可能被 Cloudflare 拦截）');
        }
        return meta;
    }
    throw new Error('元数据提取失败');
}

module.exports = { parseGalleryHtml, fetchGalleryMeta, RateLimitError, TYPE_MAP };
