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
        view: 'tasks',
        connected: false
    };

    const VIEW_META = {
        tasks: ['下载队列', '后台自动排队下载 · 完整性校验 · 超时重传 · 多 CDN 轮询'],
        settings: ['下载设置', '间隔、并发、超时重传、WebP 转换与源站适配'],
        keys: ['API 密钥', '生成 / 吊销访问密钥，防止公网骚扰'],
        logs: ['运行日志', '服务实时运行状态'],
        about: ['使用说明', '快速上手与 API 示例']
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function toast(msg, type = '') {
        const wrap = $('#toast-wrap');
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.innerHTML = msg;
        wrap.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3200);
    }

    async function api(path, options = {}) {
        const res = await fetch(path, {
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

    /* ---------- 鉴权门 ---------- */
    function showGate() {
        $('#gate').classList.remove('hidden');
        $('#app').classList.add('hidden');
    }

    function showApp() {
        $('#gate').classList.add('hidden');
        $('#app').classList.remove('hidden');
    }

    async function tryEnter(key) {
        state.apiKey = key.trim();
        try {
            const s = await api('/api/stats');
            localStorage.setItem('nhServerKey', state.apiKey);
            state.connected = true;
            $('#gate-error').textContent = '';
            showApp();
            $('#ver-text').textContent = s.version || '1.0.0';
            refreshAll();
        } catch (e) {
            $('#gate-error').textContent = e.auth ? 'API Key 无效，请检查后重试' : ('连接失败：' + e.message);
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
        $('#stat-chips').innerHTML = `
            <div class="chip run">下载中 <b>${c.downloading || 0}</b></div>
            <div class="chip">排队 <b>${c.queued || 0}</b></div>
            <div class="chip ok">完成 <b>${c.completed || 0}</b></div>
            <div class="chip warn">部分失败 <b>${c.completed_with_errors || 0}</b></div>
            <div class="chip err">失败 <b>${c.failed || 0}</b></div>
        `;
        state.paused = !!s.paused;
        $('#btn-pause').textContent = s.paused ? '▶ 继续队列' : '⏸ 暂停队列';
    }

    function renderTasks() {
        const list = $('#task-list');
        const order = { downloading: 0, queued: 1 };
        const tasks = state.tasks
            .filter(t => !state.filter || t.status === state.filter)
            .sort((a, b) => {
                const oa = order[a.status] === undefined ? 2 : order[a.status];
                const ob = order[b.status] === undefined ? 2 : order[b.status];
                if (oa !== ob) return oa - ob;
                return String(b.createdAt).localeCompare(String(a.createdAt));
            });

        $('#tasks-summary').textContent = `共 ${state.tasks.length} 个任务`;
        if (tasks.length === 0) {
            list.innerHTML = `<div class="empty">暂无任务<br><span class="small">在 nHentai 页面勾选本子后点「📤 推送到下载服务」，任务会自动排队下载</span></div>`;
            return;
        }

        list.innerHTML = tasks.map(t => {
            const total = t.total || (t.pages ? t.pages.length : 0) || 0;
            const done = t.done || 0;
            const pct = total > 0 ? Math.round((done / total) * 100) : (t.status === 'completed' ? 100 : 0);
            const barClass = t.status === 'completed' ? 'ok' : (t.status === 'failed' || t.status === 'completed_with_errors' ? 'err' : '');
            const actions = [];
            if (t.status === 'queued' || t.status === 'downloading') actions.push(`<button class="btn small danger" data-act="cancel" data-id="${t.id}">取消</button>`);
            if (['failed', 'cancelled', 'completed_with_errors'].includes(t.status)) actions.push(`<button class="btn small" data-act="retry" data-id="${t.id}">重试</button>`);
            if (t.status !== 'downloading') actions.push(`<button class="btn small ghost" data-act="remove" data-id="${t.id}">删除</button>`);

            return `
            <div class="task" data-id="${t.id}">
                <div class="task-head">
                    <div style="min-width:0">
                        <div class="task-title">${esc(t.title)}</div>
                        <div class="task-meta">
                            <span>GID: <code>${esc(t.gid)}</code></span>
                            <span>目录: <code>${esc(t.folder)}</code></span>
                            ${t.downloadedBytes ? `<span>已下载 ${formatBytes(t.downloadedBytes)}</span>` : ''}
                            ${t.convertedToWebp ? '<span>WebP ✓</span>' : ''}
                            ${t.zipFile ? `<span>📦 ZIP ✓${t.zipBytes ? ' ' + formatBytes(t.zipBytes) : ''}</span>` : ''}
                            ${t.startedAt ? `<span>开始 ${esc(String(t.startedAt).replace('T', ' ').slice(0, 19))}</span>` : ''}
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
        'metaUrlTemplate', 'userAgent'];

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
            $('#set-preferCoverHost').checked = !!s.preferCoverHost;
            $('#set-cdnBaseUrls').value = (s.cdnBaseUrls || []).join('\n');
            $('#sharp-status').textContent = d.sharpAvailable
                ? '✓ sharp 已安装：WebP 转换可用（gif → 动态 webp）'
                : '⚠ 未检测到 sharp，转换已自动禁用并保留原格式（npm install sharp 可启用）';
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
                    <td>${esc(String(k.createdAt).replace('T', ' ').slice(0, 19))}</td>
                    <td>${k.lastUsedAt ? esc(String(k.lastUsedAt).replace('T', ' ').slice(0, 19)) : '从未使用'}</td>
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
                    line.innerHTML = `<span class="log-ts">${esc(l.ts.slice(11, 19))}</span>` +
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

    /* ---------- 事件绑定与启动 ---------- */
    function bind() {
        $('#gate-submit').addEventListener('click', () => tryEnter($('#gate-key').value));
        $('#gate-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryEnter($('#gate-key').value); });

        $('#btn-logout').addEventListener('click', () => {
            localStorage.removeItem('nhServerKey');
            state.apiKey = '';
            $('#gate-key').value = '';
            showGate();
        });

        $$('.nav-item').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

        $('#task-filters').addEventListener('click', (e) => {
            const btn = e.target.closest('.chip-btn');
            if (!btn) return;
            state.filter = btn.dataset.filter;
            $$('#task-filters .chip-btn').forEach(b => b.classList.toggle('active', b === btn));
            renderTasks();
        });

        $('#task-list').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (btn) taskAction(btn.dataset.act, btn.dataset.id);
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
        $('#btn-create-key').addEventListener('click', createKey);
        $('#btn-copy-new-key').addEventListener('click', () => {
            navigator.clipboard.writeText($('#key-new-value').textContent)
                .then(() => toast('已复制到剪贴板', 'ok'))
                .catch(() => toast('复制失败，请手动选择复制', 'err'));
        });

        $('#key-table').addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-key-revoke]');
            if (!btn) return;
            if (!confirm('确定吊销此密钥？使用该密钥的客户端将立即失去访问权限。')) return;
            try {
                await api('/api/keys/' + btn.dataset.keyRevoke, { method: 'DELETE' });
                toast('密钥已吊销', 'ok');
                loadKeys();
            } catch (err) { toast('吊销失败：' + esc(err.message), 'err'); }
        });

        setInterval(refreshAll, 2000);
    }

    bind();
    if (state.apiKey) tryEnter(state.apiKey);
    else showGate();
})();
