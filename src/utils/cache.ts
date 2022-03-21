import { Node } from '@pokt-foundation/pocketjs-types'
import { Redis } from 'ioredis'

const logger = require('../services/logger')

/**
 * Removes node from cached session, following calls within the same session,
 * also cleans the chain/sync check cache to prevent using invalid nodes
 * @param redis cache service to use
 * @param blockchainID blockchain where session resides
 * @param nodes session nodes
 * @param nodePubKey node to remove's public key
 * @returns
 */
export async function removeNodeFromSession(
  redis: Redis,
  sessionkey: string,
  nodes: Node[],
  nodePubKey: string,
  removeChecksFromCache = false,
  requestID?: string,
  blockchainID?: string
): Promise<void> {
  const sessionKey = `session-key-${sessionkey}`

  await redis.sadd(sessionKey, nodePubKey)
  const nodesToRemoveTTL = await redis.ttl(sessionKey)

  if (nodesToRemoveTTL < 0) {
    await redis.expire(sessionKey, 3600) // 1 hour
  }

  /*
  RE-ENABLE LOGS to check which nodes are getting removed
  */
  logger.log('warn', 'Exhausted node removed', {
    sessionKey,
    serviceNode: nodePubKey,
    requestID,
    blockchainID,
  })

  if (removeChecksFromCache) {
    await removeChecksCache(redis, sessionKey, nodes)
  }
}

export async function removeSessionCache(redis: Redis, publicKey: string, blockchainID: string): Promise<void> {
  await redis.del(`session-cached-${publicKey}-${blockchainID}`)
}

export async function removeChecksCache(redis: Redis, sessionKey: string, nodes: Node[]) {
  await redis.del(`sync-check-${sessionKey}`)
  await redis.del(`chain-check-${sessionKey}`)
}
