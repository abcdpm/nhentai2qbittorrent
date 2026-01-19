// ==UserScript==
// @name         nHentai → qBittorrent
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  在 nHentai 页面添加按钮，支持批量推送到 qBittorrent、美观通知栏、设置弹窗、自动记忆复选框状态、封面右下角快捷复制链接
// @author       you Gemini Chatgpt
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
     * 包含：通知容器、日志卡片、固定按钮、以及封面上的复制按钮样式
     **************************************************************************/
    GM_addStyle(`
        /* 右上角通知浮层容器 */
        #nh-qb-container {
            position: fixed;
            right: 20px;
            top: 20px;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            pointer-events: none;
        }
        /* 单条通知卡片样式 */
        .nh-qb-notify {
            position: relative;
            margin-bottom: 10px;
            width: 220px;
            max-width: calc(100vw - 40px);
            background: rgba(18,18,18,0.95);
            color: #fff;
            padding: 12px 14px;
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            transform: translateX(250px);
            transition: transform 0.36s cubic-bezier(.2,.9,.2,1), opacity 0.36s;
            pointer-events: auto;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
            font-size: 13px;
            opacity: 0;
        }
        /* 进场动画激活态 */
        .nh-qb-notify.show {
            transform: translateX(0);
            opacity: 1;
        }
        .nh-qb-notify .title { font-weight:600; margin-bottom:6px; color: #ed2553; }
        .nh-qb-notify .line { margin-top:6px; }
        .nh-qb-notify .error { color: #ff8b8b; font-weight:600; }

        /* 页面右下角悬浮按钮组 */
        .nh-qb-fixed-btn { position:fixed; bottom:20px; right:10px; z-index:99999; }
        .nh-qb-fixed-btn .btn { margin-left:6px; }

        /* 封面卡片右下角的复制链接按钮 */
        .nh-copy-link-btn {
            position: absolute;
            bottom: 6px;
            right: 6px;
            z-index: 30;
            background: rgba(0, 0, 0, 0.75);
            color: #fff;
            border: none;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            opacity: 1;
            transition: background 0.2s;
        }
        .gallery:hover .nh-copy-link-btn { opacity: 1; }
        .nh-copy-link-btn:hover { background: rgba(237, 37, 83, 0.9); }
    `);

    /**************************************************************************
     * 2. 全局状态与配置管理 (Configuration)
     * 从 localStorage 加载 qBittorrent 设置及用户勾选记忆
     **************************************************************************/
    // qBittorrent 连接配置
    let QB_URL  = localStorage.getItem('qb_url')  || 'http://192.168.1.1:8848';
    let QB_USER = localStorage.getItem('qb_user') || 'admin';
    let QB_PASS = localStorage.getItem('qb_pass') || 'adminadmin';
    // 下载根目录配置
    let QB_PATH = localStorage.getItem('qb_path') || '/downloads';

    // 批量勾选状态记忆
    const CHECK_KEY = 'nh_qb_checked';
    let savedChecked = {};
    try {
        savedChecked = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}');
    } catch(e) {
        savedChecked = {};
    }

    // 【v2.0 新增 1/4】初始化已下载历史记录 (使用 Set 提高查询性能)
    // 读取速度极快（毫秒级）。Set.has(id) 的查询时间复杂度是 O(1)。无论里面存了 10 条还是 10 万条，判断“是否已下载”的速度都是瞬间完成的。
    // 存储空间占用极小。一个 GID 通常是 6 位数字（例如 374094），加上分隔符，平均每个占用约 7-8 字节。
    // localStorage 的单域名上限通常是 5 MB（约 5000 KB）。你可以连续下载 50 年 甚至更久，才会碰到存储上限。
    const DOWNLOADED_KEY = 'nh_qb_downloaded_gids';
    let downloadedSet = new Set();
    try {
        const stored = JSON.parse(localStorage.getItem(DOWNLOADED_KEY) || '[]');
        if (Array.isArray(stored)) downloadedSet = new Set(stored);
    } catch (e) { 
        console.error('History load error', e); 
    }

    /**************************************************************************
     * 3. 基础工具函数 (Utilities)
     **************************************************************************/

    // 显示自定义通知弹窗
    function notify(html, duration = 5000) {
        let container = document.getElementById('nh-qb-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'nh-qb-container';
            document.body.appendChild(container);
        }

        const el = document.createElement('div');
        el.className = 'nh-qb-notify';
        el.innerHTML = html;
        container.appendChild(el);

        requestAnimationFrame(() => el.classList.add('show'));

        let closing = false;
        let timer = setTimeout(close, duration);

        el.addEventListener('mouseenter', () => { clearTimeout(timer); });
        el.addEventListener('mouseleave', () => { if (!closing) timer = setTimeout(close, duration); });

        function close() {
            if (closing) return;
            closing = true;
            el.classList.remove('show');
            el.style.opacity = '0';
            setTimeout(() => {
                try { el.remove(); } catch (e){}
                if (container.childNodes.length === 0) container.remove();
            }, 400);
        }
        return { close };
    }

    // 复制文本到剪贴板（兼容方案）
    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                notify(`<div class='title'>已复制链接</div><div style="word-break:break-all">${escapeHtml(text)}</div>`);
            });
        } else {
            const input = document.createElement('textarea');
            input.value = text;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            notify(`<div class='title'>已复制链接</div><div style="word-break:break-all">${escapeHtml(text)}</div>`);
        }
    }

    // HTML 转义防止 XSS
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]);
    }

    // 清理文件名非法字符
    function sanitizeFileName(name) {
        // 1. 替换系统非法字符为 " "
        // 2. 合并多余空格
        // 3. 截取长度 (防止文件名过长)
        let clean = name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 150).trim();
        // 【新增修改】正则去除末尾的特殊字符 (. + - 空格)
        // 持续替换直到末尾没有这些字符为止
        return clean.replace(/[.+\-\s]+$/g, '');
    }

    /**************************************************************************
     * 4. qBittorrent 交互逻辑 (API Interaction)
     **************************************************************************/

    // qBittorrent 身份验证登录
    function loginQB() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: QB_URL.replace(/\/$/, '') + '/api/v2/auth/login',
                data: `username=${encodeURIComponent(QB_USER)}&password=${encodeURIComponent(QB_PASS)}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                onload: res => {
                    if (res.responseText === 'Ok.') resolve(true);
                    else reject(new Error('login failed'));
                },
                onerror: () => reject(new Error('login error'))
            });
        });
    }

    // 推送单个种子到 qBittorrent (下载种子并上传)
    function pushTorrentPromise(gid, title) {
        return new Promise((resolve) => {
            const torrentUrl = `https://nhentai.net/g/${gid}/download`;

            GM_xmlhttpRequest({
                method: 'GET',
                url: torrentUrl,
                responseType: 'arraybuffer',
                withCredentials: true,
                headers: { 'Referer': window.location.href },
                onload: tRes => {
                    if (tRes.status !== 200) return resolve({ ok:false, gid, title, error: `download status ${tRes.status}` });

                    const blob = new Blob([tRes.response], { type: 'application/x-bittorrent' });
                    const cleanTitle = sanitizeFileName(title);
                    const finalPath = QB_PATH.replace(/\/$/, '') + '/' + cleanTitle + '/' + gid;

                    const fd = new FormData();
                    // 1. 种子二进制文件
                    fd.append('torrents', blob, `${gid}.torrent`);
                    // 2. 任务重命名
                    fd.append('rename', cleanTitle);
                    // 3. 指定保存绝对路径
                    fd.append('savepath', finalPath);
                    // 4. 强制创建根目录
                    fd.append('root_folder', 'true');

                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: QB_URL.replace(/\/$/, '') + '/api/v2/torrents/add',
                        data: fd,
                        onload: upRes => {
                            if (upRes.status >= 200 && upRes.status < 300 || upRes.responseText.includes('Ok.')) resolve({ ok:true, gid, title });
                            else resolve({ ok:false, gid, title, error: `upload status ${upRes.status}` });
                        },
                        onerror: () => resolve({ ok:false, gid, title, error: 'upload error' })
                    });
                },
                onerror: () => resolve({ ok:false, gid, title, error: 'download error' })
            });
        });
    }

    /**************************************************************************
     * 5. 详情页功能 (Single Page Logic)
     * 在本子详情页添加单点推送按钮
     **************************************************************************/
    function addSinglePageButton() {
        const downloadAnchor = document.querySelector("a[href*='/download']");
        if (!downloadAnchor) return;

        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.innerText = '推送到 qBittorrent';
        downloadAnchor.parentNode.appendChild(btn);

        btn.addEventListener('click', async () => {
            const gid = location.pathname.split('/')[2];
            const title = document.querySelector('#info h1')?.innerText?.trim() || gid;

            let loginToast;
            try {
                loginToast = notify(`<div class='title'>正在登录 qBittorrent…</div>`);
                await loginQB();
                loginToast.close();
            } catch (e) {
                if (loginToast) loginToast.close();
                notify(`<div class='title'>登录失败</div>无法登录 qBittorrent，请检查设置。`, 6000);
                return;
            }

            const startToast = notify(`<div class='title'>开始推送</div>正在下载并推送：${gid} - ${escapeHtml(title)}`);
            const res = await pushTorrentPromise(gid, title);
            startToast.close();

            if (res.ok) notify(`<div class='title'>推送成功</div>成功：1/1`);
            else notify(`<div class='title'>推送完成（有失败）</div>成功：0/1<br><span class='error'>失败：${res.gid} - ${escapeHtml(res.title)}</span>` , 8000);
        });
    }

    /**************************************************************************
     * 6. 列表页功能 (Batch Mode Logic)
     * 处理列表页的复选框、记忆、批量推送及复制按钮、记录历史推送最大gid值及对应时间戳
     **************************************************************************/
    function addBatchFeature() {
        const thumbs = document.querySelectorAll('.gallery');
        if (!thumbs.length) return;

        // 记录历史推送最大gid值及对应时间戳
        // 初始化：初始化：强制显示双行，优化 Flex 布局防止覆盖
        const HISTORY_KEY = 'nh_qb_push_history_v2';
        const OLD_KEY = 'nh_qb_pushed_max_gid';
        const getBjTime = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        let pushHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{"max":{"id":0,"time":"--"},"prev":{"id":0,"time":"--"}}');
        // 数据迁移逻辑
        const oldSimpleVal = parseInt(localStorage.getItem(OLD_KEY) || '0');
        if (oldSimpleVal > pushHistory.max.id) {
            pushHistory.max.id = oldSimpleVal;
            pushHistory.max.time = '旧记录';
        }
        // 渲染函数：取消 if 判断，强制渲染两行
        const renderGidInfo = (data) => {
            const linkStyle = 'color:#ed2553;font-weight:bold;font-size:14px;margin:0 4px;text-decoration:none;border-bottom:1px dashed #ed2553;';
            const timeStyle = 'color:#888;font-size:11px;font-family:monospace;min-width:110px;text-align:right;display:inline-block;';
            const rowStyle = 'display:flex;align-items:center;justify-content:flex-end;width:100%;margin-bottom:2px;';
            // 第一行：最大 GID
            let html = `<div style="${rowStyle}">
                            <span>已推送最大 GID:</span>
                            <a href="/g/${data.max.id}/" target="_blank" style="${linkStyle}">${data.max.id}</a>
                            <span style="${timeStyle}">[${data.max.time}]</span>
                        </div>`;
            // 第二行：上次 GID (始终显示)
            html += `<div style="${rowStyle}">
                            <span style="color:#aaa;">上次推送最大 GID:</span>
                            <a href="/g/${data.prev.id}/" target="_blank" style="${linkStyle}">${data.prev.id}</a>
                            <span style="${timeStyle}">[${data.prev.time}]</span>
                        </div>`;
            return html;
        };
        const maxIdInfo = document.createElement('div');
        maxIdInfo.id = 'nh-max-gid-display';
        // 关键修改：display:flex + flex-direction:column 确保垂直排列，不被覆盖
        maxIdInfo.style.cssText = 'position:fixed;bottom:80px;right:10px;z-index:99990;background:rgba(0,0,0,0.9);padding:8px 12px;border-radius:4px;color:#ccc;font-size:12px;pointer-events:auto;text-align:right;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;flex-direction:column;align-items:flex-end;';
        maxIdInfo.innerHTML = renderGidInfo(pushHistory);
        document.body.appendChild(maxIdInfo);

        thumbs.forEach(thumb => {
            // 解析 GID
            const a = thumb.querySelector('a');
            if (!a) return;
            const href = a.href || '';
            const m = href.match(/\/g\/(\d+)\//) || href.match(/\/g\/(\d+)$/);
            const gid = m ? m[1] : (href.split('/g/')[1] ? href.split('/g/')[1].split('/')[0] : null);
            if (!gid) return;

            const title = (thumb.querySelector('.caption')?.innerText || gid).trim();
            thumb.style.position = 'relative';

            // 判断中文本子则高亮处理
            // 判断是否包含中文标签 (29963) 或标题含有 [Chinese]
            // tag 29963 = Chinese, tag 17249 = Translated
            const dataTags = thumb.getAttribute('data-tags') || '';
            const isChinese = dataTags.includes('29963') || title.includes('[Chinese]') || title.includes('汉化');
            if (isChinese) {
                // 红色加粗边框
                const caption = thumb.querySelector('.caption');
                if (caption) {
                    // 1. 布局定位：位于图片下方(top:100%)
                    caption.style.position = 'absolute';
                    caption.style.top = '100%';
                    caption.style.bottom = 'auto';
                    caption.style.left = '0';
                    caption.style.width = '100%';
                    caption.style.zIndex = '20';

                    // 2. 视觉样式：改为带透明度的红色边框 + 原站灰色背景
                    // rgba(255, 0, 0, 0.5) 表示红色，透明度 50%
                    caption.style.border = '3px solid rgba(255, 0, 0, 0.5)';
                    caption.style.boxShadow = '0 0 6px rgba(255, 0, 0, 0.8)';
                    caption.style.boxSizing = 'border-box';
                    caption.style.backgroundColor = '#404040'; // 原站深灰背景
                    caption.style.color = '#d9d9d9'; // 原站文字颜色
                    caption.style.lineHeight = '15px';

                    // 3. 初始折叠状态
                    caption.style.height = 'auto';
                    caption.style.maxHeight = '42px';
                    caption.style.overflow = 'hidden';
                    caption.style.whiteSpace = 'normal';
                    caption.style.transition = 'max-height 0.3s ease';

                    // 4. 交互逻辑：鼠标悬停展开
                    thumb.addEventListener('mouseenter', () => {
                        caption.style.maxHeight = '300px';
                    });

                    thumb.addEventListener('mouseleave', () => {
                        caption.style.maxHeight = '42px';
                    });
                }
            }

            thumb.style.position = 'relative';

            // 1. 批量选择复选框 (右上角)
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.gid = gid;
            cb.dataset.title = title;
            cb.style.cssText = 'position:absolute;top:6px;right:6px;z-index:20;width:27px;height:27px;transform:scale(1.05);';
            // 如果是中文本子，修改复选框颜色 (红色)
            if (isChinese) {
                cb.style.accentColor = '#ff0000'; // 选中状态：内部打勾背景变红
                // 视觉增强：
                // 1. box-shadow: 范围扩大到 6px，且使用纯红 (alpha=1)
                // 2. outline: 增加 2px 实线红边，让未选中时的方框也变成醒目的红色
                cb.style.boxShadow = '0 0 12px rgba(255, 0, 0, 1)';
                cb.style.outline = '2px solid #ff0000';
                // 设置轮廓偏移量为负数，消除红框与黑框之间的空隙
                cb.style.outlineOffset = '-2px';
                // 修正偏移：因为加了 outline，可能需要微调 margin 避免视觉偏差
                cb.style.margin = '1px';
            }

            // 恢复勾选状态
            if (savedChecked[gid]) cb.checked = true;
            cb.addEventListener('change', () => {
                if (cb.checked) savedChecked[gid] = title;
                else delete savedChecked[gid];
                localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));
            });
            thumb.appendChild(cb);

            // 2. 单本复制链接按钮 (右下角)
            const copyBtn = document.createElement('button');
            const fullLink = a.href;
            copyBtn.className = 'nh-copy-link-btn';
            copyBtn.innerText = '复制链接';
            copyBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                copyToClipboard(fullLink);
            };
            thumb.appendChild(copyBtn);
        });

        // 批量推送操作按钮
        const batchBtn = document.createElement('button');
        batchBtn.className = 'btn btn-primary';
        batchBtn.innerText = '批量推送到 qBittorrent';
        batchBtn.style.cssText = 'position:fixed;bottom:20px;right:80px;z-index:99999;';
        document.body.appendChild(batchBtn);

        // 设置入口按钮
        const setBtn = document.createElement('div');
        setBtn.className = 'nh-qb-fixed-btn';
        setBtn.innerHTML = `<button id='nhqb_settings' class='btn btn-primary'>设置</button>`;
        document.body.appendChild(setBtn);
        document.getElementById('nhqb_settings').addEventListener('click', showSettingsModal);

        // 批量推送执行逻辑
        batchBtn.addEventListener('click', async () => {
            const checked = Array.from(document.querySelectorAll("input[type=checkbox][data-gid]:checked"));
            if (!checked.length) { notify(`<div class='title'>提示</div>请先勾选要推送的本子！`); return; }

            let loginToast;
            try {
                loginToast = notify(`<div class='title'>正在登录 qBittorrent…</div>`);
                await loginQB();
                loginToast.close();
            } catch (e) {
                if (loginToast) loginToast.close();
                notify(`<div class='title'>登录失败</div>无法登录 qBittorrent，请检查设置。`, 6000);
                return;
            }

            const total = checked.length;
            const progressNotify = notify(`<div class='title'>开始推送</div>已推送：0/${total}` , 20000);

            const results = await Promise.all(checked.map(cb => {
                const gid = cb.dataset.gid;
                const title = cb.dataset.title;
                cb.checked = false;       // 视觉上取消勾选
                delete savedChecked[gid]; // 内存中删除记录
                return pushTorrentPromise(gid, title);
            }));
            // 将变更后的 savedChecked 保存回 localStorage
            localStorage.setItem(CHECK_KEY, JSON.stringify(savedChecked));

            // 记录 成功推送到qB的最大 GID 数值
            // 更新逻辑：记录上次值、更新最大值、记录时间、刷新UI
            const successItems = results.filter(r => r.ok);
            if (successItems.length > 0) {
                // 提取本次成功推送的所有 GID
                const currentBatchGids = successItems.map(r => parseInt(r.gid));
                const currentBatchMax = Math.max(...currentBatchGids);
                // 读取旧记录进行比对
                if (currentBatchMax > pushHistory.max.id) {
                    // 1. 将当前的"最大"归档为"上次"
                    pushHistory.prev.id = pushHistory.max.id;
                    pushHistory.prev.time = pushHistory.max.time;
                    // 2. 更新新的"最大" 和 "当前北京时间"
                    pushHistory.max.id = currentBatchMax;
                    pushHistory.max.time = getBjTime(); // 使用上面定义的辅助函数
                    // 3. 存储
                    localStorage.setItem(HISTORY_KEY, JSON.stringify(pushHistory));
                    // 同步更新旧key以防其他逻辑依赖
                    localStorage.setItem(OLD_KEY, currentBatchMax);
                    // 4. 实时刷新右下角显示
                    const infoEl = document.getElementById('nh-max-gid-display');
                    if(infoEl) infoEl.innerHTML = renderGidInfo(pushHistory);
                }
            }

            const successCount = results.filter(r => r.ok).length;
            const failed = results.filter(r => !r.ok);

            let failedHtml = '';
            if (failed.length) {
                failedHtml = '<div class="line"><strong>失败列表：</strong>' + failed.map(f => `<div class="error">${f.gid} - ${escapeHtml(f.title)}</div>`).join('') + '</div>';
            }

            progressNotify.close();
            notify(`<div class='title'>推送完成</div>成功：${successCount}/${total}` + failedHtml, 8000 + failed.length*2000);
        });
    }

    /**************************************************************************
     * 7. 设置模态框 (Settings UI)
     * 提供 GUI 界面配置 qBittorrent 地址、路径及账号
     **************************************************************************/
    function showSettingsModal() {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2147483646;';

        const modal = document.createElement('div');
        modal.style.cssText = 'background:#fff;padding:18px;border-radius:8px;min-width:320px;max-width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-size:14px;color:#111;';
        modal.innerHTML = `
            <h3 style='margin-top:0'>qBittorrent 配置</h3>
            <div style='margin-bottom:8px'><label>地址：</label><input id='nhq_addr' style='width:100%;padding:6px;margin-top:4px' value='${escapeHtml(QB_URL)}'></div>
            <div style='margin-bottom:8px'><label>下载根目录：</label><input id='nhq_path' style='width:100%;padding:6px;margin-top:4px' value='${escapeHtml(QB_PATH)}' placeholder='/downloads'></div>
            <div style='margin-bottom:8px'><label>用户名：</label><input id='nhq_user' style='width:100%;padding:6px;margin-top:4px' value='${escapeHtml(QB_USER)}'></div>
            <div style='margin-bottom:12px'><label>密码：</label><input id='nhq_pass' type='password' style='width:100%;padding:6px;margin-top:4px' value='${escapeHtml(QB_PASS)}'></div>
            <div style='text-align:right'><button id='nhq_save' class='btn btn-primary'>保存</button> <button id='nhq_test' class='btn btn-secondary'>测试连接</button> <button id='nhq_cancel' class='btn btn-secondary'>取消</button></div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        modal.querySelector('#nhq_cancel').addEventListener('click', () => overlay.remove());

        // 保存配置
        modal.querySelector('#nhq_save').addEventListener('click', () => {
            QB_URL = modal.querySelector('#nhq_addr').value.trim();
            QB_PATH = modal.querySelector('#nhq_path').value.trim();
            QB_USER = modal.querySelector('#nhq_user').value.trim();
            QB_PASS = modal.querySelector('#nhq_pass').value;
            localStorage.setItem('qb_url', QB_URL);
            localStorage.setItem('qb_path', QB_PATH);
            localStorage.setItem('qb_user', QB_USER);
            localStorage.setItem('qb_pass', QB_PASS);
            notify(`<div class='title'>配置已保存</div>`);
            overlay.remove();
        });

        // 测试配置连接性
        modal.querySelector('#nhq_test').addEventListener('click', async () => {
            QB_URL = modal.querySelector('#nhq_addr').value.trim();
            QB_USER = modal.querySelector('#nhq_user').value.trim();
            QB_PASS = modal.querySelector('#nhq_pass').value;
            const t = notify(`<div class='title'>正在测试连接…</div>`);
            try {
                await loginQB();
                t.close();
                notify(`<div class='title'>连接成功</div>`);
            }
            catch(e) {
                t.close();
                notify(`<div class='title'>连接失败</div>无法登陆 qBittorrent，请检查地址/用户名/密码`, 6000);
            }
        });
    }

    /**************************************************************************
     * 7.1 全局界面定制 (UI Customization)
     * 新增 Chinese 按钮 & 禁用搜索历史
     **************************************************************************/
    function customizeUI() {
        // 需求: 禁用搜索栏历史记录 (autocomplete="off")
        const searchInput = document.querySelector('input[name="q"]');
        if (searchInput) {
            searchInput.setAttribute('autocomplete', 'off');
        }

        // 需求: 在 Random 左侧新增 Chinese 按钮
        // 使用 querySelectorAll 同时选中顶部导航栏和移动端下拉菜单中的 Random 链接
        const randomLinks = document.querySelectorAll('a[href="/random/"]');

        randomLinks.forEach(link => {
            const currentLi = link.closest('li'); // 获取包裹链接的 li 元素
            if (!currentLi) return;

            const parentUl = currentLi.parentNode;

            // 创建新的 li 元素
            const newLi = document.createElement('li');
            // 复制原有 li 的 class (例如 "desktop") 以保持样式一致
            newLi.className = currentLi.className;
            newLi.innerHTML = '<a href="/search/?q=chinese">Chinese</a>';

            // 插入到 Random (currentLi) 的前面
            parentUl.insertBefore(newLi, currentLi);
        });
    }

    /**************************************************************************
     * 8. 程序初始化 (Initialization)
     * 根据当前 URL 路径判断挂载哪种功能按钮
     **************************************************************************/

    // 执行7.1板块的界面定制
    customizeUI();

    if (location.pathname.startsWith('/g/')) {
        addSinglePageButton(); // 详情页
    } else {
        addBatchFeature(); // 列表页
    }

    // 在所有页面注入全局浮动设置按钮（作为兜底）
    if (!document.getElementById('nhqb_settings')) {
        const fix = document.createElement('div');
        fix.className = 'nh-qb-fixed-btn';
        fix.innerHTML = `<button id='nhqb_settings2' class='btn btn-primary' style='position:fixed;bottom:20px;right:10px;z-index:99999'>设置</button>`;
        document.body.appendChild(fix);
        document.getElementById('nhqb_settings2').addEventListener('click', showSettingsModal);
    }

})();