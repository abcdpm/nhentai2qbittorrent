'use strict';
/**
 * 零依赖 ZIP 读写：压缩文件夹为标准 zip（deflate-raw + CRC32 + UTF-8 文件名），
 * 并支持读取中央目录做完整性校验。条目按页码数值排序（1.jpg < 2.jpg < 10.jpg）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date, time };
}

/** 按文件名前的页码数值排序（保证漫画阅读顺序） */
function numericNameCompare(a, b) {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : (a > b ? 1 : 0);
}

function listFilesSorted(dir) {
    return fs.readdirSync(dir)
        .filter(f => !f.endsWith('.part') && fs.statSync(path.join(dir, f)).isFile())
        .sort(numericNameCompare);
}

/** 将目录压缩为 zip（原子写：先 .part 再改名），返回 { entries, bytes } */
function createZipFromDir(dir, zipPath) {
    const files = listFilesSorted(dir);
    if (files.length === 0) throw new Error('目录为空，无法压缩');

    const tmp = zipPath + '.part';
    const fd = fs.openSync(tmp, 'w');
    const { date, time } = dosDateTime(new Date());
    const central = [];
    let offset = 0;

    try {
        for (const name of files) {
            const raw = fs.readFileSync(path.join(dir, name));
            const comp = zlib.deflateRawSync(raw, { level: 6 });
            const useStore = comp.length >= raw.length;
            const data = useStore ? raw : comp;
            const method = useStore ? 0 : 8;
            const crc = crc32(raw);
            const nameBuf = Buffer.from(name, 'utf8');

            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);       // version needed
            local.writeUInt16LE(0x0800, 6);   // UTF-8 文件名标志
            local.writeUInt16LE(method, 8);
            local.writeUInt16LE(time, 10);
            local.writeUInt16LE(date, 12);
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(data.length, 18);
            local.writeUInt32LE(raw.length, 22);
            local.writeUInt16LE(nameBuf.length, 26);
            local.writeUInt16LE(0, 28);

            fs.writeSync(fd, local);
            fs.writeSync(fd, nameBuf);
            fs.writeSync(fd, data);

            central.push({ nameBuf, crc, compSize: data.length, uncompSize: raw.length, method, offset, date, time });
            offset += local.length + nameBuf.length + data.length;
        }

        const cdStart = offset;
        for (const e of central) {
            const h = Buffer.alloc(46);
            h.writeUInt32LE(0x02014b50, 0);
            h.writeUInt16LE(20, 4);       // version made by
            h.writeUInt16LE(20, 6);       // version needed
            h.writeUInt16LE(0x0800, 8);
            h.writeUInt16LE(e.method, 10);
            h.writeUInt16LE(e.time, 12);
            h.writeUInt16LE(e.date, 14);
            h.writeUInt32LE(e.crc, 16);
            h.writeUInt32LE(e.compSize, 20);
            h.writeUInt32LE(e.uncompSize, 24);
            h.writeUInt16LE(e.nameBuf.length, 28);
            h.writeUInt16LE(0, 30);       // extra len
            h.writeUInt16LE(0, 32);       // comment len
            h.writeUInt16LE(0, 34);       // disk start
            h.writeUInt16LE(0, 36);       // internal attr
            h.writeUInt32LE(0, 38);       // external attr
            h.writeUInt32LE(e.offset, 42);
            fs.writeSync(fd, h);
            fs.writeSync(fd, e.nameBuf);
            offset += h.length + e.nameBuf.length;
        }

        const cdSize = offset - cdStart;
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(central.length, 8);
        eocd.writeUInt16LE(central.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20);
        fs.writeSync(fd, eocd);
    } finally {
        fs.closeSync(fd);
    }

    fs.renameSync(tmp, zipPath);
    return { entries: central.length, bytes: fs.statSync(zipPath).size };
}

/** 读取 zip 中央目录条目（用于完整性校验） */
function readZipEntries(zipPath) {
    const buf = fs.readFileSync(zipPath);
    let eocdPos = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
    }
    if (eocdPos === -1) throw new Error('EOCD 未找到：不是有效的 zip 文件');

    const count = buf.readUInt16LE(eocdPos + 10);
    let p = buf.readUInt32LE(eocdPos + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const compSize = buf.readUInt32LE(p + 20);
        const uncompSize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        entries.push({ name, method, crc, compSize, uncompSize, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** 解出某个条目的内容并做 CRC 校验（校验用） */
function extractZipEntry(zipPath, entry) {
    const buf = fs.readFileSync(zipPath);
    const p = entry.localOffset;
    if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('本地文件头损坏');
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const dataStart = p + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + entry.compSize);
    const raw = entry.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    if (crc32(raw) !== entry.crc) throw new Error(`条目 ${entry.name} CRC 校验失败`);
    return raw;
}

module.exports = { createZipFromDir, readZipEntries, extractZipEntry, crc32, numericNameCompare };

