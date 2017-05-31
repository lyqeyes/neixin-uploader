'use strict';

import EventEmitter from './eventBus.js';
import EventDelegate from './eventDelegate.js';
import {Transport} from './transport.js';
import {WUFile} from './file.js';
import FileGetter from './fileGetter.js';

let _config = {
    timeout: 0,
    accept: [],
    auto: true,
    sameTimeUploadCount: 3, // 同时上传个数
    chunked: false,
    chunkSize: 20971520,
    chunkRetry: 2,
    formData: {},
    headers: {},
    fileVal: 'file',
    method: 'POST',
    fileNumLimit: void 0,
    fileSizeLimit: void 0,
    fileSingleSizeLimit: void 0,
    dnd: void 0,
    pick: void 0,
    paste: void 0,
    server: '',
    listenerContainer: document,
    body: document.body,
    multiple: false,
    withCredentials: false,
    setName: (id) => new Date().getTime() + id,
    log: console.log,
    _log: () => {},
    logLevel: 1,
    fileIdPrefix: 'WU_FILE_'
};

// 分片状态
let blobStatus = {
    WAIT: 'wait', // 已经进入队列等待上传
    PENDING: 'pending', // 正在上传中
    ERROR: 'error', // 上传出错(eg.网络错误等)
    SUCCESS: 'success', // 上传成功
    CANCELLED: 'cancelled',  // 上传取消
    INTERRUPT: 'interrupt', // 上传中断，可续传
};

export class Uploader {
    constructor(config = {}) {
        this.blobsQueue = []; // 各个分片的队列
        this.config = Object.assign({}, _config, config);

        this.eventEmitter = new EventEmitter();
        this.eventDelegate = new EventDelegate(this.config.listenerContainer);
        this.log = function () {
            let args = Array.prototype.slice.call(arguments, 0);
            args = ['FILE', ...args];
            this.config.log.apply(null, args);
        }.bind(this);
        this.config._log = this.log;

        this.fileGetter = new FileGetter(this.config, this.pushQueue.bind(this), this.eventEmitter, this.eventDelegate);
        this.fileProgressCalc(); // 全局文件进度监听
    }

    // 在这里有`beforeFileQueued`事件，用户可以在这个事件阻止文件被加入队列
    async pushQueue(file, groupInfo) {
        try {
            let wuFile = new WUFile(file, {
                eventEmitter: this.eventEmitter,
                setName: this.config.setName,
                fileIdPrefix: this.config.fileIdPrefix,
                groupInfo: groupInfo || {}
            });
            let res = await this.eventEmitter.emit('beforeFileQueued', {file: wuFile});
            if (res.indexOf(false) === -1) {
                wuFile.statusText = WUFile.Status.QUEUED;
                await this.eventEmitter.emit('fileQueued', { file: wuFile });
                if (this.config.auto) {
                    this.sliceFile(wuFile);
                }
                // TODO 不需要auto的时候还没做
            }
        } catch (err) {
            console.log(err);
            debugger;
        }
    }

    // 对文件进行分片 哈哈哈
    async sliceFile (wuFile) {
        try {
            if ( wuFile.isFile === false ) { return null; }
            if ( this.config.chunked ) {
                let shardCount = Math.ceil(wuFile.size / this.config.chunkSize);
                if ( shardCount === 0 ) {
                    shardCount = 1;
                }
                for ( let i = 0, len = shardCount; i < len; i++  ) {
                    let start = i * this.config.chunkSize;
                    let end = Math.min(wuFile.size, start + this.config.chunkSize);
                    let blob = wuFile.source.slice(start, end);

                    let shardObj = {
                        shardCount: shardCount,
                        currentShard: i + 1 // 分片从1开始，下标都要+1
                    };
                    await this.pushBlobQueue(blob, wuFile, shardObj); // 需要异步等待
                }
            }
        } catch (err) {
            console.log(err);
            debugger;
        }
    }

    // 业务方自己传进来的文件
    pushFile (file) {
        let id = 'initiative_' + new Date().getTime();
        this.log('initiative_pushFile', id, file);
        file.selectFileTransactionId = id;
        this.pushQueue(file);
    }

    // 分片队列 推进分片队列的时候还会开始上传
    async pushBlobQueue (obj, file, shardObj) {
        try {
            // 分片对象
            let blobObj = {
                blob: obj,
                file: file, // wuFile
                shard: shardObj,
                status: blobStatus.WAIT,
                loaded: 0,
                config: {
                    server: '',
                    headers: '',
                    formData: {}
                }
            };
            this.log('pushBlobQueue', blobObj);
            this.blobsQueue.push(blobObj);

            // 正在上传的文件个数
            let pendingLen = this.blobsQueue.filter(item => {
                return item.status === blobStatus.PENDING;
            }).length;

            if (pendingLen < this.config.sameTimeUploadCount) {
                await this.runBlobQueue();
            }
        } catch (err) {
            console.log(err);
            debugger;
        }
    }

