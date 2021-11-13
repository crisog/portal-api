import axios, { AxiosRequestConfig, Method } from 'axios'
import { Redis } from 'ioredis'
import { JSONObject } from '@loopback/context'
import { HttpErrors } from '@loopback/rest'
import { PocketAAT, Session, RelayResponse, Pocket, Configuration, HTTPMethod, Node } from '@pokt-network/pocket-js'
import AatPlans from '../config/aat-plans.json'
import { RelayError } from '../errors/types'
import { Applications } from '../models'
import { BlockchainsRepository } from '../repositories'
import { CherryPicker } from '../services/cherry-picker'
import { MetricsRecorder } from '../services/metrics-recorder'
import { removeNodeFromSession } from '../utils/cache'
import { MAX_RELAYS_ERROR } from '../utils/constants'
import {
  checkEnforcementJSON,
  isRelayError,
  isUserError,
  checkWhitelist,
  checkSecretKey,
  SecretKeyDetails,
} from '../utils/enforcements'
import { hashBlockchainNodes } from '../utils/helpers'
import { parseMethod } from '../utils/parsing'
import { updateConfiguration } from '../utils/pocket'
import { filterCheckedNodes, isCheckPromiseResolved, loadBlockchain } from '../utils/relayer'
import { SendRelayOptions } from '../utils/types'
import { PocketChainChecker } from './chain-checker-new'
import { enforceEVMLimits } from './limiter'
import { PocketSyncChecker, SyncCheckOptions } from './sync-checker-new'
const logger = require('../services/logger')

export class PocketRelayer {
  host: string
  origin: string
  userAgent: string
  pocket: Pocket
  pocketConfiguration: Configuration
  cherryPicker: CherryPicker
  metricsRecorder: MetricsRecorder
  syncChecker: PocketSyncChecker
  chainChecker: PocketChainChecker
  redis: Redis
  databaseEncryptionKey: string
  secretKey: string
  relayRetries: number
  blockchainsRepository: BlockchainsRepository
  checkDebug: boolean
  altruists: JSONObject
  aatPlan: string
  defaultLogLimitBlocks: number
  pocketSession: Session
  alwaysRedirectToAltruists: boolean

  constructor({
    host,
    origin,
    userAgent,
    pocket,
    pocketConfiguration,
    cherryPicker,
    metricsRecorder,
    syncChecker,
    chainChecker,
    redis,
    databaseEncryptionKey,
    secretKey,
    relayRetries,
    blockchainsRepository,
    checkDebug,
    altruists,
    aatPlan,
    defaultLogLimitBlocks,
    alwaysRedirectToAltruists = false,
  }: {
    host: string
    origin: string
    userAgent: string
    pocket: Pocket
    pocketConfiguration: Configuration
    cherryPicker: CherryPicker
    metricsRecorder: MetricsRecorder
    syncChecker: PocketSyncChecker
    chainChecker: PocketChainChecker
    redis: Redis
    databaseEncryptionKey: string
    secretKey: string
    relayRetries: number
    blockchainsRepository: BlockchainsRepository
    checkDebug: boolean
    altruists: string
    aatPlan: string
    defaultLogLimitBlocks: number
    alwaysRedirectToAltruists?: boolean
  }) {
    this.host = host
    this.origin = origin
    this.userAgent = userAgent
    this.pocket = pocket
    this.pocketConfiguration = pocketConfiguration
    this.cherryPicker = cherryPicker
    this.metricsRecorder = metricsRecorder
    this.syncChecker = syncChecker
    this.chainChecker = chainChecker
    this.redis = redis
    this.databaseEncryptionKey = databaseEncryptionKey
    this.secretKey = secretKey
    this.relayRetries = relayRetries
    this.blockchainsRepository = blockchainsRepository
    this.checkDebug = checkDebug
    this.aatPlan = aatPlan
    this.defaultLogLimitBlocks = defaultLogLimitBlocks
    this.alwaysRedirectToAltruists = alwaysRedirectToAltruists

    // Create the array of altruist relayers as last resort
    this.altruists = JSON.parse(altruists)
  }

