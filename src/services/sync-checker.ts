import { Relayer } from '@pokt-foundation/pocketjs-relayer'
import { Session, Node } from '@pokt-foundation/pocketjs-types'
import axios from 'axios'
import { Redis } from 'ioredis'
import { Configuration, PocketAAT } from '@pokt-network/pocket-js'
import { MetricsRecorder } from '../services/metrics-recorder'
import { blockHexToDecimal } from '../utils/block'
import { removeNodeFromSession, getNodeNetworkData } from '../utils/cache'
import { MAX_RELAYS_ERROR } from '../utils/constants'
import { checkEnforcementJSON } from '../utils/enforcements'
import { hashBlockchainNodes } from '../utils/helpers'
import { CheckResult } from '../utils/types'

const logger = require('../services/logger')

export class SyncChecker {
  redis: Redis
  metricsRecorder: MetricsRecorder
  defaultSyncAllowance: number
  origin: string

  constructor(redis: Redis, metricsRecorder: MetricsRecorder, defaultSyncAllowance: number, origin: string) {
    this.redis = redis
    this.metricsRecorder = metricsRecorder
    this.defaultSyncAllowance = defaultSyncAllowance
    this.origin = origin
  }

  async consensusFilter({
    nodes,
    requestID,
    syncCheckOptions,
    blockchainID,
    blockchainSyncBackup,
    applicationID,
    applicationPublicKey,
    relayer,
    pocketAAT,
    pocketConfiguration,
    session,
  }: ConsensusFilterOptions): Promise<CheckResult> {
    // Blockchain records passed in with 0 sync allowance are missing the 'syncAllowance' field in MongoDB
    const syncAllowance = syncCheckOptions.allowance > 0 ? syncCheckOptions.allowance : this.defaultSyncAllowance

    const sessionHash = await hashBlockchainNodes(blockchainID, session.nodes, this.redis)

    const syncedNodes: Node[] = []
    let syncedNodesList: string[] = []

    // Value is an array of node public keys that have passed sync checks for this session in the past 5 minutes
    const syncedNodesKey = `sync-check-${sessionHash}`
    const syncedNodesCached = await this.redis.get(syncedNodesKey)

    const cached = Boolean(syncedNodesCached)

    if (cached) {
      syncedNodesList = JSON.parse(syncedNodesCached)
      for (const node of nodes) {
        if (syncedNodesList.includes(node.publicKey)) {
          syncedNodes.push(node)
        }
      }
      // logger.log('info', 'SYNC CHECK CACHE: ' + syncedNodes.length + ' nodes returned');
      return { nodes: syncedNodes, cached }
    }

    // Cache is stale, start a new cache fill
    // First check cache lock key; if lock key exists, return full node set
    const syncLock = await this.redis.get('lock-' + syncedNodesKey)

    if (syncLock) {
      return { nodes, cached }
    } else {
      // Set lock as this thread checks the sync with 60 second ttl.
      // If any major errors happen below, it will retry the sync check every 60 seconds.
      await this.redis.set('lock-' + syncedNodesKey, 'true', 'EX', 60)
    }

    // Fires all 5 sync checks synchronously then assembles the results
    const nodeSyncLogs = await this.getNodeSyncLogs(
      nodes,
      requestID,
      syncCheckOptions,
      blockchainID,
      applicationID,
      applicationPublicKey,
      relayer,
      pocketAAT,
      pocketConfiguration,
      sessionHash,
      session
    )

    let errorState = false

    // This should never happen
    if (nodes.length > 2 && nodeSyncLogs.length <= 2) {
      logger.log('error', 'SYNC CHECK ERROR: fewer than 3 nodes returned sync', {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: '',
        error: '',
        elapsedTime: '',
        origin: this.origin,
        sessionHash,
      })
      errorState = true
    }

    let highestNodeBlockHeight = 0

    // Sort NodeSyncLogs by blockHeight
    nodeSyncLogs.sort((a, b) => b.blockHeight - a.blockHeight)

    // If top node is still 0, or not a number, return all nodes due to check failure
    if (
      nodeSyncLogs.length === 0 ||
      nodeSyncLogs[0].blockHeight === 0 ||
      typeof nodeSyncLogs[0].blockHeight !== 'number' ||
      nodeSyncLogs[0].blockHeight % 1 !== 0
    ) {
      logger.log('error', 'SYNC CHECK ERROR: top synced node result is invalid ' + JSON.stringify(nodeSyncLogs), {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: '',
        error: '',
        elapsedTime: '',
        origin: this.origin,
        sessionHash,
      })
      errorState = true
    } else {
      highestNodeBlockHeight = nodeSyncLogs[0].blockHeight
    }

    // If there's at least three nodes, make sure at least three of them agree on current highest block to prevent one node
    // from being wildly off
    if (
      !errorState &&
      nodeSyncLogs.length >= 3 &&
      nodeSyncLogs[0].blockHeight > nodeSyncLogs[1].blockHeight + syncAllowance &&
      nodeSyncLogs[0].blockHeight > nodeSyncLogs[2].blockHeight + syncAllowance
    ) {
      logger.log('error', 'SYNC CHECK ERROR: three highest nodes could not agree on sync', {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: '',
        error: '',
        elapsedTime: '',
        origin: this.origin,
        sessionHash,
      })
      errorState = true
    }

    let isAltruistTrustworthy: boolean

    // Consult altruist for sync source of truth
    let altruistBlockHeight = await this.getSyncFromAltruist(syncCheckOptions, blockchainSyncBackup)

    if (altruistBlockHeight === 0 || isNaN(altruistBlockHeight)) {
      // Failure to find sync from consensus and altruist
      logger.log('info', 'SYNC CHECK ALTRUIST FAILURE: ' + altruistBlockHeight, {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: 'ALTRUIST',
        error: '',
        elapsedTime: '',
        origin: this.origin,
        sessionHash,
      })

      if (errorState) {
        return { nodes, cached }
      }
    } else {
      logger.log('info', 'SYNC CHECK ALTRUIST CHECK: ' + altruistBlockHeight, {
        requestID: requestID,
        relayType: '',
        blockchainID,
        typeID: '',
        serviceNode: 'ALTRUIST',
        error: '',
        elapsedTime: '',
        origin: this.origin,
        sessionHash,
      })

      // If altruist height > 0, get the percent of nodes above altruist's block height
      const nodesAheadAltruist = this.nodesAheadAltruist(altruistBlockHeight, nodeSyncLogs)

      // Altruist needs to be ahead of more than 80% of the nodes
      // to be considered trustworthy
      isAltruistTrustworthy = !(nodesAheadAltruist > 0.8)

      if (!isAltruistTrustworthy) {
        logger.log(
          'info',
          `SYNC CHECK ALTRUIST FAILURE: ${nodesAheadAltruist * 100}% of the synced nodes are ahead of altruist`,
          {
            requestID: requestID,
            relayType: '',
            blockchainID,
            typeID: '',
            serviceNode: 'ALTRUIST',
            error: '',
            elapsedTime: '',
            origin: this.origin,
            sessionHash,
          }
        )

        // Since we don't trust altruist, let's overwrite its block height
        altruistBlockHeight = highestNodeBlockHeight
      }
    }

    const isBlockHeightTooFar = highestNodeBlockHeight > altruistBlockHeight + syncAllowance

    // If altruist is trustworthy...
    // Make sure nodes aren't running too far ahead of altruist
    if (isAltruistTrustworthy && isBlockHeightTooFar) {
      highestNodeBlockHeight = altruistBlockHeight
    }

    // Go through nodes and add all nodes that are current or within allowance -- this allows for block processing times
    for (const nodeSyncLog of nodeSyncLogs) {
      const relayStart = process.hrtime()

      // Record the node's blockheight with the allowed variance
      const correctedNodeBlockHeight = nodeSyncLog.blockHeight + syncAllowance

      // This allows for nodes to be slightly ahead but within allowance
      const maximumBlockHeight = isAltruistTrustworthy
        ? altruistBlockHeight + syncAllowance
        : highestNodeBlockHeight + syncAllowance

      const { serviceURL, serviceDomain } = await getNodeNetworkData(this.redis, nodeSyncLog.node.publicKey, requestID)

      if (
        nodeSyncLog.blockHeight <= maximumBlockHeight &&
        correctedNodeBlockHeight >= highestNodeBlockHeight &&
        correctedNodeBlockHeight >= altruistBlockHeight
      ) {
        logger.log(
          'info',
          'SYNC CHECK IN-SYNC: ' + nodeSyncLog.node.publicKey + ' height: ' + nodeSyncLog.blockHeight,
          {
            requestID: requestID,
            relayType: '',
            blockchainID,
            typeID: '',
            serviceNode: nodeSyncLog.node.publicKey,
            error: '',
            elapsedTime: '',
            origin: this.origin,
            serviceURL,
            serviceDomain,
            sessionHash,
          }
        )

        // Erase failure mark
        await this.redis.set(
          blockchainID + '-' + nodeSyncLog.node.publicKey + '-failure',
          'false',
          'EX',
          60 * 60 * 24 * 30
        )

        // In-sync: add to nodes list
        syncedNodes.push(nodeSyncLog.node)
        syncedNodesList.push(nodeSyncLog.node.publicKey)
      } else {
        logger.log('info', 'SYNC CHECK BEHIND: ' + nodeSyncLog.node.publicKey + ' height: ' + nodeSyncLog.blockHeight, {
          requestID: requestID,
          relayType: '',
          blockchainID,
          typeID: '',
          serviceNode: nodeSyncLog.node.publicKey,
          error: '',
          elapsedTime: '',
          origin: this.origin,
          serviceURL,
          serviceDomain,
          sessionHash,
        })

        this.metricsRecorder
          .recordMetric({
            requestID: requestID,
            applicationID: applicationID,
            applicationPublicKey: applicationPublicKey,
            blockchainID,
            serviceNode: nodeSyncLog.node.publicKey,
            relayStart,
            result: 500,
            bytes: Buffer.byteLength('OUT OF SYNC', 'utf8'),
            fallback: false,
            method: 'synccheck',
            error: `OUT OF SYNC: current block height on chain ${blockchainID}: ${highestNodeBlockHeight} - altruist block height: ${altruistBlockHeight} - nodes height: ${nodeSyncLog.blockHeight} - sync allowance: ${syncAllowance}`,
            code: undefined,
            origin: this.origin,
            data: undefined,
            pocketSession: undefined,
          })
          .catch(function log(e) {
            logger.log('error', 'Error recording metrics: ' + e, {
              requestID: requestID,
              relayType: 'APP',
              typeID: applicationID,
              serviceNode: nodeSyncLog.node.publicKey,
            })
          })
      }
    }

    logger.log('info', 'SYNC CHECK COMPLETE: ' + syncedNodes.length + ' nodes in sync', {
      requestID: requestID,
      relayType: '',
      typeID: '',
      serviceNode: '',
      error: '',
      elapsedTime: '',
      blockchainID,
      origin: this.origin,
      sessionHash,
    })
    await this.redis.set(
      syncedNodesKey,
      JSON.stringify(syncedNodesList),
      'EX',
      syncedNodes.length > 0 ? 300 : 30 // will retry sync check every 30 seconds if no nodes are in sync
    )

    // TODO: Implement consensus challenge
    // If one or more nodes of this session are not in sync, fire a consensus relay with the same check.
    // This will penalize the out-of-sync nodes and cause them to get slashed for reporting incorrect data.

    return { nodes: syncedNodes, cached }
  }

