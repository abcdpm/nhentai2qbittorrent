'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, atomicWriteJson, nowIso, uuid } = require('./util');

/**
 * API Key 存储：磁盘上仅保存 SHA-256 哈希，明文只在生成时返回一次。
 * 格式：nhk_<48位十六进制>
 */
class KeyStore {
    constructor(dataDir, logger) {
        this.file = path.join(dataDir, 'keys.json');
        this.dataDir = dataDir;
        this.logger = logger;
        this.keys = readJson(this.file, []);
        if (!Array.isArray(this.keys)) this.keys = [];
        this._lastUsedFlush = 0;
    }

    static hash(plaintext) {
        return crypto.createHash('sha256').update(String(plaintext), 'utf8').digest('hex');
    }

    _save() {
        atomicWriteJson(this.file, this.keys);
    }

    generateRaw() {
        return 'nhk_' + crypto.randomBytes(24).toString('hex');
    }

    create(name) {
        const raw = this.generateRaw();
        const record = {
            id: uuid(),
            name: String(name || '未命名密钥').slice(0, 60),
            prefix: raw.slice(0, 12),
            hash: KeyStore.hash(raw),
            createdAt: nowIso(),
            lastUsedAt: null
        };
        this.keys.push(record);
        this._save();
        return { record: this._public(record), raw };
    }

    /** 首次启动：若无任何密钥则自动生成一枚，并把明文写入 INITIAL_API_KEY.txt 便于本地首次配置 */
    ensureInitialKey() {
        if (this.keys.length > 0) return null;
        const { record, raw } = this.create('默认密钥（首次启动自动生成）');
        try {
            const file = path.join(this.dataDir, 'INITIAL_API_KEY.txt');
            fs.writeFileSync(file,
                `此文件仅用于首次配置，请复制下面的 API Key 后删除本文件。\n\n${raw}\n`,
                'utf8');
        } catch (e) { /* 文件写失败不影响运行 */ }
        return { record, raw };
    }

    _public(record) {
        return {
            id: record.id,
            name: record.name,
            prefix: record.prefix,
            createdAt: record.createdAt,
            lastUsedAt: record.lastUsedAt
        };
    }

    list() {
        return this.keys.map(k => this._public(k));
    }

    revoke(id) {
        const idx = this.keys.findIndex(k => k.id === id);
        if (idx === -1) return { ok: false, error: '密钥不存在' };
        if (this.keys.length <= 1) return { ok: false, error: '至少保留一枚密钥，否则将无法访问 API' };
        this.keys.splice(idx, 1);
        this._save();
        return { ok: true };
    }

    verify(raw) {
        if (!raw || typeof raw !== 'string') return null;
        const hash = KeyStore.hash(raw.trim());
        const hit = this.keys.find(k => k.hash === hash);
        if (!hit) return null;
        hit.lastUsedAt = nowIso();
        const now = Date.now();
        if (now - this._lastUsedFlush > 5000) {
            this._lastUsedFlush = now;
            try { this._save(); } catch (e) { /* ignore */ }
        }
        return this._public(hit);
    }
}

module.exports = { KeyStore };