  async sendRelay({
    rawData,
    relayPath,
    httpMethod,
    application,
    requestID,
    requestTimeOut,
    overallTimeOut,
    relayRetries,
    logLimitBlocks,
  }: SendRelayOptions): Promise<string | Error> {
    if (relayRetries !== undefined && relayRetries >= 0) {
      this.relayRetries = relayRetries
    }
    const {
      blockchain,
      blockchainEnforceResult,
      blockchainSyncCheck,
      blockchainIDCheck,
      blockchainID,
      blockchainChainID,
      blockchainLogLimitBlocks,
    } = await loadBlockchain(this.host, this.redis, this.blockchainsRepository, this.defaultLogLimitBlocks).catch(
      () => {
        logger.log('error', `Incorrect blockchain: ${this.host}`, {
          origin: this.origin,
        })
        throw new HttpErrors.BadRequest(`Incorrect blockchain: ${this.host}`)
      }
    )
    const overallStart = process.hrtime()

    // Check for lb-specific log limits
    if (logLimitBlocks === undefined || logLimitBlocks <= 0) {
      logLimitBlocks = blockchainLogLimitBlocks
    }

    // This converts the raw data into formatted JSON then back to a string for relaying.
    // This allows us to take in both [{},{}] arrays of JSON and plain JSON and removes
    // extraneous characters like newlines and tabs from the rawData.
    // Normally the arrays of JSON do not pass the AJV validation used by Loopback.

    const parsedRawData = Object.keys(rawData).length > 0 ? JSON.parse(rawData.toString()) : JSON.stringify(rawData)
    const limitation = await this.enforceLimits(parsedRawData, blockchainID, logLimitBlocks)
    const data = JSON.stringify(parsedRawData)

    if (limitation instanceof Error) {
      logger.log('error', `LIMITATION ERROR ${blockchainID} req: ${data}`, {
        blockchainID,
        requestID: requestID,
        relayType: 'APP',
        error: `${parsedRawData.method} method limitations exceeded.`,
        typeID: application.id,
        serviceNode: '',
        origin: this.origin,
      })
      return limitation
    }
    const method = parseMethod(parsedRawData)
    const fallbackAvailable = this.altruists[blockchainID] !== undefined ? true : false

    try {
      if (!this.alwaysRedirectToAltruists) {
        // Retries if applicable
        for (let x = 0; x <= this.relayRetries; x++) {
          const relayStart = process.hrtime()

          // Compute the overall time taken on this LB request
          const overallCurrent = process.hrtime(overallStart)
          const overallCurrentElasped = Math.round((overallCurrent[0] * 1e9 + overallCurrent[1]) / 1e6)

          if (overallTimeOut && overallCurrentElasped > overallTimeOut) {
            logger.log('error', 'Overall Timeout exceeded: ' + overallTimeOut, {
              requestID: requestID,
              relayType: 'APP',
              typeID: application.id,
              serviceNode: '',
            })
            return new HttpErrors.GatewayTimeout('Overall Timeout exceeded: ' + overallTimeOut)
          }

          // Send this relay attempt
          const relayResponse = await this._sendRelay({
            data,
            relayPath,
            httpMethod,
            requestID,
            application,
            requestTimeOut,
            blockchain,
            blockchainID,
            blockchainEnforceResult,
            blockchainSyncCheck,
            blockchainIDCheck,
            blockchainChainID,
            blockchainSyncBackup: String(this.altruists[blockchainID]),
          })

          if (!(relayResponse instanceof Error)) {
            // Record success metric
            this.metricsRecorder
              .recordMetric({
                requestID: requestID,
                applicationID: application.id,
                applicationPublicKey: application.gatewayAAT.applicationPublicKey,
                blockchainID,
                serviceNode: relayResponse.proof.servicerPubKey,
                relayStart,
                result: 200,
                bytes: Buffer.byteLength(relayResponse.payload, 'utf8'),
                delivered: false,
                fallback: false,
                method: method,
                error: undefined,
                origin: this.origin,
                data,
                pocketSession: this.pocketSession,
              })
              .catch(function log(e) {
                logger.log('error', 'Error recording metrics: ' + e, {
                  requestID: requestID,
                  relayType: 'APP',
                  typeID: application.id,
                  serviceNode: relayResponse.proof.servicerPubKey,
                })
              })

            // Clear error log
            await this.redis.del(blockchainID + '-' + relayResponse.proof.servicerPubKey + '-errors')

            // If return payload is valid JSON, turn it into an object so it is sent with content-type: json
            if (
              blockchainEnforceResult && // Is this blockchain marked for result enforcement // and
              blockchainEnforceResult.toLowerCase() === 'json' // the check is for JSON
            ) {
              return JSON.parse(relayResponse.payload)
            }
            return relayResponse.payload
          } else if (relayResponse instanceof RelayError) {
            // Record failure metric, retry if possible or fallback
            // If this is the last retry and fallback is available, mark the error not delivered
            const errorDelivered = x === this.relayRetries && fallbackAvailable ? false : true

            // Increment error log
            await this.redis.incr(blockchainID + '-' + relayResponse.servicer_node + '-errors')
            await this.redis.expire(blockchainID + '-' + relayResponse.servicer_node + '-errors', 3600)

            let error = relayResponse.message

            if (typeof relayResponse.message === 'object') {
              error = JSON.stringify(relayResponse.message)
            }

            this.metricsRecorder
              .recordMetric({
                requestID,
                applicationID: application.id,
                applicationPublicKey: application.gatewayAAT.applicationPublicKey,
                blockchainID,
                serviceNode: relayResponse.servicer_node,
                relayStart,
                result: 500,
                bytes: Buffer.byteLength(relayResponse.message, 'utf8'),
                delivered: errorDelivered,
                fallback: false,
                method,
                error,
                origin: this.origin,
                data,
                pocketSession: this.pocketSession,
              })
              .catch(function log(e) {
                logger.log('error', 'Error recording metrics: ' + e, {
                  requestID: requestID,
                  relayType: 'APP',
                  typeID: application.id,
                  serviceNode: relayResponse.servicer_node,
                })
              })
          }
        }
      }
    } catch (e) {
      // Explicit Http errors should be propagated so they can be sent as a response
      if (HttpErrors.isHttpError(e)) {
        throw e
      }

      logger.log('error', 'ERROR relaying through node: ' + e, {
        requestID,
        relayType: 'APP',
        typeID: application.id,
        error: e,
        serviceNode: '',
      })
    }

    // Exhausted network relay attempts; use fallback
    if (fallbackAvailable) {
      const relayStart = process.hrtime()
      let axiosConfig: AxiosRequestConfig = {}

      // Add relay path to URL
      const altruistURL =
        relayPath === undefined || relayPath === ''
          ? (this.altruists[blockchainID] as string)
          : `${this.altruists[blockchainID]}${relayPath}`

      // Remove user/pass from the altruist URL
      const redactedAltruistURL = String(this.altruists[blockchainID])?.replace(/[\w]*:\/\/[^\/]*@/g, '')

      if (httpMethod === 'POST') {
        axiosConfig = {
          method: 'POST',
          url: altruistURL,
          data: rawData.toString(),
          headers: { 'Content-Type': 'application/json' },
        }
      } else {
        axiosConfig = {
          method: httpMethod as Method,
          url: altruistURL,
          data: rawData.toString(),
        }
      }

      if (requestTimeOut) {
        axiosConfig.timeout = requestTimeOut
      }

      try {
        const fallbackResponse = await axios(axiosConfig)

        if (this.checkDebug) {
          logger.log('debug', JSON.stringify(fallbackResponse.data), {
            requestID: requestID,
            relayType: 'FALLBACK',
            typeID: application.id,
            serviceNode: 'fallback:' + redactedAltruistURL,
            error: '',
            elapsedTime: '',
            blockchainID: '',
            origin: this.origin,
          })
        }

        if (!(fallbackResponse instanceof Error)) {
          const responseParsed = JSON.stringify(fallbackResponse.data)

          this.metricsRecorder
            .recordMetric({
              requestID: requestID,
              applicationID: application.id,
              applicationPublicKey: application.gatewayAAT.applicationPublicKey,
              blockchainID,
              serviceNode: 'fallback:' + redactedAltruistURL,
              relayStart,
              result: 200,
              bytes: Buffer.byteLength(responseParsed, 'utf8'),
              delivered: false,
              fallback: true,
              method: method,
              error: undefined,
              origin: this.origin,
              data,
              pocketSession: this.pocketSession,
            })
            .catch(function log(e) {
              logger.log('error', 'Error recording metrics: ' + e, {
                requestID: requestID,
                relayType: 'APP',
                typeID: application.id,
                serviceNode: 'fallback:' + redactedAltruistURL,
              })
            })

          // If return payload is valid JSON, turn it into an object so it is sent with content-type: json
          if (
            blockchainEnforceResult && // Is this blockchain marked for result enforcement and
            blockchainEnforceResult.toLowerCase() === 'json' && // the check is for JSON
            typeof responseParsed === 'string' &&
            (responseParsed.match('{') || responseParsed.match(/'\[{'/g)) // and it matches JSON
          ) {
            return JSON.parse(responseParsed)
          }

          return responseParsed
        } else {
          logger.log('error', JSON.stringify(fallbackResponse), {
            requestID: requestID,
            relayType: 'FALLBACK',
            typeID: application.id,
            serviceNode: 'fallback:' + redactedAltruistURL,
            blockchainID,
            origin: this.origin,
          })
        }
      } catch (e) {
        logger.log('error', e.message, {
          requestID: requestID,
          relayType: 'FALLBACK',
          typeID: application.id,
          serviceNode: 'fallback:' + redactedAltruistURL,
          blockchainID,
          origin: this.origin,
        })
      }
    }
    return new HttpErrors.GatewayTimeout('Relay attempts exhausted')
  }

