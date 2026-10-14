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

/** 与油猴脚本一致的文件名清洗规则 */
function sanitizeFileName(name) {
    return String(name == null ? '' : name)
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 150)
        .trim()
        .replace(/[.+\-\s]+$/g, '');
}

/** 目标文件夹名格式：本子名 [本子id] */
function galleryFolderName(title, gid) {
    const clean = sanitizeFileName(title);
    return `${clean || 'untitled'} [${gid}]`;
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
