'use strict';
const { nowIso } = require('./util');

/**
 * 环形缓冲日志器：控制台输出 + 内存保留最近 N 条（供 Web 界面轮询）。
 */
class Logger {
    constructor(limit = 500) {
        this.limit = limit;
        this.entries = [];
        this.seq = 0;
        this.listeners = new Set();
    }

    log(level, msg, meta) {
        const entry = { seq: ++this.seq, ts: nowIso(), level, msg: String(msg), meta: meta === undefined ? null : meta };
        this.entries.push(entry);
        if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
        const tag = { info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' }[level] || level.toUpperCase();
        const line = `[${entry.ts}] [${tag}] ${entry.msg}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
        for (const fn of this.listeners) {
            try { fn(entry); } catch (e) { /* ignore listener errors */ }
        }
        return entry;
    }

    info(msg, meta) { return this.log('info', msg, meta); }
    warn(msg, meta) { return this.log('warn', msg, meta); }
    error(msg, meta) { return this.log('error', msg, meta); }
    debug(msg, meta) { return this.log('debug', msg, meta); }

    since(seq) {
        const s = Number(seq) || 0;
        return this.entries.filter(e => e.seq > s);
    }

    on(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}

module.exports = { Logger };