  async getSyncFromAltruist(syncCheckOptions: SyncCheckOptions, blockchainSyncBackup: string): Promise<number> {
    // Remove user/pass from the altruist URL
    const redactedAltruistURL = blockchainSyncBackup.replace(/[\w]*:\/\/[^\/]*@/g, '')
    const syncCheckPath = syncCheckOptions.path ? syncCheckOptions.path : ''

    try {
      const syncResponse = await axios({
        method: 'POST',
        url: `${blockchainSyncBackup}${syncCheckPath}`,
        data: syncCheckOptions.body,
        headers: { 'Content-Type': 'application/json' },
      })

      if (!(syncResponse instanceof Error)) {
        const payload = syncResponse.data // object that includes 'resultKey'
        const blockHeight = this.parseBlockFromPayload(payload, syncCheckOptions.resultKey)

        return blockHeight
      }
      return 0
    } catch (e) {
      logger.log('error', e.message, {
        requestID: '',
        relayType: 'FALLBACK',
        typeID: '',
        serviceNode: 'fallback:' + redactedAltruistURL,
        error: '',
        elapsedTime: '',
        origin: this.origin,
      })
    }
    return 0
  }

  async getNodeSyncLogs(
    nodes: Node[],
    requestID: string,
    syncCheckOptions: SyncCheckOptions,
    blockchainID: string,
    applicationID: string,
    applicationPublicKey: string,
    relayer: Relayer,
    pocketAAT: PocketAAT,
    pocketConfiguration: Configuration,
    sessionHash: string,
    pocketSession: Session
  ): Promise<NodeSyncLog[]> {
    const nodeSyncLogs: NodeSyncLog[] = []
    const promiseStack: Promise<NodeSyncLog>[] = []

    // Set to junk values first so that the Promise stack can fill them later
    const rawNodeSyncLogs: NodeSyncLog[] = [
      <NodeSyncLog>{},
      <NodeSyncLog>{},
      <NodeSyncLog>{},
      <NodeSyncLog>{},
      <NodeSyncLog>{},
    ]

    for (const node of nodes) {
      promiseStack.push(
        this.getNodeSyncLog(
          node,
          requestID,
          syncCheckOptions,
          blockchainID,
          applicationID,
          applicationPublicKey,
          relayer,
          pocketAAT,
          pocketConfiguration,
          sessionHash,
          pocketSession
        )
      )
    }

    ;[
      rawNodeSyncLogs[0],
      rawNodeSyncLogs[1],
      rawNodeSyncLogs[2],
      rawNodeSyncLogs[3],
      rawNodeSyncLogs[4],
      rawNodeSyncLogs[5],
      rawNodeSyncLogs[6],
      rawNodeSyncLogs[7],
      rawNodeSyncLogs[8],
      rawNodeSyncLogs[9],
      rawNodeSyncLogs[10],
      rawNodeSyncLogs[11],
      rawNodeSyncLogs[12],
      rawNodeSyncLogs[13],
      rawNodeSyncLogs[14],
      rawNodeSyncLogs[15],
      rawNodeSyncLogs[16],
      rawNodeSyncLogs[17],
      rawNodeSyncLogs[18],
      rawNodeSyncLogs[19],
      rawNodeSyncLogs[20],
      rawNodeSyncLogs[21],
      rawNodeSyncLogs[22],
      rawNodeSyncLogs[23],
    ] = await Promise.all(promiseStack)

    for (const rawNodeSyncLog of rawNodeSyncLogs) {
      if (typeof rawNodeSyncLog === 'object' && rawNodeSyncLog?.blockHeight > 0) {
        nodeSyncLogs.push(rawNodeSyncLog)
      }
    }
    return nodeSyncLogs
  }