    // 准备上传分片
    async runBlobQueue () {
        try {
            let currentUploadCount = this.blobsQueue.filter(item => item.status === blobStatus.PENDING).length;

            if ( currentUploadCount < this.config.sameTimeUploadCount ) {
                let blobObj = this.blobsQueue.find(item => item.status === blobStatus.WAIT);
                if ( !blobObj ) { return void 0; } // 只有一个分片的时候
                blobObj.status = blobStatus.PENDING; // 由于是异步的关系 这个必须提前

                // 检测文件开始上传
                await this.checkFileUploadStart({
                    file: blobObj.file, // 私有文件对象
                    shardCount: blobObj.shard.shardCount, // 总分片数
                    config: blobObj.config
                });

                await this.eventEmitter.emit('uploadBeforeSend', {
                    file: blobObj.file, // 私有文件对象
                    shard: blobObj.blob, // 文件blob
                    shardCount: blobObj.shard.shardCount, // 总分片数
                    currentShard: blobObj.shard.currentShard, // 当前片数
                    config: blobObj.config
                });

                // 真正的上传
                blobObj.file.statusText = WUFile.Status.PROGRESS;
                let uploadPromise = this._baseupload(blobObj);
                uploadPromise.then(val => {
                    debugger
                }).catch(err => {
                    debugger
                })
                debugger
                // NND 这里用async function 进不来
                uploadPromise.then(res => {
                    debugger
                    try {
                        this._uploadSuccess(res, blobObj)
                            .then(() => {
                                this.runBlobQueue();
                            });
                    } catch (err) {
                        console.log(err);
                        debugger;
                    }
                }).catch(err => {
                    debugger
                    try {
                        this._catchUpfileError(err, blobObj)
                            .then(() => {
                                this.runBlobQueue();
                            });
                    } catch (err) {
                        console.log(err);
                        debugger;
                    }
                });
            }
        } catch (err) {
            console.log(err);
            debugger;
        }
    }

    // 错误处理
    async _catchUpfileError(err, blobObj) {
        if ( err.message === 'initiative interrupt' ) {
            return void 0;
        }
        this.log('in _catchUpfileError', blobObj.status, blobObj.file.id);
        // TODO 重置错误分片的loaded属性

        blobObj.file.statusText = WUFile.Status.ERROR;
        // 已经错误处理过的文件就不需要处理了
        if (!(blobObj.status === blobStatus.CANCELLED
            || blobObj.status === blobStatus.INTERRUPT
            || blobObj.status === blobStatus.ERROR)) {

            // 停止所有分片
            this.blobsQueue = this.blobsQueue.map(item => {
                // 是当前文件的分片并且该分片没有传输成功
                if ( item.file.id === blobObj.file.id && item.status !== blobStatus.SUCCESS ) {
                    item.transport && item.transport.abort();
                    item.status = blobStatus.ERROR;
                    item.loaded = 0;
                    this.log('[FILE]', '_catchUpfileError: ', item, item.file.id);
                }
                return item;
            });

            await this.eventEmitter.emit('uploadError', {
                file: blobObj.file,
                error: err
            });

            await this.eventEmitter.emit('uploadEndSend', {
                file: blobObj.file,
                shard: blobObj.blob,
                shardCount: blobObj.shard.shardCount,
                currentShard: blobObj.shard.currentShard
            });
        }
    }

    // 检测文件是否第一次开始上传分片
    async checkFileUploadStart (obj) {
        let { file, shardCount, config } = obj;

        let curFileShard = this.blobsQueue.filter(item => item.file.id === file.id);
        let pendingCount = 0;
        let successCount = 0;
        curFileShard.map(item => {
            if ( item.status === blobStatus.PENDING ) { // TODO 看看这个规则是否需要优化
                pendingCount++;
            }
            if ( item.status === blobStatus.SUCCESS ) {
                successCount++;
            }
        });
        // 正在上传的只有一个文件 并且没有文件上传成功 注意次条件不应该触发多次 重传的策略再想
        if ( pendingCount === 1 && successCount === 0 ) {
            if ( file.statusText === WUFile.Status.QUEUED ) {
                file.statusText = WUFile.Status.PROGRESS;
                await this.eventEmitter.emit('uploadStart', {file: file, shardCount: shardCount, config: config}); // 导出wuFile对象
            } else {
                this.log('检测第一次上传文件出错');
                // 不应该出现这个debugger的
                debugger;
            }
        }
    }

    // 检查文件是否传输完毕
    checkFileUploadEnd (file) {
        // 除了success已经没有其他成功状态了
        let currentFileShard = this.blobsQueue.filter(item => item.file.id === file.id);
        let notSuccessShard = currentFileShard.filter(item => item.status !== blobStatus.SUCCESS);

        return notSuccessShard.length === 0; // 为0则表示传输完毕了
    }

