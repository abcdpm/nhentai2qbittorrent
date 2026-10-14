'use strict';
const path = require('path');
const { readJson, atomicWriteJson, nowIso } = require('./util');

/**
 * 前端状态云端持久化（data/state.json）——浏览器端 nh_qb_* 字段的主存储：
 *   downloadedGids  已下载清单（并集合并，历史事实不回退）
 *   checked         勾选状态 gid->title（快照替换，支持取消勾选同步）
 *   downloadingGids 下载中标记（快照替换）
 *   pushedGids      推送清单 gid->时间戳（并集合并）
 */
const DEFAULTS = { downloadedGids: [], checked: {}, downloadingGids: [], pushedGids: {} };

function cleanGidList(arr) {
    return [...new Set((Array.isArray(arr) ? arr : []).map(String).filter(g => /^\d+$/.test(g)))];
}

class StateStore {
    constructor(dataDir) {
        this.file = path.join(dataDir, 'state.json');
        const raw = readJson(this.file, {});
        this.data = {
            downloadedGids: cleanGidList(raw.downloadedGids),
            downloadingGids: cleanGidList(raw.downloadingGids),
            checked: (raw.checked && typeof raw.checked === 'object' && !Array.isArray(raw.checked)) ? raw.checked : {},
            pushedGids: (raw.pushedGids && typeof raw.pushedGids === 'object' && !Array.isArray(raw.pushedGids)) ? raw.pushedGids : {}
        };
    }

    get() {
        return {
            downloadedGids: [...new Set(this.data.downloadedGids)],
            checked: Object.assign({}, this.data.checked),
            downloadingGids: [...new Set(this.data.downloadingGids)],
            pushedGids: Object.assign({}, this.data.pushedGids),
            updatedAt: nowIso()
        };
    }

    /** 合并浏览器上传的快照（并集 + 快照替换混合语义） */
    merge(patch) {
        patch = patch || {};

        if (patch.downloadedGids !== undefined) {
            this.data.downloadedGids = [...new Set([...this.data.downloadedGids, ...cleanGidList(patch.downloadedGids)])];
        }
        if (patch.pushedGids && typeof patch.pushedGids === 'object' && !Array.isArray(patch.pushedGids)) {
            for (const [g, ts] of Object.entries(patch.pushedGids)) {
                if (/^\d+$/.test(String(g))) this.data.pushedGids[String(g)] = Number(ts) || Date.now();
            }
        }
        if (patch.checked !== undefined) {
            const next = {};
            if (patch.checked && typeof patch.checked === 'object' && !Array.isArray(patch.checked)) {
                for (const [g, t] of Object.entries(patch.checked)) {
                    if (/^\d+$/.test(String(g))) next[String(g)] = String(t == null ? '' : t).slice(0, 500);
                }
            }
            this.data.checked = next;   // 快照替换：取消勾选可同步
        }
        if (patch.downloadingGids !== undefined) {
            this.data.downloadingGids = cleanGidList(patch.downloadingGids);
        }

        this.persist();
        return this.get();
    }

    persist() {
        atomicWriteJson(this.file, this.data);
    }
}

module.exports = { StateStore };