  async getNodeSyncLog(
    node: Node,
    requestID: string,
    syncCheckOptions: SyncCheckOptions,
    blockchainID: string,
    applicationID: string,
    applicationPublicKey: string,
    relayer: Relayer,
    pocketAAT: PocketAAT,
    pocketConfiguration: Configuration,
    sessionHash: string,
    session?: Session
  ): Promise<NodeSyncLog> {
    const { nodes: sessionNodes } = session || {}
    // Pull the current block from each node using the blockchain's syncCheck as the relay
    const relayStart = process.hrtime()

    let relayResponse: string | Error

    // TODO: Refactor try/catch to go with current flow
    try {
      relayResponse = await relayer.relay({
        data: syncCheckOptions.body,
        blockchain: blockchainID,
        pocketAAT,
        session,
      })
    } catch (error) {
      relayResponse = error
    }

    // console.log(" ---- SYNC CHECK RESPONSE ---")
    // console.log(relayResponse)
    // console.log(" ---- END OF SYNC CHECK RESPONSE ---")

    const { serviceURL, serviceDomain } = await getNodeNetworkData(this.redis, node.publicKey, requestID)

    if (!(relayResponse instanceof Error) && checkEnforcementJSON(relayResponse)) {
      const payload = JSON.parse(relayResponse) // object that may not include 'resultKey'

      const blockHeight = this.parseBlockFromPayload(payload, syncCheckOptions.resultKey)

      // Create a NodeSyncLog for each node with current block
      const nodeSyncLog = {
        node: node,
        blockchainID,
        blockHeight,
      } as NodeSyncLog

      logger.log('info', 'SYNC CHECK RESULT: ' + JSON.stringify(nodeSyncLog), {
        requestID: requestID,
        relayType: '',
        typeID: '',
        serviceNode: node.publicKey,
        error: '',
        elapsedTime: '',
        blockchainID,
        origin: this.origin,
        serviceURL,
        serviceDomain,
        sessionHash,
      })
      // Success
      return nodeSyncLog
    } else if (relayResponse instanceof Error) {
      logger.log('error', 'SYNC CHECK ERROR: ' + JSON.stringify(relayResponse), {
        requestID: requestID,
        relayType: '',
        typeID: '',
        serviceNode: node.publicKey,
        error: '',
        elapsedTime: '',
        blockchainID,
        origin: this.origin,
        serviceURL,
        serviceDomain,
        sessionHash,
      })

      let error = relayResponse.message

      if (error === MAX_RELAYS_ERROR) {
        await removeNodeFromSession(this.redis, blockchainID, sessionNodes, node.publicKey)
      }

      if (typeof relayResponse.message === 'object') {
        error = JSON.stringify(relayResponse.message)
      }

      this.metricsRecorder
        .recordMetric({
          requestID: requestID,
          applicationID: applicationID,
          applicationPublicKey: applicationPublicKey,
          blockchainID,
          serviceNode: node.publicKey,
          relayStart,
          result: 500,
          bytes: Buffer.byteLength(relayResponse.message, 'utf8'),
          fallback: false,
          method: 'synccheck',
          error,
          code: undefined,
          origin: this.origin,
          data: undefined,
          pocketSession: undefined,
        })
        .catch(function log(e) {
          logger.log('error', 'Error recording metrics: ' + e, {
            requestID: requestID,
            relayType: 'APP',
            typeID: applicationID,
            serviceNode: node.publicKey,
          })
        })
    } else {
      logger.log('error', 'SYNC CHECK ERROR UNHANDLED: ' + JSON.stringify(relayResponse), {
        requestID: requestID,
        relayType: '',
        typeID: '',
        serviceNode: node.publicKey,
        error: '',
        elapsedTime: '',
        blockchainID,
        origin: this.origin,
        serviceURL,
        serviceDomain,
        sessionHash,
      })

      this.metricsRecorder
        .recordMetric({
          requestID: requestID,
          applicationID: applicationID,
          applicationPublicKey: applicationPublicKey,
          blockchainID,
          serviceNode: node.publicKey,
          relayStart,
          result: 500,
          bytes: Buffer.byteLength('SYNC CHECK', 'utf8'),
          fallback: false,
          method: 'synccheck',
          error: JSON.stringify(relayResponse),
          code: undefined,
          origin: this.origin,
          data: undefined,
          // TODO: Add session again
          pocketSession: undefined,
        })
        .catch(function log(e) {
          logger.log('error', 'Error recording metrics: ' + e, {
            requestID: requestID,
            relayType: 'APP',
            typeID: applicationID,
            serviceNode: node.publicKey,
          })
        })
    }
    // Failed
    const nodeSyncLog = {
      node: node,
      blockchainID,
      blockHeight: 0,
    } as NodeSyncLog

    return nodeSyncLog
  }