    // 文件上传成功之后
    async _uploadSuccess (res, blobObj) {
        debugger
        blobObj.status = blobStatus.SUCCESS;
        let isFileUploadEnd = this.checkFileUploadEnd(blobObj.file);
        if ( isFileUploadEnd ) {
            blobObj.file.statusText = WUFile.Status.COMPLETE;
        }

        // 每个分片成功后的
        await this.eventEmitter.emit('uploadAccept', {
            file: blobObj.file,
            shard: blobObj.blob,
            shardCount: blobObj.shard.shardCount,
            currentShard: blobObj.shard.currentShard,
            isUploadEnd: isFileUploadEnd,
            responseText: res
        });

        // 文件传输是否完成
        if ( isFileUploadEnd ) {
            await this.eventEmitter.emit('uploadSuccess', {
                file: blobObj.file,
                shard: blobObj.blob,
                shardCount: blobObj.shard.shardCount,
                currentShard: blobObj.shard.currentShard
            });
            await this.eventEmitter.emit('uploadEndSend', {
                file: blobObj.file,
                shard: blobObj.blob,
                shardCount: blobObj.shard.shardCount,
                currentShard: blobObj.shard.currentShard
            });
            // 只能在成功的时候移除分片 如果提前移除分片会导致进度计算不准确
            this._removeFileFromQueue(blobObj.file.id);
        }
    }

    _removeFileFromQueue(id) {
        this.blobsQueue = this.blobsQueue.filter(blobObj => blobObj.file.id !== id);
    }

    interruptFile(id) {
        this.blobsQueue.forEach(item => {
            if ( item.file.id === id && item.status !== blobStatus.SUCCESS ) {
                item.file.statusText = WUFile.Status.INTERRUPT;
                item.status = blobStatus.INTERRUPT;
                item.transport && item.transport.abort();
            }
        });
    }

    //中断所有
    interruptAllFile() {
        this.blobsQueue.forEach(item => {
            item.status = blobStatus.INTERRUPT;
            item.file.statusText = WUFile.Status.CANCELLED;
            item.transport && item.transport.abort();
        });
    }

    // 重传
    reUpload (id) {
        // 重传的时候uploadStart事件不触发
        this.blobsQueue.forEach(item => {
            if ( item.file.id === id &&
                item.status !== blobStatus.WAIT &&
                item.status !== blobStatus.PENDING &&
                item.status !== blobStatus.SUCCESS
            ) {
                item.status = blobStatus.WAIT;
                item.file.statusText = WUFile.Status.QUEUED;
                this.runBlobQueue();
            }
        });
    }

    async _baseupload(blobObj) { // 加入了第三个参数
        try {
            let config = {
                server: blobObj.config.server,
                headers: blobObj.config.headers,
                method: this.config.method,
                fileVal: this.config.fileVal,
                timeout: this.config.timeout,    // 2分钟
                formData: this.config.formData,
                fileName: blobObj.file.name,
                withCredentials: this.config.withCredentials,
                log: this.log
            };
            let res = null;
            for (let i = 0; i < this.config.chunkRetry; i++) {
                if ( blobObj.status !== blobStatus.PENDING ) {
                    throw new Error('initiative interrupt'); // 防止终止后retry继续触发
                }
                try {
                    this.transport = new Transport(blobObj.blob, this.eventEmitter, config, blobObj);
                    blobObj.transport = this.transport; // 为了能够abort
                    res = await this.transport.send();
                    break;
                } catch (err) {
                    if ( i >= this.config.chunkRetry-1 ) {
                        throw new Error(err);
                    }
                }
            }
            this.transport = null;
            debugger
            return res;
        } catch (err) {
            console.log(err);
            debugger;
        }
    }

    // 文件上传进度监听 只会运行一次
    fileProgressCalc () {
        this.eventEmitter.on('uploadBlobProgress', (shardLoaded, shardTotal, blobObj) => {
            // 文件的速度暂时不做了
            // let prevProgressTime = blobObj.file.prevProgressTime;
            // if ( prevProgressTime ) {
            //     let curProgressTime = new Date().getTime();
            // } else {
            //     blobObj.file.uploadSpeed = 0;
            //     blobObj.file.prevProgressTime = new Date().getTime();
            // }
            //
            // 修复abort后还会抛出progress事件的问题
            if ( blobObj.status !== blobStatus.PENDING ) {
                return void 0;
            }
            blobObj.loaded = shardLoaded;

            let currentLoaded = 0;
            let fileTotalSize = blobObj.file.size;

            let currentFileBlobArr = this.blobsQueue.filter(item => blobObj.file.id === item.file.id);
            currentFileBlobArr.forEach(item => currentLoaded += item.loaded);
            currentLoaded = currentLoaded > fileTotalSize ? fileTotalSize : currentLoaded; // 偶尔会超过整体的大小
            blobObj.file.loaded = currentLoaded;

            this.eventEmitter.emit('uploadProgress', {
                file: blobObj.file,
                loaded: currentLoaded,
                total: fileTotalSize,
                shardLoaded: shardLoaded,
                shardTotal: shardTotal,
                uploadSpeed: blobObj.file.uploadSpeed
            });
        });
    }

    on(eventSource, fn) {
        this.eventEmitter.on(eventSource, fn);
    }

    destroy () {
        this.fileGetter.destroy();
        this.blobsQueue = this.blobsQueue.filter(item => {
            item.transport && item.transport.abort();
            item.status = blobStatus.CANCELLED;
            item.file.statusText = WUFile.CANCELLED;
            return false;
        });
    }
}

export let FileStatus = WUFile.Status;
