'use strict';
/**
 * Web 控制台登录鉴权（零依赖）：
 *   - 账号密码登录（scrypt 哈希，data/users.json）——备用登录方式
 *   - OIDC 单点登录（授权码 + PKCE + nonce，内置 RS256/ES256 JWT 验签）——主要登录入口
 *   - 会话：HttpOnly Cookie（data/sessions.json，仅存 token 哈希）
 * API 鉴权（X-API-Key）保持不变：程序化调用（油猴脚本 / curl）不受影响，
 * /api/* 同时接受 API Key 或有效会话 Cookie。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, atomicWriteJson, nowIso, uuid } = require('./util');

const SESSION_COOKIE = 'nh_sid';

function sha256hex(s) {
    return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

/** scrypt 密码哈希（每用户独立盐） */
function hashPassword(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    return { salt: s, hash: crypto.scryptSync(String(password), s, 32).toString('hex') };
}

function verifyPasswordHash(password, salt, expectedHash) {
    try {
        const { hash } = hashPassword(password, salt);
        const a = Buffer.from(hash, 'hex');
        const b = Buffer.from(String(expectedHash || ''), 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) { return false; }
}

class AuthManager {
    constructor({ dataDir, config, logger }) {
        this.dataDir = dataDir;
        this.config = config;
        this.logger = logger;
        this.usersFile = path.join(dataDir, 'users.json');
        this.sessionsFile = path.join(dataDir, 'sessions.json');
        this.users = readJson(this.usersFile, []);
        if (!Array.isArray(this.users)) this.users = [];
        this.sessions = readJson(this.sessionsFile, {});
        if (!this.sessions || typeof this.sessions !== 'object' || Array.isArray(this.sessions)) this.sessions = {};
        this._pending = new Map();    // OIDC 登录中间态：state -> { nonce, verifier, challenge, expiresAt }
        this._discovery = null;
        this._jwks = null;
        this._pruneSessions();
    }

    /* ---------------- 用户 ---------------- */

    /** 首次启动引导：无任何用户时创建 admin（密码取 NH_AUTH_PASSWORD 或随机生成） */
    ensureBootstrapUser() {
        if (this.users.length > 0) return null;
        const username = String(process.env.NH_AUTH_USER || 'admin').trim() || 'admin';
        const generated = !process.env.NH_AUTH_PASSWORD;
        const password = String(process.env.NH_AUTH_PASSWORD || crypto.randomBytes(12).toString('hex'));
        this._addUser(username, password, null);
        try {
            fs.writeFileSync(path.join(this.dataDir, 'INITIAL_PASSWORD.txt'),
                `此文件仅用于首次配置，请登录后修改密码并删除本文件。\n\n用户名: ${username}\n密码:   ${password}\n`,
                'utf8');
        } catch (e) { /* 写文件失败不影响运行 */ }
        return { username, password, generated };
    }

    _addUser(username, password, oidcSub) {
        const pw = password ? hashPassword(password) : { salt: '', hash: '' };
        const user = {
            id: uuid(),
            username: String(username).slice(0, 80),
            oidcSub: oidcSub ? String(oidcSub) : null,
            salt: pw.salt,
            hash: pw.hash,
            createdAt: nowIso()
        };
        this.users.push(user);
        atomicWriteJson(this.usersFile, this.users);
        return user;
    }

    findUserByName(username) {
        const name = String(username || '').trim();
        return this.users.find(u => u.username === name) || null;
    }

    verifyPassword(username, password) {
        const user = this.findUserByName(username);
        if (!user || !user.hash) return null;
        return verifyPasswordHash(password, user.salt, user.hash) ? user : null;
    }

    setPassword(userId, newPassword) {
        const user = this.users.find(u => u.id === userId);
        if (!user) return { ok: false, error: '用户不存在' };
        const pw = String(newPassword || '');
        if (pw.length < 6) return { ok: false, error: '新密码至少 6 位' };
        const { salt, hash } = hashPassword(pw);
        user.salt = salt;
        user.hash = hash;
        atomicWriteJson(this.usersFile, this.users);
        return { ok: true };
    }

    /** OIDC 登录：按 sub 找用户，不存在则创建（无密码，仅可通过 SSO 登录） */
    findOrCreateOidcUser(sub, preferredName) {
        const existing = this.users.find(u => u.oidcSub && u.oidcSub === String(sub));
        if (existing) return existing;
        let name = String(preferredName || sub || 'oidc-user').slice(0, 80) || 'oidc-user';
        if (this.findUserByName(name)) name = `${name}-${String(sub).slice(-6)}`;
        return this._addUser(name, null, sub);
    }

    /* ---------------- 会话 ---------------- */

    _pruneSessions() {
        const now = Date.now();
        let dirty = false;
        for (const [k, v] of Object.entries(this.sessions)) {
            if (!v || Number(v.expiresAt) <= now) { delete this.sessions[k]; dirty = true; }
        }
        if (dirty) atomicWriteJson(this.sessionsFile, this.sessions);
    }

    createSession(user, via) {
        const token = crypto.randomBytes(32).toString('hex');
        const ttlDays = Number(this.config.get('sessionTtlDays')) || 30;
        const expiresAt = Date.now() + ttlDays * 24 * 3600 * 1000;
        this.sessions[sha256hex(token)] = {
            userId: user.id,
            username: user.username,
            via: via || 'password',
            createdAt: nowIso(),
            expiresAt
        };
        atomicWriteJson(this.sessionsFile, this.sessions);
        return { token, expiresAt };
    }

    getSession(token) {
        if (!token) return null;
        const k = sha256hex(token);
        const hit = this.sessions[k];
        if (!hit) return null;
        if (Number(hit.expiresAt) <= Date.now()) {
            delete this.sessions[k];
            atomicWriteJson(this.sessionsFile, this.sessions);
            return null;
        }
        return hit;
    }

    destroySession(token) {
        if (!token) return;
        const k = sha256hex(token);
        if (this.sessions[k]) {
            delete this.sessions[k];
            atomicWriteJson(this.sessionsFile, this.sessions);
        }
    }

    sessionFromRequest(req) {
        const token = parseCookies(req)[SESSION_COOKIE];
        return this.getSession(token);
    }

    sessionCookie(token, req) {
        const secure = this._isHttps(req);
        const ttlDays = Number(this.config.get('sessionTtlDays')) || 30;
        return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlDays * 24 * 3600}${secure ? '; Secure' : ''}`;
    }

    clearSessionCookie(req) {
        const secure = this._isHttps(req);
        return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
    }

    _isHttps(req) {
        const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        return xf === 'https' || !!(req.socket && req.socket.encrypted);
    }

    /* ---------------- OIDC ---------------- */

    oidcConfig() {
        const issuer = String(this.config.get('oidcIssuer') || '').trim().replace(/\/+$/, '');
        const clientId = String(this.config.get('oidcClientId') || '').trim();
        return {
            issuer,
            clientId,
            clientSecret: String(this.config.get('oidcClientSecret') || '').trim(),
            scopes: String(this.config.get('oidcScopes') || 'openid profile email').trim() || 'openid profile email'
        };
    }

    isOidcEnabled() {
        const c = this.oidcConfig();
        return !!(c.issuer && c.clientId);
    }

    async _discover() {
        const { issuer } = this.oidcConfig();
        if (this._discovery && this._discovery.issuer === issuer) return this._discovery.doc;
        const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`OIDC discovery 失败: HTTP ${res.status}`);
        const doc = await res.json();
        if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error('OIDC discovery 缺少 authorization/token 端点');
        this._discovery = { issuer, doc };
        return doc;
    }

    async _getJwks(uri) {
        if (this._jwks && this._jwks.uri === uri && Date.now() - this._jwks.at < 3600 * 1000) return this._jwks.keys;
        const res = await fetch(uri, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`JWKS 获取失败: HTTP ${res.status}`);
        const data = await res.json();
        const keys = Array.isArray(data.keys) ? data.keys : [];
        this._jwks = { uri, keys, at: Date.now() };
        return keys;
    }

    redirectUri(publicBase) {
        const explicit = String(this.config.get('oidcRedirectUri') || '').trim();
        if (explicit) return explicit;
        return `${String(publicBase).replace(/\/+$/, '')}/auth/oidc/callback`;
    }

    /** 生成授权跳转 URL；state/nonce/code_verifier 存入内存待回调校验 */
    async beginOidcLogin(publicBase) {
        const cfg = this.oidcConfig();
        if (!cfg.issuer || !cfg.clientId) throw new Error('未配置 OIDC（oidcIssuer / oidcClientId）');
        const doc = await this._discover();
        const state = crypto.randomBytes(16).toString('hex');
        const nonce = crypto.randomBytes(16).toString('hex');
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        this._pending.set(state, { nonce, verifier, challenge, expiresAt: Date.now() + 10 * 60 * 1000 });
        for (const [k, v] of this._pending) if (v.expiresAt <= Date.now()) this._pending.delete(k);

        const redirectUri = this.redirectUri(publicBase);
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: cfg.clientId,
            redirect_uri: redirectUri,
            scope: cfg.scopes,
            state,
            nonce,
            code_challenge: challenge,
            code_challenge_method: 'S256'
        });
        return { url: `${doc.authorization_endpoint}?${params.toString()}`, state, nonce, redirectUri };
    }

    /** 回调：换 token + 验签 id_token，返回身份 { user, payload } */
    async completeOidcLogin({ code, state, error }, publicBase) {
        if (error) throw new Error(`OIDC 返回错误: ${error}`);
        if (!code || !state) throw new Error('OIDC 回调缺少 code/state');
        const pending = this._pending.get(String(state));
        this._pending.delete(String(state));
        if (!pending || pending.expiresAt <= Date.now()) throw new Error('OIDC 登录状态无效或已过期，请重新登录');

        const cfg = this.oidcConfig();
        const doc = await this._discover();
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: this.redirectUri(publicBase),
            client_id: cfg.clientId,
            code_verifier: pending.verifier
        });
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (cfg.clientSecret) headers['Authorization'] = 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
        const res = await fetch(doc.token_endpoint, {
            method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(15000)
        });
        const tok = await res.json().catch(() => ({}));
        if (!res.ok || !tok.id_token) {
            throw new Error(`OIDC token 交换失败: ${tok.error_description || tok.error || ('HTTP ' + res.status)}`);
        }

        const payload = await this.verifyIdToken(tok.id_token, {
            issuer: cfg.issuer, audience: cfg.clientId, nonce: pending.nonce, jwksUri: doc.jwks_uri
        });
        const username = payload.preferred_username || payload.email || payload.name || payload.sub;
        const user = this.findOrCreateOidcUser(payload.sub, username);
        return { user, payload };
    }

    /** id_token 验签（RS256/ES256）+ iss/aud/exp/nonce 校验 */
    async verifyIdToken(idToken, { issuer, audience, nonce, jwksUri }) {
        const parts = String(idToken).split('.');
        if (parts.length !== 3) throw new Error('id_token 格式错误');
        let header, payload;
        try {
            header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
            payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        } catch (e) { throw new Error('id_token 解析失败'); }

        const alg = String(header.alg || '');
        if (alg !== 'RS256' && alg !== 'ES256') throw new Error(`不支持的 id_token 签名算法: ${alg || 'none'}`);

        const now = Math.floor(Date.now() / 1000);
        if (payload.iss !== issuer) throw new Error('id_token iss 不匹配');
        const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!aud.includes(audience)) throw new Error('id_token aud 不匹配');
        if (!payload.exp || Number(payload.exp) < now - 30) throw new Error('id_token 已过期');
        if (payload.iat && Number(payload.iat) > now + 120) throw new Error('id_token 时间异常');
        if (nonce && payload.nonce !== nonce) throw new Error('id_token nonce 不匹配');
        if (!payload.sub) throw new Error('id_token 缺少 sub');

        const keys = await this._getJwks(jwksUri);
        let candidates = header.kid ? keys.filter(k => k.kid === header.kid) : keys;
        if (candidates.length === 0) {
            this._jwks = null;   // kid 未命中 → 强制刷新 JWKS 再试一次
            const fresh = await this._getJwks(jwksUri);
            candidates = header.kid ? fresh.filter(k => k.kid === header.kid) : fresh;
            if (candidates.length === 0) throw new Error('JWKS 中找不到匹配的签名密钥');
        }
        return this._verifyWithJwk(parts, alg, candidates[0], payload);
    }

    _verifyWithJwk(parts, alg, jwk, payload) {
        let key;
        try {
            key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        } catch (e) {
            throw new Error('JWK 导入失败: ' + e.message);
        }
        const data = Buffer.from(`${parts[0]}.${parts[1]}`);
        const sig = Buffer.from(parts[2], 'base64url');
        let ok = false;
        if (alg === 'RS256') {
            const v = crypto.createVerify('RSA-SHA256');
            v.update(data);
            ok = v.verify(key, sig);
        } else {
            const v = crypto.createVerify('SHA256');
            v.update(data);
            ok = v.verify({ key, dsaEncoding: 'ieee-p1363' }, sig);
        }
        if (!ok) throw new Error('id_token 签名校验失败');
        return payload;
    }
}

module.exports = { AuthManager, SESSION_COOKIE, parseCookies, hashPassword };