  updateConfigurationConsensus(pocketConfiguration: Configuration): Configuration {
    return new Configuration(
      pocketConfiguration.maxDispatchers,
      pocketConfiguration.maxSessions,
      5,
      2000,
      false,
      pocketConfiguration.sessionBlockFrequency,
      pocketConfiguration.blockTime,
      pocketConfiguration.maxSessionRefreshRetries,
      pocketConfiguration.validateRelayResponses,
      pocketConfiguration.rejectSelfSignedCertificates
    )
  }

  updateConfigurationTimeout(pocketConfiguration: Configuration): Configuration {
    return new Configuration(
      pocketConfiguration.maxDispatchers,
      pocketConfiguration.maxSessions,
      pocketConfiguration.consensusNodeCount,
      4000,
      pocketConfiguration.acceptDisputedResponses,
      pocketConfiguration.sessionBlockFrequency,
      pocketConfiguration.blockTime,
      pocketConfiguration.maxSessionRefreshRetries,
      pocketConfiguration.validateRelayResponses,
      pocketConfiguration.rejectSelfSignedCertificates
    )
  }

  // TODO: We might want to support result keys in nested objects
  parseBlockFromPayload(payload: object, syncCheckResultKey: string): number {
    const rawHeight = payload[`${syncCheckResultKey}`] || '0'

    return blockHexToDecimal(rawHeight)
  }

  // Calculates the percentage of nodes that is already of altruist (e.g. 20/24)
  nodesAheadAltruist(altruistBlockHeight: number, nodeSyncLogs: NodeSyncLog[]): number {
    let totalNodesAhead = 0
    let totalNodes = 0

    for (const nodeSyncLog of nodeSyncLogs) {
      if (nodeSyncLog.blockHeight > altruistBlockHeight) {
        totalNodesAhead++
      }

      if (nodeSyncLog.blockHeight > 0) {
        totalNodes++
      }
    }

    return totalNodesAhead / totalNodes
  }
}

type NodeSyncLog = {
  node: Node
  blockchainID: string
  blockHeight: number
}

export interface SyncCheckOptions {
  path?: string
  body: string
  resultKey: string
  allowance?: number
}

export type ConsensusFilterOptions = {
  nodes: Node[]
  requestID: string
  syncCheckOptions: SyncCheckOptions
  blockchainID: string
  blockchainSyncBackup: string
  applicationID: string
  applicationPublicKey: string
  relayer: Relayer
  pocketAAT: PocketAAT
  pocketConfiguration: Configuration
  session: Session
}
