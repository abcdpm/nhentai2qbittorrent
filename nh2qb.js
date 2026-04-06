// ==UserScript==
// @name         nHentai → qBittorrent
// @namespace    http://tampermonkey.net/
// @version      2.4.12
// @updateURL    https://github.com/abcdpm/nhentai2qbittorrent/raw/refs/heads/main/nh2qb.js
// @downloadURL  https://github.com/abcdpm/nhentai2qbittorrent/raw/refs/heads/main/nh2qb.js
// @description  在 nHentai 页面添加按钮，支持批量推送到 qBittorrent、美观通知栏、设置弹窗、自动记忆复选框状态、封面右下角快捷复制链接 (重构设置界面为暗色主题，优化输入框样式)
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
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      nhentai.net
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    /**************************************************************************
     * 1. 样式定义 (CSS Styles)
     **************************************************************************/

    GM_addStyle(`
        #nh-qb-container { position: fixed; right: 20px; top: 20px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; pointer-events: none; }
        .nh-qb-notify { position: relative; margin-bottom: 10px; width: 220px; max-width: calc(100vw - 40px); background: rgba(18,18,18,0.95); color: #fff; padding: 12px 14px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); transform: translateX(250px); transition: transform 0.36s cubic-bezier(.2,.9,.2,1), opacity 0.36s; pointer-events: auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; font-size: 13px; opacity: 0; }
        .nh-qb-notify.show { transform: translateX(0); opacity: 1; }
        .nh-qb-notify .title { font-weight:600; margin-bottom:6px; color: #ed2553; }
        .nh-qb-notify .line { margin-top:6px; }
        .nh-qb-notify .error { color: #ff8b8b; font-weight:600; }
        .nh-qb-fixed-btn { position:fixed; bottom:20px; right:10px; z-index:99999; }
        .nh-qb-fixed-btn .btn { margin-left:6px; }
        .nh-copy-link-btn { position: absolute; bottom: 6px; right: 6px; z-index: 30; background: rgba(0, 0, 0, 0.75); color: #fff; border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; opacity: 1; transition: background 0.2s; display: inline-flex; align-items: center; justify-content: center; }
        .gallery:hover .nh-copy-link-btn { opacity: 1; }
        .nh-copy-link-btn:hover { background: rgba(237, 37, 83, 0.9); }
        .nh-caption-cn { position: absolute !important; top: 100% !important; bottom: auto !important; left: 0 !important; width: 100% !important; z-index: 20 !important; border: 3px solid rgba(255, 0, 0, 0.5) !important; box-shadow: 0 0 6px rgba(255, 0, 0, 0.8) !important; box-sizing: border-box !important; background-color: #404040 !important; color: #d9d9d9 !important; line-height: 15px !important; height: auto !important; max-height: 42px !important; overflow: hidden !important; white-space: normal !important; transition: max-height 0.3s ease !important; }
        .gallery:hover .nh-caption-cn { max-height: 300px !important; }
        .nh-cover-dimmed { filter: brightness(0.6) !important; }

        /* 修复新版 Svelte 架构下全局按钮颜色丢失的问题，使用 flex 保证绝对居中 */
        .btn { padding: 8px 12px; border-radius: 4px; border: none; cursor: pointer; font-size: 14px; font-weight: bold; transition: background-color 0.2s; display: inline-flex; align-items: center; justify-content: center; font-family: inherit; text-align: center; box-sizing: border-box; line-height: normal; height: auto; min-height: 36px; }
        .btn-primary { background-color: #ed2553 !important; color: #ffffff !important; }
        .btn-primary:hover { background-color: #f0466d !important; }
        .btn-secondary { background-color: #34353b !important; color: #ffffff !important; }
        .btn-secondary:hover { background-color: #42444c !important; }
        .btn:disabled { opacity: 0.6 !important; cursor: not-allowed !important; }

        /* 设置弹窗暗色主题 */
        .nhqb-modal { background: #222224; color: #e0e0e0; padding: 20px 24px; border-radius: 10px; min-width: 340px; width: 420px; max-width: 90%; box-shadow: 0 12px 48px rgba(0,0,0,0.8); font-size: 14px; border: 1px solid #3c3c3c; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .nhqb-modal h3 { margin-top: 0; color: #fff; border-bottom: 1px solid #3c3c3c; padding-bottom: 12px; margin-bottom: 18px; font-size: 18px; font-weight: 600; }
        .nhqb-modal .field-group { margin-bottom: 14px; text-align: left; }
        .nhqb-modal label { font-weight: 600; color: #bbb; display: block; margin-bottom: 6px; font-size: 13px; }
        .nhqb-modal input[type="text"], .nhqb-modal input[type="password"] { width: 100%; padding: 10px 12px; background: #161618; color: #fff; border: 1px solid #444; border-radius: 6px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; box-sizing: border-box; font-family: inherit; font-size: 14px; }
        .nhqb-modal input[type="text"]:focus, .nhqb-modal input[type="password"]:focus { border-color: #ed2553; box-shadow: 0 0 0 2px rgba(237,37,83,0.25); }
        .nhqb-modal .divider { margin-bottom: 16px; padding-top: 16px; border-top: 1px solid #3c3c3c; text-align: left; }
        .nhqb-modal .btn-group { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
    `);

    /**************************************************************************
     * 2. 全局状态与配置管理 (Configuration)
     **************************************************************************/

    let QB_URL  = localStorage.getItem('qb_url')  || 'http://127.0.0.1:8080';
    let QB_USER = localStorage.getItem('qb_user') || 'admin';
    let QB_PASS = localStorage.getItem('qb_pass') || 'adminadmin';
    let QB_PATH = localStorage.getItem('qb_path') || '/downloads';

    const CHECK_KEY = 'nh_qb_checked';
    const DOWNLOADED_KEY = 'nh_qb_downloaded_gids';
    let savedChecked = {};
    let downloadedSet = new Set();

    function syncLocalState() {
        try { savedChecked = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}'); } catch(e) { savedChecked = {}; }
        try {
            const stored = JSON.parse(localStorage.getItem(DOWNLOADED_KEY) || '[]');
            if (Array.isArray(stored)) downloadedSet = new Set(stored);
        } catch (e) { console.error('History load error', e); }

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

    // 跨标签页同步状态
    window.addEventListener('storage', (e) => {
        if (e.key === DOWNLOADED_KEY || e.key === CHECK_KEY) {
            requestRender();
        }
    });

    /**************************************************************************
     * 3. 基础工具函数 (Utilities)
     **************************************************************************/

    function notify(html, duration = 5000) {
        let container = document.getElementById('nh-qb-container');
        if (!container) { container = document.createElement('div'); container.id = 'nh-qb-container'; document.body.appendChild(container); }
        const el = document.createElement('div'); el.className = 'nh-qb-notify'; el.innerHTML = html; container.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        let closing = false; let timer = setTimeout(close, duration);
        el.addEventListener('mouseenter', () => { clearTimeout(timer); });
        el.addEventListener('mouseleave', () => { if (!closing) timer = setTimeout(close, duration); });
        function close() {
            if (closing) return; closing = true; el.classList.remove('show'); el.style.opacity = '0';
            setTimeout(() => { try { el.remove(); } catch (e){} if (container.childNodes.length === 0) container.remove(); }, 400);
        }
        return { close };
    }

    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => { notify(`<div class='title'>已复制链接</div><div style="word-break:break-all">${escapeHtml(text)}</div>`); });
        } else {
            const input = document.createElement('textarea'); input.value = text; document.body.appendChild(input); input.select(); document.execCommand('copy'); document.body.removeChild(input);
            notify(`<div class='title'>已复制链接</div><div style="word-break:break-all">${escapeHtml(text)}</div>`);
        }
    }

    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }
    function sanitizeFileName(name) { return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 150).trim().replace(/[.+\-\s]+$/g, ''); }

    /**************************************************************************
     * 4. qBittorrent 交互逻辑 (API Interaction)
     **************************************************************************/

    function loginQB() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST', url: QB_URL.replace(/\/$/, '') + '/api/v2/auth/login',
                data: `username=${encodeURIComponent(QB_USER)}&password=${encodeURIComponent(QB_PASS)}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                onload: res => { if (res.responseText === 'Ok.') resolve(true); else reject(new Error('login failed')); },
                onerror: () => reject(new Error('login error'))
            });
        });
    }

    function pushTorrentPromise(gid, title) {
        return new Promise(async (resolve) => {
            const torrentUrl = `https://nhentai.net/g/${gid}/download`;

            try {
                const tRes = await fetch(torrentUrl, {
                    method: 'GET',
                    headers: { 'Accept': 'application/x-bittorrent, application/octet-stream, */*' }
                });

                if (!tRes.ok) {
                    return resolve({ ok:false, gid, title, error: `获取种子失败: HTTP ${tRes.status} (可能种子未生成)` });
                }

                const blob = await tRes.blob();

                if (blob.type.includes('text/html')) {
                    return resolve({ ok:false, gid, title, error: `下载被 Cloudflare 盾拦截` });
                }

                const cleanTitle = sanitizeFileName(title);
                const finalPath = QB_PATH.replace(/\/$/, '') + '/' + cleanTitle + '/' + gid;
                const fd = new FormData();
                fd.append('torrents', blob, `${gid}.torrent`);
                fd.append('rename', cleanTitle);
                fd.append('savepath', finalPath);
                fd.append('root_folder', 'true');

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: QB_URL.replace(/\/$/, '') + '/api/v2/torrents/add',
                    data: fd,
                    onload: upRes => {
                        if (upRes.status >= 200 && upRes.status < 300 || upRes.responseText.includes('Ok.')) resolve({ ok:true, gid, title });
                        else resolve({ ok:false, gid, title, error: `推送到qB失败: ${upRes.status}` });
                    },
                    onerror: () => resolve({ ok:false, gid, title, error: 'qB接口网络报错 (请检查qB配置或网络通信)' })
                });

            } catch (err) {
                return resolve({ ok:false, gid, title, error: `网络请求失败: ${err.message}` });
            }
        });
    }

    /**************************************************************************
     * 5. 详情页功能 (Single Page Logic)
     **************************************************************************/

    function addSinglePageButton() {
        const downloadAnchor = document.querySelector("a[href*='/download']");
        if (!downloadAnchor) return;

        const currentGid = location.pathname.split('/')[2];
        const isDownloaded = downloadedSet.has(currentGid);

        let btn = downloadAnchor.parentNode.querySelector('.nh-custom-btn-single');

        if (downloadAnchor.getAttribute('data-nh-gid') === currentGid) {
            if (btn) {
                if (isDownloaded) {
                    btn.innerText = '已下载 (再次推送)';
                    btn.style.backgroundColor = '#4caf50'; btn.style.borderColor = '#4caf50';
                } else {
                    btn.innerText = '推送到 qBittorrent';
                    btn.style.backgroundColor = ''; btn.style.borderColor = '';
                }
            }
            return;
        }

        if (btn) btn.remove();
        downloadAnchor.setAttribute('data-nh-gid', currentGid);

        btn = document.createElement('button');
        btn.className = 'btn btn-primary nh-custom-btn-single';
        if (isDownloaded) {
            btn.innerText = '已下载 (再次推送)';
            btn.style.backgroundColor = '#4caf50'; btn.style.borderColor = '#4caf50';
        } else { btn.innerText = '推送到 qBittorrent'; }

        downloadAnchor.parentNode.appendChild(btn);

        btn.addEventListener('click', async () => {
            const gid = location.pathname.split('/')[2];
            const title = document.querySelector('#info h2')?.innerText?.trim() || document.querySelector('#info h1')?.innerText?.trim() || gid;
            let loginToast;
            try { loginToast = notify(`<div class='title'>正在登录 qBittorrent…</div>`); await loginQB(); loginToast.close(); }
            catch (e) { if (loginToast) loginToast.close(); notify(`<div class='title'>登录失败</div>无法登录 qBittorrent，请检查设置。`, 6000); return; }

            const startToast = notify(`<div class='title'>开始推送</div>正在下载并推送：${gid} - ${escapeHtml(title)}`);
            const res = await pushTorrentPromise(gid, title);
            startToast.close();

            if (res.ok) {
                notify(`<div class='title'>推送成功</div>成功：1/1`);
                downloadedSet.add(gid); localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloadedSet]));
                requestRender();
            } else {
                notify(`<div class='title'>推送完成（有失败）</div>成功：0/1<br><span class='error'>失败：${res.gid} - ${escapeHtml(res.title)}</span><br><span style="color:#ffc107;font-size:12px;">原因：${res.error}</span>` , 10000);
            }
        });
    }

    /**************************************************************************
     * 6. 列表页功能 (Batch Mode Logic)
     **************************************************************************/

    function addBatchFeature() {
        const HISTORY_KEY = 'nh_qb_push_history_v2';
        const OLD_KEY = 'nh_qb_pushed_max_gid';
        const getBjTime = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        let pushHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{"max":{"id":0,"time":"--"},"prev":{"id":0,"time":"--"}}');
        const oldSimpleVal = parseInt(localStorage.getItem(OLD_KEY) || '0');
        if (oldSimpleVal > pushHistory.max.id) { pushHistory.max.id = oldSimpleVal; pushHistory.max.time = '旧记录'; }

        const renderGidInfo = (data) => {
            const linkStyle = 'color:#ed2553;font-weight:bold;font-size:14px;margin:0 4px;text-decoration:none;border-bottom:1px dashed #ed2553;';
            const timeStyle = 'color:#888;font-size:11px;font-family:monospace;min-width:110px;text-align:right;display:inline-block;';
            const rowStyle = 'display:flex;align-items:center;justify-content:flex-end;width:100%;margin-bottom:2px;';
            return `<div style="${rowStyle}"><span>已推送最大 GID:</span><a href="/g/${data.max.id}/" target="_blank" style="${linkStyle}">${data.max.id}</a><span style="${timeStyle}">[${data.max.time}]</span></div>` +
                   `<div style="${rowStyle}"><span style="color:#aaa;">上次推送最大 GID:</span><a href="/g/${data.prev.id}/" target="_blank" style="${linkStyle}">${data.prev.id}</a><span style="${timeStyle}">[${data.prev.time}]</span></div>`;
        };

        if (!document.getElementById('nh-max-gid-display')) {
            const maxIdInfo = document.createElement('div');
            maxIdInfo.id = 'nh-max-gid-display';
            maxIdInfo.style.cssText = 'position:fixed;bottom:80px;right:10px;z-index:99990;background:rgba(0,0,0,0.9);padding:8px 12px;border-radius:4px;color:#ccc;font-size:12px;pointer-events:auto;text-align:right;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;flex-direction:column;align-items:flex-end;';
            maxIdInfo.innerHTML = renderGidInfo(pushHistory);
            document.body.appendChild(maxIdInfo);
        }

        if (!document.getElementById('nhqb_batch_btn')) {
            const batchBtn = document.createElement('button');
            batchBtn.id = 'nhqb_batch_btn';
            batchBtn.className = 'btn btn-primary';
            batchBtn.innerText = '批量推送到 qBittorrent';
            batchBtn.style.cssText = 'position:fixed;bottom:20px;right:80px;z-index:99999;';
            document.body.appendChild(batchBtn);

            batchBtn.addEventListener('click', async () => {
                const allChecked = Array.from(document.querySelectorAll("input[type=checkbox][data-gid]:checked"));
                if (!allChecked.length) { notify(`<div class='title'>提示</div>请先勾选要推送的本子！`); return; }

                const checked = allChecked.filter(cb => {
                    const isDownloaded = downloadedSet.has(cb.dataset.gid);
                    if (isDownloaded) { cb.checked = false; delete savedChecked[cb.dataset.gid]; }
                    return !isDownloaded;
                });

                const skippedCount = allChecked.length - checked.length;
                if (skippedCount > 0) notify(`<div class='title'>自动去重</div>已自动跳过 ${skippedCount} 个已下载的任务`, 4000);
                if (checked.length === 0) {
                    localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
                    return;
                }

                let loginToast;
                try { loginToast = notify(`<div class='title'>正在登录 qBittorrent…</div>`); await loginQB(); loginToast.close(); }
                catch (e) { if (loginToast) loginToast.close(); notify(`<div class='title'>登录失败</div>无法登录 qBittorrent，请检查设置。`, 6000); return; }

                const total = checked.length;
                const progressNotify = notify(`<div class='title'>开始推送</div>已推送：0/${total}` , 20000);

                const results = await Promise.all(checked.map(cb => {
                    const gid = cb.dataset.gid; const title = cb.dataset.title;
                    return pushTorrentPromise(gid, title);
                }));

                const successItems = results.filter(r => r.ok);
                if (successItems.length > 0) {
                    successItems.forEach(item => {
                        downloadedSet.add(item.gid);
                        delete savedChecked[item.gid];
                        const cb = document.querySelector(`input[data-gid="${item.gid}"]`);
                        if (cb) cb.checked = false;
                    });

                    localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
                    localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloadedSet]));

                    const currentBatchGids = successItems.map(r => parseInt(r.gid));
                    const currentBatchMax = Math.max(...currentBatchGids);
                    if (currentBatchMax > pushHistory.max.id) {
                        pushHistory.prev.id = pushHistory.max.id; pushHistory.prev.time = pushHistory.max.time;
                        pushHistory.max.id = currentBatchMax; pushHistory.max.time = getBjTime();
                        localStorage.setItem(HISTORY_KEY, JSON.stringify(pushHistory)); localStorage.setItem(OLD_KEY, currentBatchMax);
                        const infoEl = document.getElementById('nh-max-gid-display');
                        if(infoEl) infoEl.innerHTML = renderGidInfo(pushHistory);
                    }
                    requestRender();
                }

                const successCount = successItems.length;
                const failed = results.filter(r => !r.ok);
                let failedHtml = failed.length ? '<div class="line"><strong>失败列表：</strong>' + failed.map(f => `<div class="error" style="margin-bottom:6px">${f.gid} - ${escapeHtml(f.title)}<br><span style="color:#ffc107;font-size:11px;">[${escapeHtml(f.error)}]</span></div>`).join('') + '</div>' : '';

                progressNotify.close();
                notify(`<div class='title'>推送完成</div>成功：${successCount}/${total}` + failedHtml, 8000 + failed.length*2000);
            });
        }

        if (!document.getElementById('nhqb_settings_wrapper')) {
            const setBtn = document.createElement('div');
            setBtn.id = 'nhqb_settings_wrapper';
            setBtn.className = 'nh-qb-fixed-btn';
            setBtn.innerHTML = `<button id='nhqb_settings' class='btn btn-primary'>设置</button>`;
            document.body.appendChild(setBtn);
            document.getElementById('nhqb_settings').addEventListener('click', showSettingsModal);
        }

        const thumbs = document.querySelectorAll('.gallery');
        thumbs.forEach(thumb => {
            const a = thumb.querySelector('a'); if (!a) return;
            const href = a.href || '';
            const m = href.match(/\/g\/(\d+)\//) || href.match(/\/g\/(\d+)$/);
            const gid = m ? m[1] : (href.split('/g/')[1] ? href.split('/g/')[1].split('/')[0] : null);
            if (!gid) return;

            const isDownloaded = downloadedSet.has(gid);

            if (thumb.getAttribute('data-nh-gid') === gid) {
                const cover = thumb.querySelector('.cover');
                let tag = thumb.querySelector('.downloaded-tag');
                if (isDownloaded) {
                    if (!tag) {
                        tag = document.createElement('div');
                        tag.className = 'downloaded-tag nh-custom-injected';
                        tag.style.cssText = 'position:absolute;top:0;left:0;background:#4caf50;color:#fff;font-size:12px;padding:2px 6px;z-index:25;border-bottom-right-radius:4px;font-weight:bold;box-shadow:2px 2px 4px rgba(0,0,0,0.5);';
                        tag.innerText = '已下载'; thumb.appendChild(tag);
                    }
                    if (cover) cover.classList.add('nh-cover-dimmed');
                } else {
                    if (tag) tag.remove();
                    if (cover) cover.classList.remove('nh-cover-dimmed');
                }

                const cb = thumb.querySelector('input[type=checkbox]');
                if (cb) cb.checked = !!savedChecked[gid];

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
            if (isDownloaded) {
                const tag = document.createElement('div');
                tag.className = 'downloaded-tag nh-custom-injected';
                tag.style.cssText = 'position:absolute;top:0;left:0;background:#4caf50;color:#fff;font-size:12px;padding:2px 6px;z-index:25;border-bottom-right-radius:4px;font-weight:bold;box-shadow:2px 2px 4px rgba(0,0,0,0.5);';
                tag.innerText = '已下载'; thumb.appendChild(tag);
                if(cover) cover.classList.add('nh-cover-dimmed');
            } else {
                if(cover) cover.classList.remove('nh-cover-dimmed');
            }
            thumb.appendChild(cb);

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
            <h3>qBittorrent 配置</h3>
            <div class="field-group"><label>地址：</label><input type="text" id="nhq_addr" value="${escapeHtml(QB_URL)}"></div>
            <div class="field-group"><label>下载根目录：</label><input type="text" id="nhq_path" value="${escapeHtml(QB_PATH)}" placeholder="/downloads"></div>
            <div class="field-group"><label>用户名：</label><input type="text" id="nhq_user" value="${escapeHtml(QB_USER)}"></div>
            <div class="field-group"><label>密码：</label><input type="password" id="nhq_pass" value="${escapeHtml(QB_PASS)}"></div>
            
            <div class="divider">
                <label>历史记录管理：</label>
                <button id="nhq_sync" class="btn btn-secondary" style="margin-top:6px;width:100%;">🔄 从 qBittorrent 同步已下载记录</button>
                <div style="display:flex; gap:10px; margin-top:10px;">
                    <button id="nhq_backup" class="btn btn-secondary" style="flex:1;">⬇️ 备份记录到本地</button>
                    <button id="nhq_restore_btn" class="btn btn-secondary" style="flex:1;">⬆️ 从文件恢复记录</button>
                    <input type="file" id="nhq_restore_input" accept=".json" style="display:none;">
                </div>
            </div>

            <div class="btn-group">
                <button id="nhq_test" class="btn btn-secondary">测试连接</button>
                <button id="nhq_cancel" class="btn btn-secondary">取消</button>
                <button id="nhq_save" class="btn btn-primary">保存</button>
            </div>
        `;

        overlay.appendChild(modal); document.body.appendChild(overlay);

        modal.querySelector('#nhq_backup').addEventListener('click', () => {
            const data = localStorage.getItem(DOWNLOADED_KEY) || '[]'; const blob = new Blob([data], { type: 'application/json' }); const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, "");
            a.download = `nh_downloaded_history_${dateStr}.json`; a.href = url; a.click(); URL.revokeObjectURL(url);
            notify(`<div class='title'>备份已下载</div>已保存到本地磁盘`);
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
                    notify(`<div class='title'>恢复成功</div>成功导入 ${addedCount} 条新记录<br>当前总记录：${downloadedSet.size}`);
                    requestRender();
                } catch (err) { console.error(err); notify(`<div class='title'>导入失败</div>文件格式错误或已损坏`, 4000); }
            };
            reader.readAsText(file);
        });

        modal.querySelector('#nhq_sync').addEventListener('click', async () => {
            const btn = modal.querySelector('#nhq_sync'); const originalText = btn.innerText; btn.innerText = '正在获取数据 (可能需要几秒)...'; btn.disabled = true;
            try {
                await loginQB();
                GM_xmlhttpRequest({
                    method: 'GET', url: QB_URL.replace(/\/$/, '') + '/api/v2/torrents/info',
                    onload: function(response) {
                        try {
                            const torrents = JSON.parse(response.responseText); let newCount = 0;
                            torrents.forEach(t => {
                                const parts = t.save_path.split(/[/\\]/); const folderName = parts[parts.length - 1];
                                if (/^\d+$/.test(folderName) && !downloadedSet.has(folderName)) { downloadedSet.add(folderName); newCount++; }
                            });
                            localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloadedSet]));
                            notify(`<div class='title'>同步成功</div>新增记录：${newCount} 条<br>当前总记录：${downloadedSet.size} 条`);
                            requestRender();
                        } catch (e) { notify(`<div class='title'>解析失败</div>数据格式错误或 qB 响应异常`, 5000); console.error(e); }
                        finally { btn.innerText = originalText; btn.disabled = false; }
                    },
                    onerror: function() { notify(`<div class='title'>同步失败</div>网络请求错误`, 5000); btn.innerText = originalText; btn.disabled = false; }
                });
            } catch (e) { notify(`<div class='title'>同步失败</div>无法连接 qBittorrent`, 5000); btn.innerText = originalText; btn.disabled = false; }
        });

        modal.querySelector('#nhq_cancel').addEventListener('click', () => overlay.remove());

        modal.querySelector('#nhq_save').addEventListener('click', () => {
            QB_URL = modal.querySelector('#nhq_addr').value.trim(); QB_PATH = modal.querySelector('#nhq_path').value.trim(); QB_USER = modal.querySelector('#nhq_user').value.trim(); QB_PASS = modal.querySelector('#nhq_pass').value;
            localStorage.setItem('qb_url', QB_URL); localStorage.setItem('qb_path', QB_PATH); localStorage.setItem('qb_user', QB_USER); localStorage.setItem('qb_pass', QB_PASS);
            notify(`<div class='title'>配置已保存</div>`); overlay.remove();
        });

        modal.querySelector('#nhq_test').addEventListener('click', async () => {
            QB_URL = modal.querySelector('#nhq_addr').value.trim(); QB_USER = modal.querySelector('#nhq_user').value.trim(); QB_PASS = modal.querySelector('#nhq_pass').value;
            const t = notify(`<div class='title'>正在测试连接…</div>`);
            try { await loginQB(); t.close(); notify(`<div class='title'>连接成功</div>`); }
            catch(e) { t.close(); notify(`<div class='title'>连接失败</div>无法登陆 qBittorrent，请检查地址/用户名/密码`, 6000); }
        });
    }

    /**************************************************************************
     * 7.1 全局界面定制 (UI Customization)
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
     * 8. SPA 路由适配与初始化 (Initialization via MutationObserver)
     **************************************************************************/

    function initFeatures() {
        syncLocalState();

        customizeUI();
        if (location.pathname.startsWith('/g/')) {
            addSinglePageButton();
        } else {
            addBatchFeature();
        }

        if (!document.getElementById('nhqb_settings_fallback')) {
            const fix = document.createElement('div');
            fix.id = 'nhqb_settings_fallback';
            fix.className = 'nh-qb-fixed-btn';
            fix.innerHTML = `<button id='nhqb_settings_btn2' class='btn btn-primary' style='position:fixed;bottom:20px;right:10px;z-index:99999'>设置</button>`;
            document.body.appendChild(fix);
            document.getElementById('nhqb_settings_btn2').addEventListener('click', showSettingsModal);
        }
    }

    // 将渲染调度封装，利用 requestAnimationFrame 防抖且消除闪烁
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

    requestRender(); // 初次加载渲染

    // 监听 DOM 变化
    const observer = new MutationObserver(() => {
        requestRender();
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();