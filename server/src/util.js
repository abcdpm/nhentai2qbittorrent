'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function uuid() {
    return crypto.randomUUID();
}

function nowIso() {
    return new Date().toISOString();
}

// Windows/Linux 双平台文件名限制
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** 按 UTF-8 字节数从尾部截断（不会切开多字节字符） */
function truncateUtf8(str, maxBytes) {
    let out = '';
    let bytes = 0;
    for (const ch of String(str)) {
        const b = Buffer.byteLength(ch, 'utf8');
        if (bytes + b > maxBytes) break;
        out += ch;
        bytes += b;
    }
    return out;
}

function sanitizeFileName(name, maxBytes) {
    let s = String(name == null ? '' : name)
        .replace(ILLEGAL_CHARS, ' ')
        .replace(CONTROL_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (maxBytes) s = truncateUtf8(s, maxBytes);
    s = s.replace(/[.+\-\s]+$/g, '');          // Windows 不允许结尾的点和空格
    if (WINDOWS_RESERVED.test(s)) s = s + '_'; // Windows 保留设备名
    return s;
}

/**
 * 文件夹名格式：本子名 [本子id]
 * 双平台安全：Windows(255 字符/组件、禁用保留名、结尾不能是点/空格)
 *            Linux(255 字节/组件，ext4)
 * 整体按 UTF-8 字节 ≤ maxBytes(默认 180，双平台留有余量)；
 * 超长时截掉标题最后面的文字，保留末端 [id] 标记（LANraragi 插件按末端 [id] 识别本子 ID）。
 */
function galleryFolderName(title, gid, maxBytes = 180) {
    const suffix = ` [${gid}]`;
    const clean = sanitizeFileName(title, Math.max(16, maxBytes - Buffer.byteLength(suffix, 'utf8')));
    return `${clean || 'untitled'}${suffix}`;
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

function atomicWriteJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function decodeEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
    return decodeEntities(String(html).replace(/<[^>]*>/g, ''));
}

function parseRetryAfter(res) {
    const raw = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = {
    sleep,
    uuid,
    nowIso,
    sanitizeFileName,
    galleryFolderName,
    readJson,
    atomicWriteJson,
    formatBytes,
    decodeEntities,
    stripTags,
    parseRetryAfter
};
