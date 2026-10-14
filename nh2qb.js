// ==UserScript==
// @name         nHentai → Local Image Scraper
// @namespace    http://tampermonkey.net/
// @version      5.6.0
// @description  直接提取高清原图下载；「推送到下载服务」自动附带元数据（media_id/Pages数），服务端纯CDN下载避开官方API限流；完整性校验/超时重传/多CDN轮询/WebP统一/自动压缩zip；下载完成自动标记已下载；文件夹格式：本子名 [本子id]
// @author       Paccu
// @match        https://nhentai.net/g/*
// @match        https://nhentai.net/
// @match        https://nhentai.net/artist/*
// @match        https://nhentai.net/group/*
// @match        https://nhentai.net/tag/*
// @match        https://nhentai.net/parody/*
// @match        https://nhentai.net/character/*
// @match        https://nhentai.net/search/*
// @match        https://nhentai.net/*?*
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    /**************************************************************************
     * 1. 样式定义 (CSS Styles)
     **************************************************************************/
    function initUI() {
        GM_addStyle(`
            .gallery { position: relative !important; }
            #nh-qb-container { position: fixed; right: 20px; top: 20px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; pointer-events: none; }
            .nh-qb-notify { position: relative; margin-bottom: 10px; width: 280px; max-width: calc(100vw - 40px); background: rgba(18,18,18,0.95); color: #fff; padding: 14px 16px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); transform: translateX(350px); transition: transform 0.36s cubic-bezier(.2,.9,.2,1), opacity 0.36s; pointer-events: auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; font-size: 13px; opacity: 0; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); }
            .nh-qb-notify.show { transform: translateX(0); opacity: 1; }
            .nh-qb-notify:hover { border-color: rgba(255,255,255,0.2); }
            .nh-qb-notify .title { font-weight:600; margin-bottom:6px; color: #ed2553; }
            .nh-qb-notify .line { margin-top:6px; }
            .nh-qb-notify .error { color: #ff8b8b; font-weight:600; }
            
            .nh-qb-notify-scroll { max-height: 180px; overflow-y: auto; margin-top: 8px; padding-right: 6px; font-size: 11px; }
            .nh-qb-notify-scroll::-webkit-scrollbar { width: 4px; }
            .nh-qb-notify-scroll::-webkit-scrollbar-thumb { background: #666; border-radius: 2px; }
            
            .nh-qb-fixed-btn { position:fixed; bottom:20px; right:10px; z-index:99999; }
            .nh-qb-fixed-btn .btn { margin-left:6px; }
            .nh-copy-link-btn { position: absolute; bottom: 6px; right: 6px; z-index: 30; background: rgba(0, 0, 0, 0.75); color: #fff; border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; opacity: 1; transition: background 0.2s; display: inline-flex; align-items: center; justify-content: center; }
            .gallery:hover .nh-copy-link-btn { opacity: 1; }
            .nh-copy-link-btn:hover { background: rgba(237, 37, 83, 0.9); }
            .nh-caption-cn { position: absolute !important; top: 100% !important; bottom: auto !important; left: 0 !important; width: 100% !important; z-index: 20 !important; border: 3px solid rgba(255, 0, 0, 0.5) !important; box-shadow: 0 0 6px rgba(255, 0, 0, 0.8) !important; box-sizing: border-box !important; background-color: #404040 !important; color: #d9d9d9 !important; line-height: 15px !important; height: auto !important; max-height: 42px !important; overflow: hidden !important; white-space: normal !important; transition: max-height 0.3s ease !important; }
            .gallery:hover .nh-caption-cn { max-height: 300px !important; }
            .nh-cover-dimmed { filter: brightness(0.6) !important; }
            
            .btn { padding: 8px 12px; border-radius: 4px; border: none; cursor: pointer; font-size: 14px; font-weight: bold; transition: background-color 0.2s; display: inline-flex; align-items: center; justify-content: center; font-family: inherit; text-align: center; box-sizing: border-box; line-height: normal; height: auto; min-height: 36px; }
            .btn-primary { background-color: #ed2553 !important; color: #ffffff !important; }
            .btn-primary:hover { background-color: #f0466d !important; }
            .btn-secondary { background-color: #34353b !important; color: #ffffff !important; }
            .btn-secondary:hover { background-color: #42444c !important; }
            .btn-success { background-color: #4caf50 !important; color: #ffffff !important; border-color: #4caf50 !important; }
            .btn-success:hover { background-color: #45a049 !important; }
            .btn:disabled { opacity: 0.6 !important; cursor: not-allowed !important; }
            
            .nhqb-modal { background: #222224; color: #e0e0e0; padding: 20px 24px; border-radius: 10px; min-width: 360px; width: 460px; max-width: 95%; box-shadow: 0 12px 48px rgba(0,0,0,0.8); font-size: 14px; border: 1px solid #3c3c3c; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
            .nhqb-modal h3 { margin-top: 0; color: #fff; border-bottom: 1px solid #3c3c3c; padding-bottom: 12px; margin-bottom: 18px; font-size: 18px; font-weight: 600; }
            .nhqb-modal .field-group { margin-bottom: 16px; text-align: left; }
            .nhqb-modal label { font-weight: 600; color: #bbb; display: block; margin-bottom: 6px; font-size: 13px; }
            .nhqb-modal input[type="text"] { width: 100%; padding: 10px 12px; background: #161618; color: #fff; border: 1px solid #444; border-radius: 6px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; box-sizing: border-box; font-family: inherit; font-size: 14px; }
            .nhqb-modal input[type="text"]:focus { border-color: #ed2553; box-shadow: 0 0 0 2px rgba(237,37,83,0.25); }
            .nhqb-modal .divider { margin-bottom: 16px; padding-top: 16px; border-top: 1px solid #3c3c3c; text-align: left; }
            .nhqb-modal .btn-group { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
        `);
    }
    initUI();

    /**************************************************************************
     * 2. 全局状态与配置管理
     **************************************************************************/

    let DL_PATH = localStorage.getItem('nh_dl_path') || 'nHentai';
    let SERVER_URL = (localStorage.getItem('nh_server_url') || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    let SERVER_KEY = localStorage.getItem('nh_server_key') || '';
    const CHECK_KEY = 'nh_qb_checked';
    const DOWNLOADED_KEY = 'nh_qb_downloaded_gids';
    const DOWNLOADING_KEY = 'nh_qb_downloading_gids';
    let savedChecked = {};
    let downloadedSet = new Set();
    let downloadingSet = new Set();
    let globalFailedItems = [];

    function syncLocalState() {
        try { savedChecked = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}'); } catch(e) { savedChecked = {}; }
        try {
            const stored = JSON.parse(localStorage.getItem(DOWNLOADED_KEY) || '[]');
            if (Array.isArray(stored)) {
                downloadedSet = new Set(stored.map(String));
            }
        } catch (e) {}
        try {
            const dl = JSON.parse(localStorage.getItem(DOWNLOADING_KEY) || '[]');
            downloadingSet = Array.isArray(dl) ? new Set(dl.map(String)) : new Set();
        } catch (e) { downloadingSet = new Set(); }
        // 已完成的从「下载中」清理
        for (const gid of [...downloadingSet]) {
            if (downloadedSet.has(gid)) downloadingSet.delete(gid);
        }

        let needsUpdate = false;
        for (let gid of Object.keys(savedChecked)) {
            if (downloadedSet.has(String(gid))) {
                delete savedChecked[gid];
                needsUpdate = true;
            }
        }
        if (needsUpdate) {
            localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
        }
    }

    window.addEventListener('storage', (e) => {
        if (e.key === DOWNLOADED_KEY || e.key === CHECK_KEY) {
            syncLocalState();
            requestRender();
        }
    });

    /**************************************************************************
     * 3. 基础工具函数
     **************************************************************************/

    function notify(html, duration = Infinity, onReady = null) {
        let container = document.getElementById('nh-qb-container');
        if (!container) { container = document.createElement('div'); container.id = 'nh-qb-container'; document.body.appendChild(container); }
        const el = document.createElement('div'); el.className = 'nh-qb-notify'; el.innerHTML = html; container.appendChild(el);
        
        el.innerHTML += `<div style="font-size: 10px; color: #888; margin-top: 10px; text-align: right;">(点击空白处关闭)</div>`;
        requestAnimationFrame(() => el.classList.add('show'));
        
        let closing = false; let timer = null;
        function close(e) {
            if (e && e.target && e.target.tagName === 'BUTTON') return;
            if (closing) return; closing = true; 
            if(timer) clearTimeout(timer);
            el.classList.remove('show'); el.style.opacity = '0';
            setTimeout(() => { try { el.remove(); } catch (e){} if (container.childNodes.length === 0) container.remove(); }, 400);
        }

        el.addEventListener('click', close);

        if (duration !== Infinity && duration > 0) {
            timer = setTimeout(close, duration);
            el.addEventListener('mouseenter', () => { clearTimeout(timer); });
            el.addEventListener('mouseleave', () => { if (!closing) timer = setTimeout(close, duration); });
        }
        if (onReady) setTimeout(() => onReady(el), 0);
        return { close };
    }

    function stickyNotify(id, html) {
        let container = document.getElementById('nh-qb-container');
        if (!container) { container = document.createElement('div'); container.id = 'nh-qb-container'; document.body.appendChild(container); }
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('div'); el.id = id; el.className = 'nh-qb-notify'; 
            container.appendChild(el); requestAnimationFrame(() => el.classList.add('show'));
        }
        el.innerHTML = html;
        return {
            close: () => { el.classList.remove('show'); el.style.opacity = '0'; setTimeout(() => { try { el.remove(); } catch (e){} }, 400); }
        };
    }

    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }
    const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    function utf8Len(s) { let n = 0; for (const ch of String(s)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; }
    function truncateUtf8(str, maxBytes) {
        let out = '', bytes = 0;
        for (const ch of String(str)) {
            const c = ch.codePointAt(0);
            const b = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
            if (bytes + b > maxBytes) break;
            out += ch; bytes += b;
        }
        return out;
    }
    /** 文件名清洗：Windows/Linux 双平台（非法字符/控制符/保留名/结尾点空格），可按 UTF-8 字节限长 */
    function sanitizeFileName(name, maxBytes) {
        let s = String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (maxBytes) s = truncateUtf8(s, maxBytes);
        s = s.replace(/[.+\-\s]+$/g, '');
        if (WINDOWS_RESERVED.test(s)) s += '_';
        return s;
    }
    /** 文件夹名格式：本子名 [本子id]（整体 ≤180 UTF-8 字节，超长截掉标题尾部文字，保留末端 [id]） */
    function galleryFolderName(title, gid) {
        const suffix = ` [${gid}]`;
        return `${sanitizeFileName(title, 180 - utf8Len(suffix)) || 'untitled'}${suffix}`;
    }

    /**************************************************************************
     * 3.1 本地下载服务通信（队列推送）
     **************************************************************************/
    function serverApi(pathname, method = 'GET', body = null) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method,
                url: SERVER_URL + pathname,
                headers: Object.assign({ 'Content-Type': 'application/json' }, SERVER_KEY ? { 'X-API-Key': SERVER_KEY } : {}),
                data: body ? JSON.stringify(body) : undefined,
                timeout: 15000,
                onload: (res) => {
                    let json = null;
                    try { json = JSON.parse(res.responseText); } catch (e) { /* 非 JSON */ }
                    resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json });
                },
                onerror: () => resolve({ ok: false, status: 0, json: null }),
                ontimeout: () => resolve({ ok: false, status: 0, json: null })
            });
        });
    }

    /** 抓取单本元数据用于随任务上传（失败返回 null，服务端会回退自行抓取） */
    async function fetchMetaForPush(gid, htmlString = null) {
        try {
            const m = await fetchGalleryMeta(gid, htmlString);
            return {
                mediaId: m.mediaId,
                numPages: m.numPages,
                extMap: m.extMap || [],
                coverHost: m.imgHost ? 'https://' + m.imgHost : null
            };
        } catch (e) {
            return null;
        }
    }

    /** 将若干本子推送到本地下载服务的队列 */
    async function pushItemsToServer(items) {
        if (!items.length) { notify(`<div class='title'>提示</div>请先勾选要推送的本子！`, 4000); return null; }
        if (!SERVER_KEY) {
            notify(`<div class='title'>未配置 API Key</div>请在「设置」中填写本地下载服务的地址与 API Key`, 6000);
            showSettingsModal();
            return null;
        }
        await syncCookieToServer(true);   // 推送前先刷新浏览器 Cookie 到服务端（解 403）

        // 自动附带元数据（原逻辑：页面解析 media_id / Pages 数 / 后缀表），
        // 服务端拿到后直接请求 CDN 下载图片，零元数据请求（避开官方 API 限流）
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.meta) continue;
            stickyNotify('nh-push-progress', `<div class='title'>正在解析元数据 (${i + 1}/${items.length})...</div>`);
            it.meta = await fetchMetaForPush(it.gid);
            if (i < items.length - 1) await new Promise(r => setTimeout(r, 350));
        }

        const res = await serverApi('/api/tasks', 'POST', { items });
        if (!res.ok) {
            const reason = (res.json && res.json.error) || (res.status === 0 ? '无法连接本地下载服务（请确认已启动）' : `HTTP ${res.status}`);
            notify(`<div class='title'>推送失败</div>${escapeHtml(reason)}`, 8000);
            return null;
        }
        // 记录本浏览器推送过的任务 + 立即打「下载中」黄色角标
        if (res.json && Array.isArray(res.json.added)) {
            const pushed = readPushedMap();
            for (const it of res.json.added) {
                pushed[String(it.gid)] = Date.now();
                downloadingSet.add(String(it.gid));
            }
            localStorage.setItem('nh_pushed_gids', JSON.stringify(pushed));
            localStorage.setItem(DOWNLOADING_KEY, JSON.stringify([...downloadingSet]));
            requestRender();
        }
        return res.json;
    }

    /**
     * 自动同步：下载服务中「下载完成且完整性校验通过」的本子自动标记为已下载
     * （与本地下载完成后的标记逻辑一致：已下载角标 + 封面变暗 + 取消勾选）
     *
     * 可靠性说明：完成状态由服务端持久化（唯一事实源），本函数只是"拉取补标"。
     * 即使推送后浏览器被关闭，下次打开任意 nHentai 页面 3 秒内即会补上标记，
     * 并对你推送过的任务弹「下载完成」提示。
     */
    async function syncDownloadedFromServer() {
        if (!SERVER_KEY) return;
        const res = await serverApi('/api/tasks', 'GET');
        if (!res.ok || !res.json) return;

        const pushedMap = readPushedMap();
        let changed = false;
        const justDone = [];      // 本次新识别为已下载、且值得提示的
        const seen = new Set();

        for (const t of (res.json.tasks || [])) {
            const gid = String(t.gid);
            seen.add(gid);

            if (t.status === 'completed') {
                if (downloadingSet.has(gid)) { downloadingSet.delete(gid); changed = true; }
                const isMine = !!pushedMap[gid];
                if (pushedMap[gid]) delete pushedMap[gid];
                if (downloadedSet.has(gid)) continue;
                downloadedSet.add(gid);
                changed = true;

                // 提示条件：是本浏览器推送过的任务，或 15 分钟内刚完成（历史首次同步不打扰）
                const finishedAt = t.finishedAt ? new Date(t.finishedAt).getTime() : 0;
                const isRecent = finishedAt && (Date.now() - finishedAt) < 15 * 60 * 1000;
                if (isMine || isRecent) justDone.push(t);
            } else if (t.status === 'queued' || t.status === 'downloading') {
                // 「下载中」黄色角标状态
                if (!downloadingSet.has(gid)) { downloadingSet.add(gid); changed = true; }
            } else {
                // failed / cancelled → 取消「下载中」标记
                if (downloadingSet.has(gid)) { downloadingSet.delete(gid); changed = true; }
            }
        }
        // 服务端已删除的任务：清理「下载中」残留
        for (const gid of [...downloadingSet]) {
            if (!seen.has(gid)) { downloadingSet.delete(gid); changed = true; }
        }

        if (changed) {
            localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloadedSet]));
            localStorage.setItem(DOWNLOADING_KEY, JSON.stringify([...downloadingSet]));
            localStorage.setItem('nh_pushed_gids', JSON.stringify(pushedMap));
            syncLocalState();
            requestRender();
        }

        if (justDone.length) {
            const names = justDone.slice(0, 3).map(t => escapeHtml(t.title || t.gid)).join('<br>');
            const more = justDone.length > 3 ? `<div style="color:#aaa;font-size:11px;">… 等共 ${justDone.length} 本</div>` : '';
            notify(`
                <div class='title' style="color:#4caf50;">✅ 下载完成（已自动标记已下载）</div>
                <div style="font-size:12px;color:#ccc;word-break:break-all;">${names}</div>${more}
            `, 10000);
        }
    }

    /** 本浏览器推送过、尚未标记完成的任务清单 {gid: 推送时间戳} */
    function readPushedMap() {
        try { return JSON.parse(localStorage.getItem('nh_pushed_gids') || '{}') || {}; } catch (e) { return {}; }
    }

    /**
     * 获取 nhentai 的浏览器 Cookie：
     * 优先 GM_cookie（Tampermonkey，可拿到 HttpOnly 的 cf_clearance），
     * 不支持时退化为 document.cookie。
     */
    function getNhCookies() {
        return new Promise((resolve) => {
            const fromDoc = document.cookie || '';
            if (typeof GM_cookie !== 'undefined' && GM_cookie && typeof GM_cookie.list === 'function') {
                try {
                    GM_cookie.list({ url: 'https://nhentai.net/' }, (cookies, error) => {
                        if (!error && cookies && cookies.length) {
                            resolve(cookies.map(c => `${c.name}=${c.value}`).join('; '));
                        } else {
                            resolve(fromDoc);
                        }
                    });
                    return;
                } catch (e) { /* fall through */ }
            }
            resolve(fromDoc);
        });
    }

    /** 自动把浏览器 Cookie 同步给下载服务（解除 Cloudflare 403） */
    async function syncCookieToServer(force = false) {
        if (!SERVER_KEY) return;
        const cookie = await getNhCookies();
        if (!cookie) return;
        const last = localStorage.getItem('nh_last_cookie') || '';
        if (!force && last === cookie) return;   // 无变化则不重复上传
        const res = await serverApi('/api/cookie', 'POST', { cookie });
        if (res.ok) localStorage.setItem('nh_last_cookie', cookie);
    }

    /**************************************************************************
     * 4. 智能化图片下载引擎 (无弹窗图片预加载探测机制)
     **************************************************************************/

    const CDN_NODES = ['i.nhentai.net', 'i1.nhentai.net', 'i2.nhentai.net', 'i3.nhentai.net', 'i5.nhentai.net', 'i7.nhentai.net'];

    async function fetchGalleryMeta(gid, htmlString = null) {
        let mediaId = null;
        let numPages = null;
        let imgHost = 'i.nhentai.net';
        let extMap = [];

        let html = htmlString;
        if (!html) {
            let res = await fetch(`https://nhentai.net/g/${gid}/`);
            if (res.status === 429) throw new Error('429');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            html = await res.text();
        }

        let mediaIdMatch = html.match(/"media_id":\s*"?(\d+)"?/) || html.match(/\/galleries\/(\d+)\//);
        if (mediaIdMatch) mediaId = mediaIdMatch[1];

        let numPagesMatch = html.match(/"num_pages":\s*(\d+)/);
        if (numPagesMatch) numPages = parseInt(numPagesMatch[1], 10);
        if (!numPages) {
            let pm = html.match(/pages%3A(\d+)/) || html.match(/Pages:[\s\S]*?<span class="name">(\d+)<\/span>/);
            if (pm) numPages = parseInt(pm[1], 10);
        }

        let coverMatch = html.match(/(https:\/\/(t\d+)\.nhentai\.net\/galleries\/\d+\/cover\.(jpg|png|gif|webp))/);
        if (coverMatch) {
            imgHost = coverMatch[2].replace('t', 'i') + '.nhentai.net';
        } else if (html.match(/t(\d+)\.nhentai\.net/)) {
            let tMatch = html.match(/t(\d+)\.nhentai\.net/);
            imgHost = `i${tMatch[1]}.nhentai.net`;
        }

        let pagesBlockMatch = html.match(/"pages":\s*\[(.*?)\]/);
        if (pagesBlockMatch) {
            let tMatches = [...pagesBlockMatch[1].matchAll(/"t":"([jpgw])"/g)];
            if (tMatches.length > 0) {
                const typeMap = { 'j': 'jpg', 'p': 'png', 'g': 'gif', 'w': 'webp' };
                extMap = tMatches.map(m => typeMap[m[1]]);
            }
        }

        if (!mediaId || !numPages) {
            throw new Error(`元数据提取失败 (未能从页面匹配到媒体 ID 或页数)`);
        }

        return { mediaId, numPages, imgHost, extMap };
    }

    // ★核心机制变更：使用浏览器原生 Image 对象加载探测，彻底告别油猴跨域弹窗
    async function sniffExtensionFast(baseHost, mediaId, p) {
        let extsToTry = ['webp', 'jpg', 'png'];
        for (let ext of extsToTry) {
            let ok = await new Promise(resolve => {
                let img = new Image();
                let timer = setTimeout(() => {
                    img.src = ''; 
                    resolve(false);
                }, 3000); // 3秒超时防止死链卡住
                
                img.onload = () => {
                    clearTimeout(timer);
                    resolve(true);
                };
                img.onerror = () => {
                    clearTimeout(timer);
                    resolve(false);
                };
                img.src = `https://${baseHost}/galleries/${mediaId}/${p}.${ext}`;
            });
            if (ok) return ext;
        }
        return 'jpg'; 
    }

    async function processGalleryImages(gid, title, meta, onProgress) {
        const { mediaId, numPages, imgHost, extMap } = meta;
        let folderName = galleryFolderName(title, gid);
        let baseDir = DL_PATH ? `${DL_PATH}/${folderName}` : folderName;

        let success = 0; let failed = 0;
        let concurrency = 5; let i = 1;

        return new Promise((resolve) => {
            let active = 0;

            function next() {
                while (active < concurrency && i <= numPages) {
                    let p = i++; active++;
                    
                    (async () => {
                        let pathBase = `${baseDir}/${p}`;
                        let knownExt = (extMap && extMap.length >= p) ? extMap[p - 1] : null;

                        // 如果没拿到官方后缀映射，启动图片隐式预加载嗅探
                        if (!knownExt) {
                            knownExt = await sniffExtensionFast(imgHost, mediaId, p);
                        }

                        let hostsToTry = [imgHost, ...CDN_NODES.filter(h => h !== imgHost)];
                        let maxAttempts = Math.min(3, hostsToTry.length);
                        let isOk = false;

                        for (let idx = 0; idx < maxAttempts; idx++) {
                            let url = `https://${hostsToTry[idx]}/galleries/${mediaId}/${p}.${knownExt}`;
                            let path = `${pathBase}.${knownExt}`;
                            
                            isOk = await new Promise((res) => {
                                GM_download({
                                    url: url, name: path, saveAs: false,
                                    onload: () => res(true), onerror: () => res(false), ontimeout: () => res(false)
                                });
                            });

                            if (isOk) break;
                            await new Promise(r => setTimeout(r, 600)); // 换节点前休眠
                        }

                        if (isOk) success++; else failed++;
                        active--;
                        
                        if (onProgress) onProgress(success, failed, numPages);
                        
                        if (success + failed === numPages) {
                            resolve({ ok: success > 0, gid, title, success, failed, numPages });
                        } else {
                            next();
                        }
                    })();
                }
            }
            next();
        });
    }

    /**************************************************************************
     * 5. 详情页功能
     **************************************************************************/

    function addSinglePageButton() {
        const downloadWrapper = document.querySelector("#download-wrapper");
        if (!downloadWrapper) return;

        const currentGid = String(location.pathname.split('/')[2]);
        const isDownloaded = downloadedSet.has(currentGid);

        // 右下角固定按钮组：提取原图下载 / 推送到下载服务
        let panel = document.getElementById('nhqb_detail_panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'nhqb_detail_panel';
            panel.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:row;gap:8px;';
            document.body.appendChild(panel);
        }
        let btn = panel.querySelector('.nh-custom-btn-single');

        if (downloadWrapper.getAttribute('data-nh-gid') === currentGid) {
            if (btn) {
                if (isDownloaded) {
                    btn.innerText = '已下载'; btn.classList.add('btn-success'); btn.classList.remove('btn-primary');
                } else {
                    btn.innerText = '提取原图下载'; btn.classList.add('btn-primary'); btn.classList.remove('btn-success');
                }
            }
            return;
        }

        if (btn) btn.remove();
        const oldPushBtn = panel.querySelector('.nh-custom-btn-push');
        if (oldPushBtn) oldPushBtn.remove();
        // 清理旧版本注入到正文中的按钮
        downloadWrapper.parentNode.querySelectorAll('.nh-custom-btn-single, .nh-custom-btn-push').forEach(el => el.remove());
        downloadWrapper.setAttribute('data-nh-gid', currentGid);

        btn = document.createElement('button');
        btn.className = 'btn nh-custom-btn-single ' + (isDownloaded ? 'btn-success' : 'btn-primary');
        btn.innerText = isDownloaded ? '已下载' : '提取原图下载';
        panel.appendChild(btn);

        const pushBtn = document.createElement('button');
        pushBtn.className = 'btn btn-success nh-custom-btn-push';
        pushBtn.innerText = '推送到下载服务';
        panel.appendChild(pushBtn);

        // 设置按钮并入同一按钮组末尾，保证 [提取原图下载][推送到下载服务][设置] 等距
        let setBtn = document.getElementById('nhqb_settings_btn2');
        if (!setBtn) {
            setBtn = document.createElement('button');
            setBtn.id = 'nhqb_settings_btn2';
            setBtn.className = 'btn btn-primary';
            setBtn.innerText = '设置';
            setBtn.addEventListener('click', showSettingsModal);
        }
        panel.appendChild(setBtn);
        pushBtn.addEventListener('click', async () => {
            const title = document.querySelector('#info h2')?.innerText?.trim() || document.querySelector('#info h1')?.innerText?.trim() || currentGid;
            // 当前详情页直接解析元数据随任务上传（服务端纯 CDN 下载）
            const meta = await fetchMetaForPush(String(currentGid), document.documentElement.innerHTML);
            const result = await pushItemsToServer([{ gid: String(currentGid), title, meta }]);
            if (!result) return;
            const added = (result.added || []).length;
            const skipped = result.skipped || [];
            notify(`
                <div class='title' style="color:#4caf50;">📤 ${added ? '已推送本子到下载服务' : '任务未入队'}</div>
                <div style="font-size:12px;color:#ccc;word-break:break-all;">${escapeHtml(title)}</div>
                ${skipped.length ? `<div style="font-size:12px;color:#ff9800;margin-top:6px;">${escapeHtml(skipped[0].reason)}</div>` : `<div style="font-size:12px;color:#ccc;margin-top:6px;">服务端将自动排队下载，可在 Web 控制台查看进度</div>`}
            `, Infinity);
        });

        btn.addEventListener('click', async () => {
            const gid = String(location.pathname.split('/')[2]);
            const title = document.querySelector('#info h2')?.innerText?.trim() || document.querySelector('#info h1')?.innerText?.trim() || gid;
            
            let meta;
            try { meta = await fetchGalleryMeta(gid, document.documentElement.innerHTML); } 
            catch(e) { notify(`<div class='title'>错误</div>${e.message}`, Infinity); return; }

            let progToast = stickyNotify('nh-single-progress', `<div class='title'>开始获取高清图片...</div>共 ${meta.numPages} 页，请稍候`);

            const result = await processGalleryImages(gid, title, meta, (s, f, t) => {
                progToast = stickyNotify('nh-single-progress', `
                    <div class='title'>正在高速下载原图...</div>
                    <div style="color:#4caf50;font-size:14px;margin-bottom:4px;">进度: ${s + f} / ${t} (成功: ${s} | 失败: ${f})</div>
                    <div style="font-size:11px;color:#ccc;word-break:break-all;">${escapeHtml(title)}</div>
                `);
            });

            progToast.close();

            if (result.ok) {
                notify(`<div class='title' style="font-size:15px; color:#4caf50;">✓ 本子下载完成</div>成功下载 ${result.success} 张，失败 <span style="color:${result.failed > 0 ? '#ff8b8b' : '#fff'}">${result.failed}</span> 张`, Infinity);
                downloadedSet.add(gid); 
                localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloadedSet]));
                syncLocalState();
                requestRender();
            } else {
                notify(`<div class='title'>下载失败</div>未能成功下载任何图片，可能是原图跨域被拦截。` , Infinity);
            }
        });
    }

    /**************************************************************************
     * 6. 列表页批量功能 & 总结报告重试机制
     **************************************************************************/
    
    function updateRetryButton() {
        let retryBtn = document.getElementById('nhqb_retry_btn');
        if (globalFailedItems.length > 0) {
            if (!retryBtn) {
                retryBtn = document.createElement('button');
                retryBtn.id = 'nhqb_retry_btn';
                retryBtn.className = 'btn';
                retryBtn.style.cssText = 'position:fixed;bottom:65px;right:80px;z-index:99999;background-color:#ff9800!important;color:#fff!important;border:none;box-shadow: 0 4px 12px rgba(255,152,0,0.4);';
                document.body.appendChild(retryBtn);

                retryBtn.addEventListener('click', async () => {
                    const itemsToRetry = [...globalFailedItems];
                    globalFailedItems = []; updateRetryButton(); 
                    let { successList, failedList } = await executeBatchDownload(itemsToRetry, "正在重试失败项");
                    handleBatchResult(successList, failedList, itemsToRetry.length);
                });
            }
            retryBtn.style.display = 'inline-flex';
            retryBtn.innerText = `一键重试失败项 (${globalFailedItems.length}本)`;
        } else {
            if (retryBtn) retryBtn.style.display = 'none';
        }
    }

    async function executeBatchDownload(itemsToDownload, initTitleText = "准备队列中...") {
        const total = itemsToDownload.length;
        let progToast = stickyNotify('nh-batch-progress', `<div class='title'>${initTitleText}</div>共计 ${total} 本`);
        const successList = []; const failedList = [];

        for (let i = 0; i < total; i++) {
            const { gid, title } = itemsToDownload[i];

            progToast = stickyNotify('nh-batch-progress', `
                <div class='title'>正在解析数据... (${i+1}/${total})</div>
                <div style="font-size:11px;color:#ccc;word-break:break-all;">${escapeHtml(title)}</div>
            `);

            let meta;
            try { meta = await fetchGalleryMeta(gid); } 
            catch (e) {
                if (e.message === '429') {
                    progToast = stickyNotify('nh-batch-progress', `<div class='title'>访问频繁，休眠 10 秒后重试...</div>`);
                    await new Promise(r => setTimeout(r, 10000));
                    try { meta = await fetchGalleryMeta(gid); } 
                    catch(err) { failedList.push({gid, title, error: "被服务器 429 拦截拒绝响应"}); continue; }
                } else { failedList.push({gid, title, error: e.message}); continue; }
            }

            if (!meta) { failedList.push({gid, title, error: "元数据提取失败"}); continue; }

            let result = await processGalleryImages(gid, title, meta, (s, f, t) => {
                progToast = stickyNotify('nh-batch-progress', `
                    <div class='title'>正在批量下载 (${i+1}/${total})</div>
                    <div style="color:#4caf50;font-size:14px;margin-bottom:4px;">单本进度: ${s + f} / ${t} (成功 ${s})</div>
                    <div style="font-size:11px;color:#ccc;word-break:break-all;">${escapeHtml(title)}</div>
                `);
            });

            if (result.ok) {
                successList.push(result);
                downloadedSet.add(String(gid));
                delete savedChecked[gid];
                const inputCb = document.querySelector(`input[data-gid="${gid}"]`);
                if (inputCb) inputCb.checked = false;
                
                localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
                localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloadedSet]));
                syncLocalState();
                requestRender();
            } else {
                failedList.push({gid, title, error: "全页下载失败或超时"});
            }

            if (i < total - 1) await new Promise(r => setTimeout(r, 1200));
        }
        progToast.close();
        return { successList, failedList };
    }

    function handleBatchResult(successList, failedList, total) {
        if (successList.length > 0) {
            const HISTORY_KEY = 'nh_qb_push_history_v2';
            const OLD_KEY = 'nh_qb_pushed_max_gid';
            const getBjTime = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
            let pushHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{"max":{"id":0,"time":"--"},"prev":{"id":0,"time":"--"}}');
            
            const currentBatchGids = successList.map(r => parseInt(r.gid));
            const currentBatchMax = Math.max(...currentBatchGids);
            if (currentBatchMax > pushHistory.max.id) {
                pushHistory.prev.id = pushHistory.max.id; pushHistory.prev.time = pushHistory.max.time;
                pushHistory.max.id = currentBatchMax; pushHistory.max.time = getBjTime();
                localStorage.setItem(HISTORY_KEY, JSON.stringify(pushHistory)); localStorage.setItem(OLD_KEY, currentBatchMax);
                
                const renderGidInfo = (data) => {
                    const linkStyle = 'color:#ed2553;font-weight:bold;font-size:14px;margin:0 4px;text-decoration:none;border-bottom:1px dashed #ed2553;';
                    const timeStyle = 'color:#888;font-size:11px;font-family:monospace;min-width:110px;text-align:right;display:inline-block;';
                    const rowStyle = 'display:flex;align-items:center;justify-content:flex-end;width:100%;margin-bottom:2px;';
                    return `<div style="${rowStyle}"><span>已下载最大 GID:</span><a href="/g/${data.max.id}/" target="_blank" style="${linkStyle}">${data.max.id}</a><span style="${timeStyle}">[${data.max.time}]</span></div>` +
                           `<div style="${rowStyle}"><span style="color:#aaa;">上次下载最大 GID:</span><a href="/g/${data.prev.id}/" target="_blank" style="${linkStyle}">${data.prev.id}</a><span style="${timeStyle}">[${data.prev.time}]</span></div>`;
                };
                const infoEl = document.getElementById('nh-max-gid-display');
                if(infoEl) infoEl.innerHTML = renderGidInfo(pushHistory);
            }
        }

        globalFailedItems = failedList;
        updateRetryButton();

        let failedHtml = '';
        if (failedList.length > 0) {
            failedHtml = `
                <div class="line" style="border-top:1px solid #444; padding-top:10px; margin-top:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <strong style="color:#ff9800; font-size:14px;">⚠️ 失败列表 (${failedList.length} 本)</strong>
                    </div>
                    <div class="nh-qb-notify-scroll">
                        ${failedList.map(f => `
                            <div style="background:rgba(255,255,255,0.05); padding:6px; border-radius:4px; margin-bottom:6px;">
                                <div style="color:#ed2553; font-weight:bold; font-size:12px;">ID: ${f.gid}</div>
                                <div style="color:#ddd; margin:2px 0;">${escapeHtml(f.title)}</div>
                                <div style="color:#ffc107;">原因：${escapeHtml(f.error)}</div>
                            </div>
                        `).join('')}
                    </div>
                    <button class="btn retry-inline-btn" style="width:100%; margin-top:12px; background-color:#ff9800!important; color:#fff!important; border:none; padding:8px 0; font-size:13px; box-shadow:0 2px 8px rgba(255,152,0,0.3);">
                        🔄 快速补充重试 (${failedList.length} 本)
                    </button>
                </div>
            `;
        }
        
        let titleColor = failedList.length === 0 ? '#4caf50' : '#ed2553';
        let summaryHtml = `
            <div class='title' style="font-size:16px; color:${titleColor};">📋 批量任务报告</div>
            <div style="font-size:14px; margin-top:8px;">
                成功下载：<span style="color:#4caf50; font-weight:bold; font-size:16px;">${successList.length}</span> / ${total}
            </div>
            ${failedHtml}
        `;

        notify(summaryHtml, Infinity, (el) => {
            const retryInlineBtn = el.querySelector('.retry-inline-btn');
            if (retryInlineBtn) {
                retryInlineBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); e.preventDefault();
                    el.style.opacity = '0'; setTimeout(() => el.remove(), 400);

                    const itemsToRetry = [...globalFailedItems];
                    globalFailedItems = []; updateRetryButton(); 
                    executeBatchDownload(itemsToRetry, "正在重试失败项").then(({ successList: sList, failedList: fList }) => {
                        handleBatchResult(sList, fList, itemsToRetry.length);
                    });
                });
            }
        });
    }

    /** 缩略图状态渲染：已下载（绿）/ 下载中（黄）角标 + 封面变暗 + 取消勾选 */
    function renderThumbState(thumb, gid) {
        thumb.querySelectorAll('.nh-state-tag').forEach(el => el.remove());
        const cover = thumb.querySelector('.cover');
        const isDownloaded = downloadedSet.has(gid);
        const isDownloading = !isDownloaded && downloadingSet.has(gid);

        if (isDownloaded || isDownloading) {
            const tag = document.createElement('div');
            tag.className = 'downloaded-tag nh-state-tag nh-custom-injected';
            tag.style.cssText = 'position:absolute;top:0;left:0;' +
                (isDownloaded ? 'background:#4caf50;color:#fff;' : 'background:#f5b942;color:#222;') +
                'font-size:12px;padding:2px 6px;z-index:25;border-bottom-right-radius:4px;font-weight:bold;box-shadow:2px 2px 4px rgba(0,0,0,0.5);pointer-events:none;';
            tag.innerText = isDownloaded ? '已下载' : '下载中';
            thumb.appendChild(tag);
            if (cover) cover.classList.add('nh-cover-dimmed');
        } else if (cover) {
            cover.classList.remove('nh-cover-dimmed');
        }

        const cb = thumb.querySelector('input[type=checkbox]');
        if (cb) cb.checked = !!savedChecked[gid];
    }

    function addBatchFeature() {
        if (!document.getElementById('nhqb_left_panel')) {
            const leftPanel = document.createElement('div');
            leftPanel.id = 'nhqb_left_panel';
            leftPanel.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;';
            leftPanel.innerHTML = `
                <button id="nhqb_select_cn" class="btn btn-primary">全选中文本子</button>
                <button id="nhqb_deselect_all" class="btn btn-secondary">取消全部选中</button>
            `;
            document.body.appendChild(leftPanel);

            document.getElementById('nhqb_select_cn').addEventListener('click', () => {
                let count = 0;
                document.querySelectorAll('.gallery').forEach(thumb => {
                    const cb = thumb.querySelector('input[type="checkbox"]');
                    if (!cb) return;
                    const gid = String(cb.dataset.gid);
                    const title = cb.dataset.title || '';
                    const isDownloaded = downloadedSet.has(gid);
                    const isChinese = thumb.classList.contains('lang-cn') || title.includes('[Chinese]') || title.includes('汉化');
                    if (isChinese && !isDownloaded && !cb.checked) { cb.checked = true; savedChecked[gid] = title; count++; }
                });
                localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
                if (count > 0) notify(`<div class='title'>全选完成</div>已自动选中本页 ${count} 个未下载的中文本子`, 5000);
                else notify(`<div class='title'>全选提示</div>当前页面没有找到需要勾选的中文本子`, 5000);
            });

            document.getElementById('nhqb_deselect_all').addEventListener('click', () => {
                let count = 0;
                document.querySelectorAll('.gallery').forEach(thumb => {
                    const cb = thumb.querySelector('input[type="checkbox"]');
                    if (!cb) return;
                    const gid = String(cb.dataset.gid);
                    if (cb.checked) { cb.checked = false; delete savedChecked[gid]; count++; }
                });
                localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
                if (count > 0) notify(`<div class='title'>取消选中</div>已清空本页 ${count} 个选中状态`, 5000);
            });

        }

        // 右下角按钮组：推送到下载服务 / 批量下载到本地
        if (!document.getElementById('nhqb_right_panel')) {
            const rightPanel = document.createElement('div');
            rightPanel.id = 'nhqb_right_panel';
            rightPanel.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:row;gap:8px;';
            rightPanel.innerHTML = `
                <button id="nhqb_push_btn" class="btn btn-success">推送到下载服务</button>
                <button id="nhqb_batch_btn" class="btn btn-primary">批量下载到本地</button>
                <button id="nhqb_settings" class="btn btn-primary">设置</button>
            `;
            document.body.appendChild(rightPanel);
            document.getElementById('nhqb_settings').addEventListener('click', showSettingsModal);

            document.getElementById('nhqb_push_btn').addEventListener('click', async () => {
                const allChecked = Array.from(document.querySelectorAll("input[type=checkbox][data-gid]:checked"));
                const items = allChecked
                    .filter(cb => !downloadedSet.has(String(cb.dataset.gid)))
                    .map(cb => ({ gid: String(cb.dataset.gid), title: cb.dataset.title || '' }));
                if (!items.length) { notify(`<div class='title'>提示</div>请先勾选要推送的本子！`, 4000); return; }

                const prog = stickyNotify('nh-push-progress', `<div class='title'>正在推送到下载服务...</div>共 ${items.length} 本`);
                const result = await pushItemsToServer(items);
                prog.close();
                if (!result) return;

                // 推送成功：取消勾选并清掉本地待选记录（下载进度以服务端队列为准）
                for (const it of result.added || []) {
                    delete savedChecked[it.gid];
                    const cb = document.querySelector(`input[data-gid="${it.gid}"]`);
                    if (cb) cb.checked = false;
                }
                localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));

                const skipped = result.skipped || [];
                const skippedHtml = skipped.length
                    ? `<div class="nh-qb-notify-scroll" style="margin-top:8px;">${skipped.map(s => `<div style="color:#ffc107;font-size:11px;">GID ${escapeHtml(s.gid)}：${escapeHtml(s.reason)}</div>`).join('')}</div>`
                    : '';
                notify(`
                    <div class='title' style="color:#4caf50;">📤 已推送 ${(result.added || []).length} 本到下载服务</div>
                    <div style="font-size:12px;color:#ccc;">服务端将自动排队下载（完整性校验 + 超时重传 + 多CDN轮询）</div>
                    ${skipped.length ? `<div style="font-size:12px;color:#ff9800;margin-top:6px;">跳过 ${skipped.length} 本：</div>${skippedHtml}` : ''}
                `, Infinity);
            });

            document.getElementById('nhqb_batch_btn').addEventListener('click', async () => {
                const allChecked = Array.from(document.querySelectorAll("input[type=checkbox][data-gid]:checked"));
                if (!allChecked.length) { notify(`<div class='title'>提示</div>请先勾选要下载的本子！`, 4000); return; }

                const checked = allChecked.filter(cb => {
                    const isDownloaded = downloadedSet.has(String(cb.dataset.gid));
                    if (isDownloaded) { cb.checked = false; delete savedChecked[cb.dataset.gid]; }
                    return !isDownloaded;
                });

                if (checked.length === 0) {
                    localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
                    return;
                }

                const itemsToDownload = checked.map(cb => ({gid: String(cb.dataset.gid), title: cb.dataset.title}));
                let { successList, failedList } = await executeBatchDownload(itemsToDownload);
                handleBatchResult(successList, failedList, itemsToDownload.length);
            });
        }

        // （设置按钮已并入右下角按钮组 nhqb_right_panel，见上方）

        const thumbs = document.querySelectorAll('.gallery');
        thumbs.forEach(thumb => {
            const a = thumb.querySelector('a'); if (!a) return;
            const href = a.href || '';
            const m = href.match(/\/g\/(\d+)\//) || href.match(/\/g\/(\d+)$/);
            const gid = String(m ? m[1] : (href.split('/g/')[1] ? href.split('/g/')[1].split('/')[0] : null));
            if (!gid || gid === "null") return;

            const isDownloaded = downloadedSet.has(gid);

            if (thumb.getAttribute('data-nh-gid') === gid) {
                renderThumbState(thumb, gid);
                return;
            }

            thumb.querySelectorAll('.nh-custom-injected').forEach(el => el.remove());
            thumb.setAttribute('data-nh-gid', gid);

            const title = (thumb.querySelector('.caption')?.innerText || gid).trim();
            thumb.style.position = 'relative';

            const isChinese = thumb.classList.contains('lang-cn') || title.includes('[Chinese]') || title.includes('汉化');
            const caption = thumb.querySelector('.caption');
            if (caption) {
                if (isChinese) caption.classList.add('nh-caption-cn');
                else caption.classList.remove('nh-caption-cn');
            }

            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.dataset.gid = gid; cb.dataset.title = title;
            cb.className = 'nh-custom-injected';
            cb.style.cssText = 'position:absolute;top:6px;right:6px;z-index:20;width:27px;height:27px;transform:scale(1.05);';
            if (isChinese) {
                cb.style.accentColor = '#ff0000'; cb.style.boxShadow = '0 0 12px rgba(255, 0, 0, 1)'; cb.style.outline = '2px solid #ff0000'; cb.style.outlineOffset = '-2px'; cb.style.margin = '1px';
            }
            if (savedChecked[gid]) cb.checked = true;
            cb.addEventListener('change', () => {
                if (cb.checked) savedChecked[gid] = title; else delete savedChecked[gid];
                localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
            });

            const cover = thumb.querySelector('.cover');
            thumb.appendChild(cb);
            renderThumbState(thumb, gid);

            const copyBtn = document.createElement('button');
            const fullLink = a.href; copyBtn.className = 'nh-copy-link-btn nh-custom-injected'; copyBtn.innerText = '复制链接';
            copyBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); copyToClipboard(fullLink); };
            thumb.appendChild(copyBtn);
        });
    }

    /**************************************************************************
     * 7. 设置模态框 (Settings UI)
     **************************************************************************/
    function showSettingsModal() {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:2147483646;';

        const modal = document.createElement('div');
        modal.className = 'nhqb-modal';
        modal.innerHTML = `
            <h3>原图直刮下载配置</h3>
            
            <div class="field-group">
                <label>下载根目录名 (将在浏览器默认下载路径下建立此文件夹):</label>
                <input type="text" id="nhq_path" value="${escapeHtml(DL_PATH)}" placeholder="例如填入 nHentai">
                <div class="nhqb-helper">
                    脚本会自动按照 <b>【根目录】/【本子名 [本子id]】/【页码.后缀】</b> 的格式为您建好文件夹并归类保存。
                </div>
            </div>

            <div class="field-group">
                <label>本地下载服务（队列下载 / Web 控制台）：</label>
                <input type="text" id="nhq_server_url" value="${escapeHtml(SERVER_URL)}" placeholder="例如 http://127.0.0.1:8787">
                <input type="text" id="nhq_server_key" value="${escapeHtml(SERVER_KEY)}" placeholder="API Key（服务启动日志或 data/INITIAL_API_KEY.txt）" style="margin-top:8px;">
                <div class="nhqb-helper">
                    勾选本子后点「推送到下载服务」即进入服务端队列：自动排队下载 + 完整性校验 + 超时重传 + 多CDN轮询 + WebP统一 + 间隔限速；下载并校验完成后会自动在页面标记「已下载」。
                </div>
                <div style="display:flex; gap:10px; margin-top:10px;">
                    <button id="nhq_test_server" class="btn btn-secondary" style="flex:1;">🔌 测试连接</button>
                    <button id="nhq_sync_server" class="btn btn-secondary" style="flex:1;">🔄 从服务同步已下载</button>
                </div>
            </div>
            
            <div class="divider">
                <label>历史记录管理：</label>
                <div style="display:flex; gap:10px; margin-top:10px;">
                    <button id="nhq_backup" class="btn btn-secondary" style="flex:1;">⬇️ 备份记录到本地</button>
                    <button id="nhq_restore_btn" class="btn btn-secondary" style="flex:1;">⬆️ 从文件恢复记录</button>
                    <input type="file" id="nhq_restore_input" accept=".json" style="display:none;">
                </div>
            </div>

            <div class="btn-group">
                <button id="nhq_cancel" class="btn btn-secondary">取消</button>
                <button id="nhq_save" class="btn btn-primary">保存</button>
            </div>
        `;

        overlay.appendChild(modal); document.body.appendChild(overlay);

        modal.querySelector('#nhq_test_server').addEventListener('click', async () => {
            const url = modal.querySelector('#nhq_server_url').value.trim().replace(/\/+$/, '');
            const key = modal.querySelector('#nhq_server_key').value.trim();
            const oldUrl = SERVER_URL; const oldKey = SERVER_KEY;
            SERVER_URL = url; SERVER_KEY = key;
            const res = await serverApi('/api/stats', 'GET');
            SERVER_URL = oldUrl; SERVER_KEY = oldKey;
            if (res.ok) {
                notify(`<div class='title' style="color:#4caf50;">✓ 服务连接成功</div>版本 ${escapeHtml(res.json?.version || '-')} | 队列 ${res.json?.counts?.queued || 0} | 下载中 ${res.json?.counts?.downloading || 0}`, 6000);
            } else {
                notify(`<div class='title'>连接失败</div>${res.status === 401 ? 'API Key 无效' : '无法连接下载服务，请确认服务已启动且地址正确'}`, 6000);
            }
        });

        modal.querySelector('#nhq_sync_server').addEventListener('click', async () => {
            const url = modal.querySelector('#nhq_server_url').value.trim().replace(/\/+$/, '');
            const key = modal.querySelector('#nhq_server_key').value.trim();
            const oldUrl = SERVER_URL; const oldKey = SERVER_KEY;
            SERVER_URL = url; SERVER_KEY = key;
            const res = await serverApi('/api/tasks?status=completed', 'GET');
            SERVER_URL = oldUrl; SERVER_KEY = oldKey;
            if (!res.ok) {
                notify(`<div class='title'>同步失败</div>${res.status === 401 ? 'API Key 无效' : '无法连接下载服务'}`, 6000);
                return;
            }
            let added = 0;
            for (const t of (res.json?.tasks || [])) {
                const gid = String(t.gid);
                if (!downloadedSet.has(gid)) { downloadedSet.add(gid); added++; }
            }
            localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloadedSet]));
            syncLocalState();
            requestRender();
            notify(`<div class='title' style="color:#4caf50;">同步完成</div>新增 ${added} 条已下载记录，当前共 ${downloadedSet.size} 条`, 6000);
        });

        modal.querySelector('#nhq_backup').addEventListener('click', () => {
            const data = localStorage.getItem(DOWNLOADED_KEY) || '[]'; const blob = new Blob([data], { type: 'application/json' }); const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, "");
            a.download = `nh_downloaded_history_${dateStr}.json`; a.href = url; a.click(); URL.revokeObjectURL(url);
            notify(`<div class='title'>备份已下载</div>已保存到本地磁盘`, 5000);
        });

        modal.querySelector('#nhq_restore_btn').addEventListener('click', () => { modal.querySelector('#nhq_restore_input').click(); });

        modal.querySelector('#nhq_restore_input').addEventListener('change', (e) => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const importedData = JSON.parse(event.target.result); if (!Array.isArray(importedData)) throw new Error('文件格式不正确，必须是数组');
                    let addedCount = 0;
                    importedData.forEach(gid => { if (!downloadedSet.has(String(gid))) { downloadedSet.add(String(gid)); addedCount++; } });
                    localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloadedSet]));
                    notify(`<div class='title'>恢复成功</div>成功导入 ${addedCount} 条新记录<br>当前总记录：${downloadedSet.size}`, 5000);
                    syncLocalState(); requestRender();
                } catch (err) { console.error(err); notify(`<div class='title'>导入失败</div>文件格式错误或已损坏`, 4000); }
            };
            reader.readAsText(file);
        });

        modal.querySelector('#nhq_cancel').addEventListener('click', () => overlay.remove());

        modal.querySelector('#nhq_save').addEventListener('click', () => {
            DL_PATH = modal.querySelector('#nhq_path').value.trim();
            localStorage.setItem('nh_dl_path', DL_PATH);
            SERVER_URL = modal.querySelector('#nhq_server_url').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8787';
            SERVER_KEY = modal.querySelector('#nhq_server_key').value.trim();
            localStorage.setItem('nh_server_url', SERVER_URL);
            localStorage.setItem('nh_server_key', SERVER_KEY);
            notify(`<div class='title'>配置已保存</div>`, 3000); overlay.remove();
        });
    }

    /**************************************************************************
     * 7. 全局界面定制
     **************************************************************************/
    function customizeUI() {
        const searchInput = document.querySelector('input[name="q"]:not([data-nh-injected])');
        if (searchInput) {
            searchInput.setAttribute('autocomplete', 'off');
            searchInput.setAttribute('data-nh-injected', 'true');
        }

        const randomLinks = document.querySelectorAll('a[href="/random/"]');
        randomLinks.forEach(link => {
            const currentLi = link.closest('li');
            if (!currentLi || (currentLi.previousElementSibling && currentLi.previousElementSibling.classList.contains('nh-chinese-link'))) return;

            const newLi = document.createElement('li');
            newLi.className = currentLi.className + ' nh-chinese-link';
            newLi.innerHTML = '<a href="/search/?q=chinese">Chinese</a>';
            currentLi.parentNode.insertBefore(newLi, currentLi);
        });
    }

    /**************************************************************************
     * 8. 初始化与监听
     **************************************************************************/

    function initFeatures() {
        syncLocalState();

        customizeUI();
        if (location.pathname.startsWith('/g/')) {
            addSinglePageButton();
        } else {
            addBatchFeature();
        }

        updateRetryButton();

        // 兜底设置按钮：仅当页面没有右下角按钮组时创建，避免重复按钮
        if (!document.getElementById('nhqb_right_panel') && !document.getElementById('nhqb_detail_panel')) {
            if (!document.getElementById('nhqb_settings_fallback')) {
                const fix = document.createElement('div');
                fix.id = 'nhqb_settings_fallback';
                fix.className = 'nh-qb-fixed-btn';
                fix.innerHTML = `<button id='nhqb_settings_btn2' class='btn btn-primary' style='position:fixed;bottom:20px;right:20px;z-index:99999'>设置</button>`;
                document.body.appendChild(fix);
                document.getElementById('nhqb_settings_btn2').addEventListener('click', showSettingsModal);
            }
        }
        
        const HISTORY_KEY = 'nh_qb_push_history_v2';
        const getBjTime = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        let pushHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{"max":{"id":0,"time":"--"},"prev":{"id":0,"time":"--"}}');
        if (!document.getElementById('nh-max-gid-display')) {
            const renderGidInfo = (data) => {
                const linkStyle = 'color:#ed2553;font-weight:bold;font-size:14px;margin:0 4px;text-decoration:none;border-bottom:1px dashed #ed2553;';
                const timeStyle = 'color:#888;font-size:11px;font-family:monospace;min-width:110px;text-align:right;display:inline-block;';
                const rowStyle = 'display:flex;align-items:center;justify-content:flex-end;width:100%;margin-bottom:2px;';
                return `<div style="${rowStyle}"><span>已下载最大 GID:</span><a href="/g/${data.max.id}/" target="_blank" style="${linkStyle}">${data.max.id}</a><span style="${timeStyle}">[${data.max.time}]</span></div>` +
                       `<div style="${rowStyle}"><span style="color:#aaa;">上次下载最大 GID:</span><a href="/g/${data.prev.id}/" target="_blank" style="${linkStyle}">${data.prev.id}</a><span style="${timeStyle}">[${data.prev.time}]</span></div>`;
            };
            const maxIdInfo = document.createElement('div');
            maxIdInfo.id = 'nh-max-gid-display';
            maxIdInfo.style.cssText = 'position:fixed;bottom:80px;right:10px;z-index:99990;background:rgba(0,0,0,0.9);padding:8px 12px;border-radius:4px;color:#ccc;font-size:12px;pointer-events:auto;text-align:right;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;flex-direction:column;align-items:flex-end;';
            maxIdInfo.innerHTML = renderGidInfo(pushHistory);
            document.body.appendChild(maxIdInfo);
        }
    }

    let isScheduled = false;
    function requestRender() {
        if (!isScheduled) {
            isScheduled = true;
            requestAnimationFrame(() => {
                initFeatures();
                isScheduled = false;
            });
        }
    }

    const originalPushState = history.pushState;
    history.pushState = function() {
        originalPushState.apply(this, arguments);
        requestRender();
    };
    const originalReplaceState = history.replaceState;
    history.replaceState = function() {
        originalReplaceState.apply(this, arguments);
        requestRender();
    };
    window.addEventListener('popstate', requestRender);

    function observeDOM() {
        const observer = new MutationObserver(requestRender);
        const target = document.documentElement || document.body;
        if (target) {
            observer.observe(target, { childList: true, subtree: true });
            requestRender();
        }
    }

    // 自动同步：浏览器 Cookie（解除 Cloudflare 403）+ 下载服务完成状态（自动标记已下载）
    setTimeout(() => syncCookieToServer(true), 2500);
    setInterval(() => syncCookieToServer(false), 60000);
    setTimeout(syncDownloadedFromServer, 3000);
    setInterval(syncDownloadedFromServer, 60000);
    // 标签页切回前台时立即同步（长开页面也能及时感知完成）
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') syncDownloadedFromServer();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeDOM);
    } else {
        observeDOM();
    }

})();