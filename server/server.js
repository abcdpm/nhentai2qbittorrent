#!/usr/bin/env node
'use strict';
/**
 * nHentai 本地下载服务
 * - 任务队列：后台自动排队下载
 * - 自动完整性校验 + 超时重传 + 多 CDN 轮询
 * - 图片格式统一为 WebP（jpg/png -> webp，gif -> 动态 webp；依赖可选包 sharp）
 * - 请求/任务间隔，防止 429 限流
 * - API Key 鉴权 + 现代化 Web 管理界面
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const { Config } = require('./src/config');
const { Logger } = require('./src/logger');
const { KeyStore } = require('./src/keys');
const { TaskStore } = require('./src/store');
const { Downloader } = require('./src/downloader');
const { QueueManager } = require('./src/queue');
const { createHandler } = require('./src/api');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

function bootstrap() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const logger = new Logger(500);
    const config = new Config(DATA_DIR);

    // downloadDir 相对路径基于 server 目录解析
    const dl = config.get('downloadDir');
    if (!path.isAbsolute(dl)) {
        config.data.downloadDir = path.resolve(ROOT, dl);
    }
    fs.mkdirSync(config.get('downloadDir'), { recursive: true });

    const keys = new KeyStore(DATA_DIR, logger);
    const initial = keys.ensureInitialKey();
    if (initial) {
        logger.warn('========== 首次启动已自动生成 API Key ==========');
        logger.warn(`API Key: ${initial.raw}`);
        logger.warn(`同时已写入文件: ${path.join(DATA_DIR, 'INITIAL_API_KEY.txt')}（复制后请删除该文件）`);
        logger.warn('所有 /api/* 接口均需该密钥（请求头 X-API-Key），请勿泄露到公网');
        logger.warn('================================================');
    }

    const store = new TaskStore(DATA_DIR);
    const recovered = store.recoverInterrupted();
    if (recovered > 0) logger.info(`已恢复 ${recovered} 个中断的下载任务`);

    const downloader = new Downloader(config, logger);
    const queue = new QueueManager(store, config, logger, downloader);
    queue.start();

    const handler = createHandler({ config, store, keys, queue, logger, downloader });
    const server = http.createServer((req, res) => {
        handler(req, res).catch(e => {
            logger.error(`未捕获的请求异常: ${e.message}`);
            try { res.writeHead(500); res.end('Internal Server Error'); } catch (e2) { /* ignore */ }
        });
    });

    const host = config.get('host');
    const port = config.get('port');
    server.listen(port, host, () => {
        logger.info(`nHentai 下载服务已启动: http://${host}:${port}`);
        logger.info(`下载目录: ${config.get('downloadDir')}`);
        logger.info(`任务间隔 ${config.get('galleryIntervalMs')}ms | 请求间隔 ${config.get('requestIntervalMs')}ms | 单页超时 ${config.get('timeoutMs')}ms | 重试 ${config.get('maxAttempts')} 轮 | 补齐 ${config.get('repairRounds')} 轮`);
        logger.info(`WebP 统一转换: ${config.get('convertToWebp') ? '开启' : '关闭'}${downloader.converter._load() ? '' : '（缺少可选依赖 sharp，已自动降级为保留原格式）'}`);
    });

    let closing = false;
    async function shutdown(signal) {
        if (closing) return;
        closing = true;
        logger.info(`收到 ${signal}，正在退出...`);
        server.close();
        await queue.stop();
        store.flush();
        process.exit(0);
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    return { server, queue, store, config, keys, logger, downloader };
}

if (require.main === module) {
    bootstrap();
}

module.exports = { bootstrap };
