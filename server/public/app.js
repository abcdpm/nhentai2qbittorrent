/* nHentai 下载服务 —— 前端逻辑（零依赖） */
(function () {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    const state = {
        apiKey: localStorage.getItem('nhServerKey') || '',
        settings: null,
        tasks: [],
        counts: {},
        paused: false,
        logSeq: 0,
        filter: '',
        page: 1,
        history: [],
        view: 'tasks',
        connected: false
    };

    const VIEW_META = {
        tasks: ['下载队列', '后台自动排队下载 · 完整性校验 · 超时重传 · 多 CDN 轮询'],
        history: ['历史下载记录', '所有历史下载 gid 数据 · 支持本地 JSON 备份 / 导入'],
        settings: ['下载设置', '间隔、并发、超时重传、WebP 转换与源站适配'],
        keys: ['API 密钥', '生成 / 吊销访问密钥，防止公网骚扰'],
        logs: ['运行日志', '服务实时运行状态'],
        about: ['使用说明', '快速上手与 API 示例']
    };

    const FILTER_LABELS = {
        '': '全部', queued: '排队中', downloading: '下载中', completed: '已完成',
        completed_with_errors: '部分失败', failed: '失败', cancelled: '已取消'
    };
    const PAGE_SIZE = 20;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /** ISO 时间 → 浏览器本地时间（"2026/10/17 19:49:19" 格式，统一按本地时区显示，不再显示 UTC） */
    function fmtLocalTime(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
    }

    /* ---------- 页面内确认弹窗（替代浏览器原生 confirm）---------- */
    function showConfirm({ title = '确认操作', message = '', okText = '确定', danger = true, icon = '🗑️' } = {}) {
        return new Promise((resolve) => {
            const mask = $('#confirm-mask');
            $('#confirm-title').textContent = title;
            $('#confirm-message').innerHTML = message;
            $('#confirm-icon').textContent = icon;
            const okBtn = $('#confirm-ok');
            okBtn.textContent = okText;
            okBtn.className = 'btn ' + (danger ? 'danger' : 'primary');
            mask.classList.remove('hidden');

            const onKey = (e) => {
                if (e.key === 'Escape') done(false);
                else if (e.key === 'Enter') done(true);
            };
            const done = (v) => {
                mask.classList.add('hidden');
                document.removeEventListener('keydown', onKey);
                resolve(v);
            };
            document.addEventListener('keydown', onKey);
            $('#confirm-cancel').onclick = () => done(false);
            okBtn.onclick = () => done(true);
            mask.onclick = (e) => { if (e.target === mask) done(false); };
            okBtn.focus();
        });
    }

    function toast(msg, type = '') {
        const wrap = $('#toast-wrap');
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.innerHTML = msg;
        wrap.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3200);
    }

    // API 基址：兼容根路径与子路径部署（如 https://paccu.cn/nhentai/）
    const API_BASE = (() => {
        const p = location.pathname.replace(/[^/]*$/, '');
        return p.endsWith('/') ? p : p + '/';
    })();

    async function api(path, options = {}) {
        const res = await fetch(API_BASE + String(path).replace(/^\/+/, ''), {
            method: options.method || 'GET',
            headers: Object.assign({ 'X-API-Key': state.apiKey }, options.body ? { 'Content-Type': 'application/json' } : {}),
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        let data = {};
        try { data = await res.json(); } catch (e) { /* 非 JSON */ }
        if (res.status === 401) throw Object.assign(new Error(data.error || '密钥无效'), { auth: true });
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
    }

    /* ---------- 登录门（SSO 主入口 / 账号密码备用）---------- */
    function showGate() {
        $('#gate').classList.remove('hidden');
        $('#app').classList.add('hidden');
    }

    function showApp() {
        $('#gate').classList.add('hidden');
        $('#app').classList.remove('hidden');
    }

    function forceLocalLogin() {
        return /(^|[?&])login=local(&|$)/.test(location.search);
    }

    /** 登录门初始化：OIDC 启用后自动隐藏账号密码入口（备用登录入口不在页面暴露），打开首页自动跳转 SSO */
    async function initGate(autoSso = true) {
        let oidc = false;
        try {
            const cfg = await api('/api/auth/config');
            oidc = !!cfg.oidc;
        } catch (e) { /* 拉取失败按备用登录显示 */ }
        const forceLocal = forceLocalLogin();
        $('#gate-sso').classList.toggle('hidden', !oidc);
        $('#gate-local-wrap').classList.toggle('hidden', oidc && !forceLocal);
        $('#gate-sub').textContent = oidc ? '使用单点登录（SSO）进入控制台' : '使用账号密码登录以进入控制台';
        $('#gate-help').innerHTML = oidc
            ? (forceLocal
                ? '正在使用备用登录（账号密码）。首次使用？密码在服务启动日志或 <code>server/data/INITIAL_PASSWORD.txt</code>'
                : '已启用 SSO 单点登录；账号密码为备用登录（入口不在页面展示，仅供管理员在 SSO 不可用时使用）')
            : '首次使用？账号密码在服务启动日志中打印，或查看 <code>server/data/INITIAL_PASSWORD.txt</code>；API / 油猴脚本调用仍使用 <code>X-API-Key</code>';
        const err = new URLSearchParams(location.search).get('error');
        if (err) $('#gate-error').textContent = err;
        // 打开首页自动跳转 SSO（备用登录仅通过隐藏入口进入，页面不展示）
        if (oidc && !forceLocal && autoSso) {
            $('#gate-sub').textContent = '正在跳转 SSO 单点登录…';
            window.location.href = API_BASE + 'auth/oidc/login';
        }
    }

    async function loginWithPassword() {
        const username = $('#gate-user').value.trim();
        const password = $('#gate-pass').value;
        if (!username || !password) { $('#gate-error').textContent = '请输入用户名和密码'; return; }
        try {
            await api('/api/auth/login', { method: 'POST', body: { username, password } });
            $('#gate-error').textContent = '';
            $('#gate-pass').value = '';
            await enterApp();
        } catch (e) {
            $('#gate-error').textContent = e.auth ? '用户名或密码错误' : ('登录失败：' + e.message);
        }
    }

    async function enterApp() {
        try {
            const s = await api('/api/stats');
            state.connected = true;
            showApp();
            $('#ver-text').textContent = s.version || '1.0.0';
            refreshAll();
        } catch (e) {
            if (e.auth) { await initGate(); showGate(); return; }
            $('#gate-error').textContent = '连接失败：' + e.message;
            showGate();
        }
    }

    /* ---------- 视图切换 ---------- */
    function switchView(view) {
        state.view = view;
        $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
        $$('.view').forEach(v => v.classList.add('hidden'));
        const el = $('#view-' + view);
        if (el) el.classList.remove('hidden');
        $('#view-title').textContent = VIEW_META[view][0];
        $('#view-sub').textContent = VIEW_META[view][1];
        if (view === 'settings') loadSettings();
        if (view === 'history') loadHistory();
        if (view === 'keys') loadKeys();
        if (view === 'logs') { state.logSeq = 0; $('#log-list').innerHTML = ''; loadLogs(); }
    }

    /* ---------- 统计与任务渲染 ---------- */
    const STATUS_TEXT = {
        queued: '排队中', downloading: '下载中', completed: '已完成',
        completed_with_errors: '部分失败', failed: '失败', cancelled: '已取消'
    };

    function renderChips(s) {
        const c = s.counts || {};
        // 统计数字直接显示在各过滤按钮右侧（按类别着色）
        $$('#task-filters .chip-btn').forEach(b => {
            const key = b.dataset.filter || 'total';
            const n = c[key] || 0;
            const cls = key === 'total' ? 'all' : key;
            b.innerHTML = `${FILTER_LABELS[b.dataset.filter] || ''} <span class="chip-count c-${cls}${n ? '' : ' zero'}">${n}</span>`;
        });
        state.paused = !!s.paused;
        $('#btn-pause').textContent = s.paused ? '▶ 继续队列' : '⏸ 暂停队列';
    }

    function renderTasks() {
        const list = $('#task-list');
        const order = { downloading: 0, queued: 1 };
        const filtered = state.tasks
            .filter(t => !state.filter || t.status === state.filter)
            .sort((a, b) => {
                const oa = order[a.status] === undefined ? 2 : order[a.status];
                const ob = order[b.status] === undefined ? 2 : order[b.status];
                if (oa !== ob) return oa - ob;
                return String(b.createdAt).localeCompare(String(a.createdAt));
            });

        $('#tasks-summary').textContent = `共 ${state.tasks.length} 个任务`;

        // 分页
        const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        if (state.page > totalPages) state.page = totalPages;
        if (state.page < 1) state.page = 1;
        const slice = filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

        if (filtered.length === 0) {
            list.innerHTML = `<div class="empty">暂无任务<br><span class="small">在 nHentai 页面勾选本子后点「推送到下载服务」，任务会自动排队下载</span></div>`;
            renderPager(1, 1, 0);
            return;
        }

        list.innerHTML = slice.map(t => {
            const total = t.total || (t.pages ? t.pages.length : 0) || 0;
            const done = t.done || 0;
            const pct = total > 0 ? Math.round((done / total) * 100) : (t.status === 'completed' ? 100 : 0);
            const barClass = t.status === 'completed' ? 'ok' : (t.status === 'failed' || t.status === 'completed_with_errors' ? 'err' : '');
            const actions = [];
            if (t.status === 'queued' || t.status === 'downloading') actions.push(`<button class="btn small danger" data-act="cancel" data-id="${t.id}">取消</button>`);
            if (['failed', 'cancelled', 'completed_with_errors'].includes(t.status)) {
                // 快速跳转到该本的 nHentai 页面（元数据类失败的推荐恢复路径：打开页面由脚本自动补挂 meta/重新推送）
                const isMetaErr = /元数据/.test(String(t.error || ''));
                actions.push(`<button class="btn small ghost" data-act="open" data-gid="${esc(t.gid)}">${isMetaErr ? '🌐 去 nHentai 补元数据' : '🌐 nHentai 页面'}</button>`);
                actions.push(`<button class="btn small" data-act="retry" data-id="${t.id}">重试</button>`);
            }
            if (t.status !== 'downloading') actions.push(`<button class="btn small ghost" data-act="remove" data-id="${t.id}">删除</button>`);

            return `
            <div class="task" data-id="${t.id}">
                <div class="task-head">
                    <div style="min-width:0">
                        <div class="task-title">${esc(t.title)}</div>
                        <div class="task-meta">
                            <span>GID: <a class="gid-link" href="https://nhentai.net/g/${esc(t.gid)}/" target="_blank" rel="noopener" title="打开 nHentai 页面"><code>${esc(t.gid)}</code> ↗</a></span>
                            <span>目录: <code>${esc(t.folder)}</code></span>
                            ${t.downloadedBytes ? `<span>已下载 ${formatBytes(t.downloadedBytes)}</span>` : ''}
                            ${t.convertedToWebp ? '<span>WebP ✓</span>' : ''}
                            ${t.zipFile ? `<span>📦 ZIP ✓${t.zipBytes ? ' ' + formatBytes(t.zipBytes) : ''}${t.zipDeletedAfterLrr ? '（已上传 LRR，本地已删除）' : ''}</span>` : ''}
                            ${t.startedAt ? `<span>开始 ${esc(fmtLocalTime(t.startedAt))}</span>` : ''}
                        </div>
                    </div>
                    <div class="task-actions">
                        <span class="badge ${t.status}">${STATUS_TEXT[t.status] || t.status}</span>
                        ${actions.join('')}
                    </div>
                </div>
                <div class="progress"><div class="progress-bar ${barClass}" style="width:${pct}%"></div></div>
                <div class="task-foot">
                    <span>${done}${total ? ' / ' + total : ''} 页${t.failed ? ` · 失败 ${t.failed}` : ''}</span>
                    <span>${pct}%${t.error ? ` · <span class="task-error">${esc(t.error)}</span>` : ''}</span>
                </div>
            </div>`;
        }).join('');
        renderPager(state.page, totalPages, filtered.length);
    }

    function renderPager(page, totalPages, total) {
        const el = $('#task-pager');
        if (totalPages <= 1) {
            el.innerHTML = total ? `<span class="muted small">共 ${total} 条</span>` : '';
            return;
        }
        el.innerHTML = `
            <button class="btn small" data-page="prev" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
            <span class="muted small">第 ${page} / ${totalPages} 页 · 共 ${total} 条</span>
            <button class="btn small" data-page="next" ${page >= totalPages ? 'disabled' : ''}>下一页 ›</button>
        `;
    }

    function formatBytes(n) {
        if (!n) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0, v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
    }

    async function refreshAll() {
        try {
            const [s, t] = await Promise.all([api('/api/stats'), api('/api/tasks')]);
            state.connected = true;
            $('#conn-status').classList.remove('off');
            $('#conn-text').textContent = '已连接';
            renderChips(s);
            state.tasks = t.tasks || [];
            state.counts = t.counts || {};
            renderTasks();
            if (state.view === 'logs') loadLogs();
        } catch (e) {
            if (e.auth) { showGate(); return; }
            state.connected = false;
            $('#conn-status').classList.add('off');
            $('#conn-text').textContent = '连接失败';
        }
    }

    async function taskAction(act, id) {
        try {
            if (act === 'cancel') await api('/api/tasks/' + id + '/cancel', { method: 'POST' });
            else if (act === 'retry') await api('/api/tasks/' + id + '/retry', { method: 'POST' });
            else if (act === 'remove') await api('/api/tasks/' + id, { method: 'DELETE' });
            toast('操作成功', 'ok');
            refreshAll();
        } catch (e) {
            toast('操作失败：' + esc(e.message), 'err');
        }
    }

    /* ---------- 设置 ---------- */
    const SETTINGS_FIELDS = ['downloadDir', 'requestIntervalMs', 'galleryIntervalMs', 'pageConcurrency',
        'timeoutMs', 'maxAttempts', 'retryDelayMs', 'repairRounds', 'webpQuality',
        'metaUrlTemplate', 'apiUrlTemplate', 'nhCookie', 'userAgent', 'lrrUrl', 'lrrApiKey', 'lrrCategory',
        'oidcIssuer', 'oidcClientId', 'oidcClientSecret', 'oidcScopes', 'oidcRedirectUri', 'sessionTtlDays'];

    async function loadSettings() {
        try {
            const d = await api('/api/settings');
            const s = d.settings;
            state.settings = s;
            for (const f of SETTINGS_FIELDS) {
                const el = $('#set-' + f);
                if (el) el.value = s[f];
            }
            $('#set-convertToWebp').checked = !!s.convertToWebp;
            $('#set-keepOriginal').checked = !!s.keepOriginal;
            $('#set-zipAfterVerify').checked = !!s.zipAfterVerify;
            $('#set-keepFolderAfterZip').checked = !!s.keepFolderAfterZip;
            $('#set-lrrDeleteZipAfterUpload').checked = !!s.lrrDeleteZipAfterUpload;
            $('#set-preferCoverHost').checked = !!s.preferCoverHost;
            $('#set-cdnBaseUrls').value = (s.cdnBaseUrls || []).join('\n');
            $('#sharp-status').textContent = d.sharpAvailable
                ? '✓ sharp 已安装：WebP 转换可用（gif → 动态 webp）'
                : '⚠ 未检测到 sharp，转换已自动禁用并保留原格式（npm install sharp 可启用）';
            testCdn();   // 打开设置自动测速各 CDN 节点延迟
        } catch (e) {
            toast('加载设置失败：' + esc(e.message), 'err');
        }
    }

    async function saveSettings() {
        const patch = {};
        for (const f of SETTINGS_FIELDS) {
            const el = $('#set-' + f);
            if (el) patch[f] = el.type === 'number' ? Number(el.value) : el.value;
        }
        patch.convertToWebp = $('#set-convertToWebp').checked;
        patch.keepOriginal = $('#set-keepOriginal').checked;
        patch.zipAfterVerify = $('#set-zipAfterVerify').checked;
        patch.keepFolderAfterZip = $('#set-keepFolderAfterZip').checked;
        patch.lrrDeleteZipAfterUpload = $('#set-lrrDeleteZipAfterUpload').checked;
        patch.preferCoverHost = $('#set-preferCoverHost').checked;
        patch.cdnBaseUrls = $('#set-cdnBaseUrls').value.split('\n').map(v => v.trim()).filter(Boolean);
        try {
            await api('/api/settings', { method: 'PUT', body: { settings: patch } });
            $('#settings-msg').textContent = '✓ 已保存 ' + new Date().toLocaleTimeString();
            toast('设置已保存', 'ok');
        } catch (e) {
            toast('保存失败：' + esc(e.message), 'err');
        }
    }

    /* ---------- API 密钥 ---------- */
    async function loadKeys() {
        try {
            const d = await api('/api/keys');
            const tbody = $('#key-table tbody');
            tbody.innerHTML = (d.keys || []).map(k => `
                <tr>
                    <td>${esc(k.name)}</td>
                    <td><code>${esc(k.prefix)}…</code></td>
                    <td>${esc(fmtLocalTime(k.createdAt))}</td>
                    <td>${k.lastUsedAt ? esc(fmtLocalTime(k.lastUsedAt)) : '从未使用'}</td>
                    <td style="text-align:right"><button class="btn small danger" data-key-revoke="${k.id}">吊销</button></td>
                </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无密钥</td></tr>';
        } catch (e) {
            toast('加载密钥失败：' + esc(e.message), 'err');
        }
    }

    async function createKey() {
        const name = $('#key-name').value.trim() || '新密钥';
        try {
            const d = await api('/api/keys', { method: 'POST', body: { name } });
            $('#key-new').classList.remove('hidden');
            $('#key-new-value').textContent = d.rawKey;
            $('#key-name').value = '';
            toast('密钥已生成，请立即复制', 'ok');
            loadKeys();
        } catch (e) {
            toast('生成失败：' + esc(e.message), 'err');
        }
    }

    /* ---------- 日志 ---------- */
    async function loadLogs() {
        try {
            const d = await api('/api/logs?since=' + state.logSeq);
            if (d.logs && d.logs.length) {
                const box = $('#log-list');
                for (const l of d.logs) {
                    const line = document.createElement('div');
                    line.className = 'log-line';
                    line.innerHTML = `<span class="log-ts">${esc((fmtLocalTime(l.ts).split(' ').pop()) || l.ts.slice(11, 19))}</span>` +
                        `<span class="log-level ${esc(l.level)}">${esc(l.level.toUpperCase())}</span>` +
                        `<span class="log-msg">${esc(l.msg)}</span>`;
                    box.appendChild(line);
                }
                state.logSeq = d.latest;
                if (box.children.length > 800) box.innerHTML = '';
                if ($('#log-follow').checked) box.scrollTop = box.scrollHeight;
            }
        } catch (e) { /* 日志轮询失败静默 */ }
    }

    /* ---------- 历史下载记录 ---------- */
    async function loadHistory() {
        try {
            const d = await api('/api/history');
            state.history = (d.gids || []).map(String);
            renderHistory();
        } catch (e) {
            toast('加载历史记录失败：' + esc(e.message), 'err');
        }
    }

    function renderHistory() {
        const all = (state.history || []).map(String);
        const q = ($('#history-search').value || '').trim();
        const rows = all.filter(g => !q || g.includes(q));
        $('#history-summary').textContent = `共 ${all.length} 条历史记录${q ? `，搜索命中 ${rows.length} 条` : ''}`;
        const box = $('#history-list');
        if (!rows.length) {
            box.innerHTML = '<div class="muted">暂无记录</div>';
            return;
        }
        const shown = rows.slice(0, 500);
        box.innerHTML = shown.map(g =>
            `<a href="https://nhentai.net/g/${esc(g)}/" target="_blank" title="在 nHentai 打开 ${esc(g)}">${esc(g)}</a>`
        ).join('') + (rows.length > 500 ? '<div class="muted small">… 仅显示前 500 条，请用搜索过滤</div>' : '');
    }

    async function exportHistory() {
        try {
            const res = await fetch(API_BASE + 'api/history/export', { headers: { 'X-API-Key': state.apiKey } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `nh_downloaded_history_${fmtLocalTime(new Date()).slice(0, 10).replace(/[\/\s]/g, '')}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            toast('历史记录已备份到本地（与前端备份同格式）', 'ok');
        } catch (e) {
            toast('备份失败：' + esc(e.message), 'err');
        }
    }

    async function importHistory(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const gids = Array.isArray(data) ? data : (Array.isArray(data.gids) ? data.gids : null);
            if (!gids) throw new Error('文件格式不正确（需要 ["gid",...] 数组）');
            const d = await api('/api/history/import', { method: 'POST', body: { gids } });
            toast(`导入成功：新增 ${d.added} 条，当前共 ${d.total} 条`, 'ok');
            loadHistory();
        } catch (e) {
            toast('导入失败：' + esc(e.message), 'err');
        }
    }

    /* ---------- CDN 节点测速 ---------- */
    async function testCdn() {
        const status = $('#cdn-test-status');
        const urls = $('#set-cdnBaseUrls').value.split('\n').map(v => v.trim()).filter(Boolean);
        if (!urls.length) {
            $('#cdn-latency-table tbody').innerHTML = '';
            status.textContent = '未配置 CDN 节点';
            return;
        }
        status.textContent = '📡 测速中…';
        try {
            const d = await api('/api/cdn/test', { method: 'POST', body: { urls } });
            const rows = d.results || [];
            rows.sort((a, b) => (a.latencyMs == null ? 1e9 : a.latencyMs) - (b.latencyMs == null ? 1e9 : b.latencyMs));
            $('#cdn-latency-table tbody').innerHTML = rows.map(r => {
                const lat = r.ok ? r.latencyMs : null;
                const cls = lat == null ? 'lat-bad' : (lat < 200 ? 'lat-good' : (lat < 500 ? 'lat-mid' : 'lat-bad'));
                return `<tr>
                    <td><code>${esc(r.url)}</code></td>
                    <td class="${cls}"><b>${lat == null ? '—' : lat + ' ms'}</b></td>
                    <td class="${r.ok ? 'lat-good' : 'lat-bad'}">${r.ok ? '正常' : esc(r.error || '失败')}</td>
                </tr>`;
            }).join('');
            status.textContent = `测速完成（快→慢排序）· ${new Date().toLocaleTimeString()}`;
        } catch (e) {
            status.textContent = '测速失败：' + esc(e.message);
        }
    }

    /* ---------- 事件绑定与启动 ---------- */
    function bind() {
        $('#gate-submit').addEventListener('click', loginWithPassword);
        $('#gate-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginWithPassword(); });
        $('#gate-sso').addEventListener('click', () => { window.location.href = API_BASE + 'auth/oidc/login'; });

        $('#btn-logout').addEventListener('click', async () => {
            try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
            localStorage.removeItem('nhServerKey');
            state.apiKey = '';
            $('#gate-user').value = '';
            $('#gate-pass').value = '';
            $('#gate-error').textContent = '';
            await initGate(false);   // 主动退出：显示登录门与 SSO 按钮但不自动跳转（否则静默 SSO 会立刻登回）
            showGate();
        });

        $('#btn-change-pw').addEventListener('click', async () => {
            const st = $('#pw-status');
            const currentPassword = $('#pw-current').value;
            const newPassword = $('#pw-new').value;
            if (!currentPassword || !newPassword) { st.textContent = '✗ 请填写当前密码与新密码'; return; }
            st.textContent = '🔐 提交中…';
            try {
                await api('/api/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
                st.textContent = '✓ 密码已修改';
                $('#pw-current').value = '';
                $('#pw-new').value = '';
            } catch (e) {
                st.textContent = '✗ ' + esc(e.message);
            }
        });

        $$('.nav-item').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

        $('#task-filters').addEventListener('click', (e) => {
            const btn = e.target.closest('.chip-btn');
            if (!btn) return;
            state.filter = btn.dataset.filter;
            state.page = 1;
            $$('#task-filters .chip-btn').forEach(b => b.classList.toggle('active', b === btn));
            renderTasks();
        });

        $('#task-pager').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-page]');
            if (!btn || btn.disabled) return;
            state.page += btn.dataset.page === 'next' ? 1 : -1;
            renderTasks();
        });

        $('#btn-clear-done').addEventListener('click', async () => {
            const done = (state.counts && state.counts.completed) || 0;
            if (!done) { toast('没有已下载的任务记录'); return; }
            const ok = await showConfirm({
                title: '清空已下载',
                icon: '🗑️',
                okText: '清空',
                message: `确定清空 <b>${done}</b> 条已下载任务记录？<br><span class="muted small">磁盘上的 zip / 文件不会被删除</span>`
            });
            if (!ok) return;
            try {
                const d = await api('/api/queue/clear-completed', { method: 'POST' });
                toast(`已清空 ${d.removed} 条已下载记录`, 'ok');
                refreshAll();
            } catch (e) { toast('操作失败：' + esc(e.message), 'err'); }
        });

        $('#task-list').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            if (btn.dataset.act === 'open') {
                const gid = String(btn.dataset.gid || '').replace(/\D/g, '');
                if (gid) window.open(`https://nhentai.net/g/${gid}/`, '_blank', 'noopener');
                return;
            }
            taskAction(btn.dataset.act, btn.dataset.id);
        });

        $('#btn-pause').addEventListener('click', async () => {
            try {
                await api('/api/queue/' + (state.paused ? 'resume' : 'pause'), { method: 'POST' });
                toast(state.paused ? '队列已继续' : '队列已暂停', 'ok');
                refreshAll();
            } catch (e) { toast('操作失败：' + esc(e.message), 'err'); }
        });

        $('#btn-retry-failed').addEventListener('click', async () => {
            try {
                const d = await api('/api/queue/retry-failed', { method: 'POST' });
                toast(`已重新排队 ${d.count} 个失败任务`, 'ok');
                refreshAll();
            } catch (e) { toast('操作失败：' + esc(e.message), 'err'); }
        });

        $('#btn-save-settings').addEventListener('click', saveSettings);
        $('#btn-cdn-test').addEventListener('click', testCdn);
        $('#btn-lrr-test').addEventListener('click', async () => {
            const st = $('#lrr-test-status');
            st.textContent = '🔌 测试中…';
            try {
                const d = await api('/api/lrr/test', {
                    method: 'POST',
                    body: {
                        lrrUrl: $('#set-lrrUrl').value.trim(),
                        lrrApiKey: $('#set-lrrApiKey').value.trim(),
                        lrrCategory: $('#set-lrrCategory').value.trim()
                    }
                });
                st.textContent = d.ok ? `✓ 连接成功（LANraragi 现有 ${d.count} 个本子）` : `✗ ${esc(d.error || '连接失败')}`;
            } catch (e) {
                st.textContent = '✗ ' + esc(e.message);
            }
        });
        $('#btn-create-key').addEventListener('click', createKey);

        // 历史下载记录
        $('#history-search').addEventListener('input', renderHistory);
        $('#btn-history-export').addEventListener('click', exportHistory);
        $('#btn-history-import').addEventListener('click', () => $('#history-import-input').click());
        $('#history-import-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) importHistory(file);
            e.target.value = '';
        });
        $('#btn-copy-new-key').addEventListener('click', () => {
            navigator.clipboard.writeText($('#key-new-value').textContent)
                .then(() => toast('已复制到剪贴板', 'ok'))
                .catch(() => toast('复制失败，请手动选择复制', 'err'));
        });

        $('#key-table').addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-key-revoke]');
            if (!btn) return;
            const ok = await showConfirm({
                title: '吊销 API 密钥',
                icon: '🔑',
                okText: '吊销',
                message: '确定吊销此密钥？<br><span class="muted small">使用该密钥的客户端将立即失去访问权限</span>'
            });
            if (!ok) return;
            try {
                await api('/api/keys/' + btn.dataset.keyRevoke, { method: 'DELETE' });
                toast('密钥已吊销', 'ok');
                loadKeys();
            } catch (err) { toast('吊销失败：' + esc(err.message), 'err'); }
        });

        setInterval(refreshAll, 2000);
    }

    bind();
    (async () => {
        try {
            const me = await api('/api/auth/me');
            if (me && (me.user || me.keyName)) { await enterApp(); return; }
        } catch (e) { /* 未登录 */ }
        // 未登录才进登录门（OIDC 启用时自动跳转 SSO；已登录用户不会被带去 IdP）
        await initGate();
        showGate();
    })();
})();
