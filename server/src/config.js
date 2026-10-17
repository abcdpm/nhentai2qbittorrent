'use strict';
const path = require('path');
const { readJson, atomicWriteJson } = require('./util');

const DEFAULTS = {
    // 监听
    host: '127.0.0.1',
    port: 8787,
    // 保存目录（相对 server 目录或绝对路径），文件夹格式：本子名 [本子id]
    downloadDir: './downloads',
    // 限速与并发
    requestIntervalMs: 400,     // 每张图片请求的起始间隔（防 429）
    galleryIntervalMs: 2000,    // 每个本子任务之间的间隔
    pageConcurrency: 3,         // 单本内并发下载页数
    // 超时 / 重传 / 轮询
    timeoutMs: 30000,           // 单次请求超时
    maxAttempts: 4,             // 每页最大重试轮数（每轮内会把所有 CDN 轮询一遍）
    retryDelayMs: 1500,         // 重试退避基数（乘以轮次 + 抖动）
    repairRounds: 2,            // 下载完成后完整性校验的补齐轮数
    // 格式统一
    convertToWebp: true,        // 统一转 WebP（需要可选依赖 sharp）
    webpQuality: 82,
    keepOriginal: false,        // 转换成功后是否保留原图
    // 压缩（完整性校验通过后打包为 zip，可直接导入 LANraragi）
    zipAfterVerify: true,       // 校验通过后压缩为 "本子名 [id].zip"
    keepFolderAfterZip: false,  // 压缩后是否保留原图片文件夹
    // LANraragi 联动（压缩后自动上传）
    lrrUrl: '',                 // LANraragi 地址，如 http://127.0.0.1:3000；留空=禁用
    lrrApiKey: '',              // LANraragi 设置里的 API Key（自动 base64 后放入 Authorization）
    lrrCategory: '',            // 可选：上传到指定分类 ID
    // 源站适配（高级项，一般无需修改；测试/镜像时可覆盖）
    metaUrlTemplate: 'https://nhentai.net/g/{gid}/',
    apiUrlTemplate: '',         // 留空=不使用官方 API（限流严重，不推荐）；如需可填 https://nhentai.net/api/v2/galleries/{gid}
    nhApiKey: '',               // nhentai API Key（可选，仅 apiUrlTemplate 启用时使用）
    nhCookie: '',               // 浏览器 Cookie（油猴脚本会自动同步；HTML 源使用）
    preferCoverHost: true,      // 优先用封面所在 CDN 节点
    // 登录（Web 控制台）：OIDC 为主要登录入口，账号密码为备用登录
    oidcIssuer: '',             // OIDC Issuer 地址（如 https://accounts.example.com）；配置后登录页以 SSO 为主入口
    oidcClientId: '',           // OIDC Client ID（与 Issuer 同时配置即启用 SSO）
    oidcClientSecret: '',       // OIDC Client Secret（机密客户端需要；公共客户端 + PKCE 可留空）
    oidcScopes: 'openid profile email',
    oidcRedirectUri: '',        // 回调地址（留空=自动推导；子路径反代部署时可显式指定）
    sessionTtlDays: 30,         // 登录会话有效期（天）
    cdnBaseUrls: [
        'https://i.nhentai.net',
        'https://i1.nhentai.net',
        'https://i2.nhentai.net',
        'https://i3.nhentai.net',
        'https://i5.nhentai.net',
        'https://i7.nhentai.net'
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

/**
 * 环境变量覆盖（Docker / 12-factor）：NH_ + 配置项名全大写。
 * 例：NH_HOST、NH_PORT、NH_DOWNLOAD_DIR、NH_REQUEST_INTERVAL_MS、NH_CONVERT_TO_WEBP、
 *     NH_CDN_BASE_URLS（逗号分隔）。
 * 布尔接受 1/true/yes/on；数字非法时忽略。优先级：环境变量 > data/config.json > 内置默认值。
 */
function envOverrides() {
    const out = {};
    for (const [key, def] of Object.entries(DEFAULTS)) {
        // requestIntervalMs -> NH_REQUEST_INTERVAL_MS
        const envKey = 'NH_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
        const raw = process.env[envKey];
        if (raw === undefined || raw === '') continue;
        if (Array.isArray(def)) {
            out[key] = String(raw).split(',').map(s => s.trim()).filter(Boolean);
        } else if (typeof def === 'number') {
            const n = Number(raw);
            if (Number.isFinite(n)) out[key] = n;
        } else if (typeof def === 'boolean') {
            out[key] = ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
        } else {
            out[key] = String(raw);
        }
    }
    return out;
}

class Config {
    constructor(dataDir) {
        this.file = path.join(dataDir, 'config.json');
        this.data = Object.assign({}, DEFAULTS, readJson(this.file, {}), envOverrides());
        // 数据迁移：旧版本（< v5.5.0）曾把官方 API 模板当作默认值持久化进 config.json，
        // 新版本默认禁用官方 API（限流严重），但持久化值会盖过新默认值、且设置界面无法看见/清除。
        // 对“等于旧默认值”的遗留配置做静默清理（用户显式配置的其它 API 模板不受影响）。
        const LEGACY_API_TEMPLATES = [
            'https://nhentai.net/api/gallery/{gid}',
            'https://nhentai.net/api/galleries/{gid}'
        ];
        if (LEGACY_API_TEMPLATES.includes(String(this.data.apiUrlTemplate || '').trim())) {
            this.data.apiUrlTemplate = '';
            this.save();
        }
    }

    all() {
        return Object.assign({}, DEFAULTS, this.data);
    }

    get(key) {
        return this.data[key] !== undefined ? this.data[key] : DEFAULTS[key];
    }

    /** 仅接受 DEFAULTS 中存在的键，并按默认值类型校验 */
    update(patch) {
        const errors = [];
        const next = {};
        for (const [key, value] of Object.entries(patch || {})) {
            if (!(key in DEFAULTS)) { errors.push(`未知配置项: ${key}`); continue; }
            const def = DEFAULTS[key];
            if (Array.isArray(def)) {
                if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
                    errors.push(`${key} 必须是字符串数组`); continue;
                }
                next[key] = value.map(v => v.trim()).filter(Boolean);
            } else if (typeof def === 'number') {
                const n = Number(value);
                if (!Number.isFinite(n) || n < 0) { errors.push(`${key} 必须是非负数字`); continue; }
                next[key] = n;
            } else if (typeof def === 'boolean') {
                if (typeof value !== 'boolean') { errors.push(`${key} 必须是布尔值`); continue; }
                next[key] = value;
            } else {
                if (typeof value !== 'string') { errors.push(`${key} 必须是字符串`); continue; }
                next[key] = value.trim();
            }
        }
        if (errors.length === 0) {
            Object.assign(this.data, next);
            this.save();
        }
        return { ok: errors.length === 0, errors, data: this.all() };
    }

    save() {
        atomicWriteJson(this.file, this.data);
    }
}

module.exports = { Config, DEFAULTS };