  // Private function to allow relay retries
  async _sendRelay({
    data,
    relayPath,
    httpMethod,
    requestID,
    application,
    requestTimeOut,
    blockchain,
    blockchainEnforceResult,
    blockchainSyncCheck,
    blockchainSyncBackup,
    blockchainIDCheck,
    blockchainID,
    blockchainChainID,
  }: {
    data: string
    relayPath: string
    httpMethod: HTTPMethod
    requestID: string
    application: Applications
    requestTimeOut: number | undefined
    blockchain: string
    blockchainEnforceResult: string
    blockchainSyncCheck: SyncCheckOptions
    blockchainSyncBackup: string
    blockchainIDCheck: string
    blockchainID: string
    blockchainChainID: string
  }): Promise<RelayResponse | Error> {
    const secretKeyDetails: SecretKeyDetails = {
      secretKey: this.secretKey,
      databaseEncryptionKey: this.databaseEncryptionKey,
    }

    // Secret key check
    if (!checkSecretKey(application, secretKeyDetails)) {
      throw new HttpErrors.Forbidden('SecretKey does not match')
    }

    // Whitelist: origins -- explicit matches
    if (!checkWhitelist(application.gatewaySettings.whitelistOrigins, this.origin, 'explicit')) {
      throw new HttpErrors.Forbidden('Whitelist Origin check failed: ' + this.origin)
    }

    // Whitelist: userAgent -- substring matches
    if (!checkWhitelist(application.gatewaySettings.whitelistUserAgents, this.userAgent, 'substring')) {
      throw new HttpErrors.Forbidden('Whitelist User Agent check failed: ' + this.userAgent)
    }

    const aatParams: [string, string, string, string] =
      this.aatPlan === AatPlans.FREEMIUM
        ? [
            application.gatewayAAT.version,
            application.freeTierAAT.clientPublicKey,
            application.freeTierAAT.applicationPublicKey,
            application.freeTierAAT.applicationSignature,
          ]
        : [
            application.gatewayAAT.version,
            application.gatewayAAT.clientPublicKey,
            application.gatewayAAT.applicationPublicKey,
            application.gatewayAAT.applicationSignature,
          ]

    // Checks pass; create AAT
    const pocketAAT = new PocketAAT(...aatParams)

    // Pull the session so we can get a list of nodes and cherry pick which one to use
    const pocketSession = await this.pocket.sessionManager.getCurrentSession(
      pocketAAT,
      blockchainID,
      this.updateConfigurationTimeout(this.pocketConfiguration),
      2
    )

    if (pocketSession instanceof Error) {
      logger.log('error', 'ERROR obtaining a session: ' + pocketSession.message, {
        relayType: 'APP',
        typeID: application.id,
        origin: this.origin,
        blockchainID,
        requestID,
      })

      return pocketSession
    }

    // Start the relay timer
    const relayStart = process.hrtime()

    let nodes: Node[] = pocketSession.sessionNodes

    // sessionKey = "blockchain and a hash of the all the nodes in this session, sorted by public key"
    const sessionKey = hashBlockchainNodes(blockchainID, nodes)

    this.pocketSession = pocketSession
    const sessionCacheKey = `session-${sessionKey}`

    const nodesToRemove = await this.redis.smembers(sessionCacheKey)

    if (nodesToRemove.length > 0) {
      nodes = nodes.filter((n) => !nodesToRemove.includes(n.publicKey))
    }

    if (nodes.length === 0) {
      logger.log('warn', `SESSION: ${sessionKey} has exhausted all node relays`, {
        requestID: requestID,
        relayType: 'APP',
        typeID: application.id,
        serviceNode: '',
      })
      return new Error("session doesn't have any available nodes")
    }

    let syncCheckPromise: Promise<Node[]>
    let syncCheckedNodes: Node[]

    let chainCheckPromise: Promise<Node[]>
    let chainCheckedNodes: Node[]

    if (blockchainIDCheck) {
      // Check Chain ID
      chainCheckPromise = this.chainChecker.check(
        nodes,
        blockchainIDCheck,
        parseInt(blockchainChainID),
        blockchainID,
        pocketAAT,
        this.pocketConfiguration,
        pocketSession,
        application.id,
        application.gatewayAAT.applicationPublicKey,
        requestID
      )
    }

    if (blockchainSyncCheck) {
      // Check Sync
      syncCheckPromise = this.syncChecker.check(
        nodes,
        blockchainSyncCheck,
        blockchainID,
        pocketAAT,
        this.pocketConfiguration,
        pocketSession,
        blockchainSyncBackup,
        application.id,
        application.gatewayAAT.applicationPublicKey,
        requestID
      )
    }

    const checkersPromise = Promise.allSettled([chainCheckPromise, syncCheckPromise])

    const [chainCheckResult, syncCheckResult] = await checkersPromise

    if (blockchainIDCheck) {
      if (isCheckPromiseResolved(chainCheckResult)) {
        chainCheckedNodes = (chainCheckResult as PromiseFulfilledResult<Node[]>).value
      } else {
        const error = 'ChainID check failure'
        const method = 'checks'

        this.metricsRecorder
          .recordMetric({
            requestID,
            applicationID: application.id,
            applicationPublicKey: application.gatewayAAT.applicationPublicKey,
            blockchainID,
            serviceNode: 'session-failure',
            relayStart,
            result: 500,
            bytes: Buffer.byteLength(error, 'utf8'),
            delivered: false,
            fallback: false,
            method,
            error,
            origin: this.origin,
            data,
            pocketSession,
          })
          .catch(function log(e) {
            logger.log('error', 'Error recording metrics: ' + e, {
              requestID: requestID,
              relayType: 'APP',
              typeID: application.id,
              serviceNode: 'session-failure',
            })
          })

        return new Error('ChainID check failure; using fallbacks')
      }
    }

    if (blockchainSyncCheck) {
      if (isCheckPromiseResolved(syncCheckResult)) {
        syncCheckedNodes = (syncCheckResult as PromiseFulfilledResult<Node[]>).value
      } else {
        const error = 'Sync check failure'
        const method = 'checks'

        this.metricsRecorder
          .recordMetric({
            requestID,
            applicationID: application.id,
            applicationPublicKey: application.gatewayAAT.applicationPublicKey,
            blockchainID,
            serviceNode: 'session-failure',
            relayStart,
            result: 500,
            bytes: Buffer.byteLength(error, 'utf8'),
            delivered: false,
            fallback: false,
            method,
            error,
            origin: this.origin,
            data,
            pocketSession,
          })
          .catch(function log(e) {
            logger.log('error', 'Error recording metrics: ' + e, {
              requestID: requestID,
              relayType: 'APP',
              typeID: application.id,
              serviceNode: 'session-failure',
            })
          })

        return new Error('Sync check failure; using fallbacks')
      }

      // EVM-chains always have chain/sync checks.
      if (blockchainIDCheck && blockchainSyncCheck) {
        const filteredNodes = filterCheckedNodes(syncCheckedNodes, chainCheckedNodes)

        // There's a chance that no nodes passes both checks.
        if (filteredNodes.length > 0) {
          nodes = filteredNodes
        } else {
          return new Error('Sync / chain check failure; using fallbacks')
        }
      } else if (syncCheckedNodes.length > 0) {
        // For non-EVM chains that only have sync check, like pocket.
        nodes = syncCheckedNodes
      }
    }

    const node = await this.cherryPicker.cherryPickNode(application, nodes, blockchainID, requestID)

    if (this.checkDebug) {
      logger.log('debug', JSON.stringify(pocketSession), {
        requestID: requestID,
        relayType: 'APP',
        typeID: application.id,
        serviceNode: node?.publicKey,
      })
    }

    // Adjust Pocket Configuration for a custom requestTimeOut
    let relayConfiguration = this.pocketConfiguration

    if (requestTimeOut) {
      relayConfiguration = updateConfiguration(this.pocketConfiguration, requestTimeOut)
    }

    // Send relay and process return: RelayResponse, RpcError, ConsensusNode, or undefined
    const relayResponse = await this.pocket.sendRelay(
      data,
      blockchainID,
      pocketAAT,
      relayConfiguration,
      undefined,
      httpMethod,
      relayPath,
      node,
      undefined,
      requestID
    )

    if (this.checkDebug) {
      logger.log('debug', JSON.stringify(relayConfiguration), {
        requestID: requestID,
        relayType: 'APP',
        typeID: application.id,
        serviceNode: node?.publicKey,
      })
      logger.log('debug', JSON.stringify(relayResponse), {
        requestID: requestID,
        relayType: 'APP',
        typeID: application.id,
        serviceNode: node?.publicKey,
      })
    }

    // Success
    if (relayResponse instanceof RelayResponse) {
      // First, check for the format of the result; Pocket Nodes will return relays that include
      // erroneous results like "invalid host specified" when the node is configured incorrectly.
      // Those results are still marked as 200:success.
      // To filter them out, we will enforce result formats on certain blockchains. If the
      // relay result is not in the correct format, this was not a successful relay.
      if (
        blockchainEnforceResult && // Is this blockchain marked for result enforcement // and
        blockchainEnforceResult.toLowerCase() === 'json' && // the check is for JSON // and
        (!checkEnforcementJSON(relayResponse.payload) || // the relay response is not valid JSON // or
          (isRelayError(relayResponse.payload) && !isUserError(relayResponse.payload))) // check if the payload indicates relay error, not a user error
      ) {
        // then this result is invalid
        return new RelayError(relayResponse.payload, 503, relayResponse.proof.servicerPubKey)
      } else {
        // Success
        return relayResponse
      }
      // Error
    } else if (relayResponse instanceof Error) {
      // Remove node from session if error is due to max relays allowed reached
      if (relayResponse.message === MAX_RELAYS_ERROR) {
        await removeNodeFromSession(this.redis, blockchainID, (pocketSession as Session).sessionNodes, node.publicKey)
      }

      return new RelayError(relayResponse.message, 500, node?.publicKey)
      // ConsensusNode
    } else {
      // TODO: ConsensusNode is a possible return
      return new Error('relayResponse is undefined')
    }
  }

  async enforceLimits(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsedRawData: Record<string, any>,
    blockchainID: string,
    logLimitBlocks: number
  ): Promise<void | Error> {
    let limiterResponse: Promise<void | Error>

    if (blockchainID === '0021') {
      limiterResponse = enforceEVMLimits(parsedRawData, blockchainID, logLimitBlocks, this.altruists)
    }

    return limiterResponse
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
}
