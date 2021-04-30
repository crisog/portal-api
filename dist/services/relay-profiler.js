"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pocket_js_1 = require("@pokt-network/pocket-js");
const pgFormat = require('pg-format');
const logger = require('../services/logger');
class RelayProfiler extends pocket_js_1.BaseProfiler {
    constructor(pgPool) {
        super();
        this.data = [];
        this.pgPool = pgPool;
    }
    async flushResults(requestID, functionName, results) {
        const bulkData = [];
        const timestamp = new Date();
        results.forEach((result) => {
            bulkData.push([
                timestamp,
                requestID,
                functionName,
                result.blockKey,
                result.timeElapsed,
            ]);
        });
        if (bulkData.length > 0) {
            const metricsQuery = pgFormat('INSERT INTO profile VALUES %L', bulkData);
            logger.log('info', 'FLUSHING QUERY: ' + JSON.stringify(metricsQuery), { requestID: '', relayType: '', typeID: '', serviceNode: '', error: '', elapsedTime: '' });
            this.pgPool.connect((err, client, release) => {
                if (err) {
                    logger.log('info', 'FLUSHING ERROR acquiring client ' + err.stack);
                }
                client.query(metricsQuery, (err, result) => {
                    release();
                    if (err) {
                        logger.log('info', 'FLUSHING ERROR executing query ' + metricsQuery + ' ' + err.stack);
                    }
                });
            });
        }
    }
}
exports.RelayProfiler = RelayProfiler;
//# sourceMappingURL=relay-profiler.js.map