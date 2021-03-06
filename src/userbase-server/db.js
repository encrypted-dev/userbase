import uuidv4 from 'uuid/v4'
import connection from './connection'
import setup from './setup'
import statusCodes from './statusCodes'
import responseBuilder from './responseBuilder'
import connections from './ws'
import logger from './logger'
import appController from './app'
import dbController from './db'
import userController from './user'
import peers from './peers'
import {
  lastEvaluatedKeyToNextPageToken,
  nextPageTokenToLastEvaluatedKey,
  getTtl,
  stringToArrayBuffer,
  arrayBufferToString,
  bufferToUint16Array,
} from './utils'
import crypto from './crypto'

const UUID_STRING_LENGTH = 36

const MAX_OPERATIONS_IN_TX = 10

const HOURS_IN_A_DAY = 24
const SECONDS_IN_A_DAY = 60 * 60 * HOURS_IN_A_DAY
const MS_IN_A_DAY = SECONDS_IN_A_DAY * 1000

const VALIDATION_MESSAGE_LENGTH = 16

const MAX_USERS_ALLOWED_FOR_ACCESS_CONTROL = 10

const ONE_KB = 1024
const KB_512 = 512 * ONE_KB

const getS3FileChunkKey = (databaseId, fileId, chunkNumber) => `${databaseId}/${fileId}/${chunkNumber}`
const getS3DbStateChunkKey = (databaseId, bundleSeqNo, bundleId, chunkNo) => `${databaseId}/${bundleSeqNo}/${bundleId}/${chunkNo}`
const getS3DbWritersKey = (databaseId, bundleSeqNo) => `${databaseId}/${bundleSeqNo}/writers`

const _buildUserDatabaseParams = (userId, dbNameHash, dbId, encryptedDbKey, readOnly, resharingAllowed) => {
  return {
    TableName: setup.userDatabaseTableName,
    Item: {
      'user-id': userId,
      'database-name-hash': dbNameHash,
      'database-id': dbId,
      'encrypted-db-key': encryptedDbKey,
      'read-only': readOnly,
      'resharing-allowed': resharingAllowed,
      'creation-date': new Date().toISOString(),
    },
    ConditionExpression: 'attribute_not_exists(#userId)',
    ExpressionAttributeNames: {
      '#userId': 'user-id',
    }
  }
}

const createDatabase = async function (userId, dbNameHash, dbId, encryptedDbName, encryptedDbKey, attribution, plaintextDbKey, fingerprint) {
  try {
    const user = await userController.getUserByUserId(userId)
    if (!user || user['deleted']) throw new Error('UserNotFound')

    const database = {
      'database-id': dbId,
      'owner-id': userId,
      'owner-fingerprint': fingerprint, // if owner changes key, this lets server know the database should no longer be accessible
      'database-name': encryptedDbName,
      'creation-date': new Date().toISOString(),
    }

    if (attribution) database['attribution'] = true
    if (plaintextDbKey) database['plaintext-db-key'] = plaintextDbKey

    const userDatabaseParams = _buildUserDatabaseParams(userId, dbNameHash, dbId, encryptedDbKey)

    const params = {
      TransactItems: [{
        Put: {
          TableName: setup.databaseTableName,
          Item: database,
          ConditionExpression: 'attribute_not_exists(#dbId)',
          ExpressionAttributeNames: {
            '#dbId': 'database-id',
          }
        }
      }, {
        Put: userDatabaseParams
      }]
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.transactWrite(params).promise()

    return { ...database, ...userDatabaseParams.Item }
  } catch (e) {

    if (e.message) {
      if (e.message.includes('UserNotFound')) {
        throw responseBuilder.errorResponse(statusCodes['Conflict'], 'UserNotFound')
      } else if (e.message.includes('ConditionalCheckFailed')) {
        throw responseBuilder.errorResponse(statusCodes['Conflict'], 'Database already exists')
      } else if (e.message.includes('TransactionConflict')) {
        throw responseBuilder.errorResponse(statusCodes['Conflict'], 'Database already creating')
      }
    }

    logger.error(`Failed to create database for user ${userId} with ${e}`)
    throw responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to create database')
  }
}

const findDatabaseByDatabaseId = async function (dbId) {
  const databaseParams = {
    TableName: setup.databaseTableName,
    Key: {
      'database-id': dbId
    }
  }

  const ddbClient = connection.ddbClient()
  const dbResponse = await ddbClient.get(databaseParams).promise()

  if (!dbResponse || !dbResponse.Item) return null
  return dbResponse.Item
}
exports.findDatabaseByDatabaseId = findDatabaseByDatabaseId

const _getUserDatabase = async function (userId, dbNameHash) {
  const userDatabaseParams = {
    TableName: setup.userDatabaseTableName,
    Key: {
      'user-id': userId,
      'database-name-hash': dbNameHash
    }
  }

  const ddbClient = connection.ddbClient()
  const userDbResponse = await ddbClient.get(userDatabaseParams).promise()

  return userDbResponse && userDbResponse.Item
}

const _getUserDatabaseByUserIdAndDatabaseId = async function (userId, databaseId) {
  const params = {
    TableName: setup.userDatabaseTableName,
    IndexName: setup.userDatabaseIdIndex,
    KeyConditionExpression: '#databaseId = :databaseId and #userId = :userId',
    ExpressionAttributeNames: {
      '#databaseId': 'database-id',
      '#userId': 'user-id'
    },
    ExpressionAttributeValues: {
      ':databaseId': databaseId,
      ':userId': userId
    },
    Select: 'ALL_ATTRIBUTES'
  }

  const ddbClient = connection.ddbClient()
  const userDbResponse = await ddbClient.query(params).promise()

  if (!userDbResponse || userDbResponse.Items.length === 0) return null

  if (userDbResponse.Items.length > 1) {
    // this should never happen
    const errorMsg = `Too many user dbs found with database id ${databaseId} and userId ${userId}`
    logger.fatal(errorMsg)
    throw new Error(errorMsg)
  }

  return userDbResponse.Items[0]
}

const getDatabase = async function (userId, dbNameHash) {
  const userDb = await _getUserDatabase(userId, dbNameHash)
  if (!userDb) return null

  const dbId = userDb['database-id']

  const database = await findDatabaseByDatabaseId(dbId)
  if (!database) return null

  return { ...userDb, ...database }
}

exports.openDatabase = async function (logChildObject, user, app, admin, connectionId, dbNameHash, newDatabaseParams, reopenAtSeqNo) {
  try {
    if (!dbNameHash) return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing database name hash')
    if (reopenAtSeqNo && typeof reopenAtSeqNo !== 'number') return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Reopen at seq no must be number')
    const userId = user['user-id']

    logChildObject.dbNameHash = dbNameHash
    logChildObject.reopenAtSeqNo = reopenAtSeqNo
    logger.child(logChildObject).info('Opening database by name')

    try {
      userController.validatePayment(user, app, admin)
    } catch (e) {
      return responseBuilder.errorResponse(e.status, e.error)
    }

    let database
    try {
      database = await getDatabase(userId, dbNameHash)

      if (database && database['owner-id'] !== userId) return responseBuilder.errorResponse(statusCodes['Forbidden'], 'Database not owned by user')

      if (!database && !newDatabaseParams) return responseBuilder.errorResponse(statusCodes['Not Found'], 'Database not found')
      else if (!database) {
        // attempt to create new database
        const { dbId, encryptedDbName, encryptedDbKey, attribution, plaintextDbKey, fingerprint } = newDatabaseParams
        if (!dbId) return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing database id')
        if (!encryptedDbName) return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing database name')
        if (!encryptedDbKey) return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing database key')

        database = await createDatabase(userId, dbNameHash, dbId, encryptedDbName, encryptedDbKey, attribution, plaintextDbKey, fingerprint)
      }
    } catch (e) {
      if (e.data === 'Database already exists' || e.data === 'Database already creating') {
        // User must have made a concurrent request to open db with same name for the first time.
        // Can safely reattempt to get the database
        database = await getDatabase(userId, dbNameHash)
      }
      else return responseBuilder.errorResponse(e.status, e.data)
    }
    if (!database) return responseBuilder.errorResponse(statusCodes['Not Found'], 'Database not found')

    const databaseId = database['database-id']
    const bundleSeqNo = database['bundle-seq-no']
    const bundleId = database['bundle-id']
    const numChunks = database['num-chunks']
    const encryptedBundleEncryptionKey = database['encrypted-bundle-encryption-key']
    const dbKey = database['encrypted-db-key']
    const attribution = database['attribution']
    const plaintextDbKey = database['plaintext-db-key']

    logChildObject.databaseId = databaseId
    logChildObject.bundleSeqNo = bundleSeqNo
    logChildObject.numChunks = numChunks

    const isOwner = true
    const ownerId = userId
    if (connections.openDatabase({
      userId, connectionId, databaseId, bundleSeqNo, bundleId, numChunks, encryptedBundleEncryptionKey,
      dbNameHash, dbKey, reopenAtSeqNo, isOwner, ownerId, attribution, plaintextDbKey
    })) {
      return responseBuilder.successResponse('Success!')
    } else {
      throw new Error('Unable to open database')
    }
  } catch (e) {
    logChildObject.err = e
    logChildObject.status = statusCodes['Internal Server Error']
    logger.child(logChildObject).error('Failed to open database by name')
    return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to open database')
  }
}

const _validateAuthTokenSignature = (userId, database, validationMessage, signedValidationMessage) => {
  const shareTokenReadWritePermissions = connections.getShareTokenReadWritePermissionsFromCache(userId, validationMessage)
  if (!shareTokenReadWritePermissions) throw {
    status: statusCodes['Unauthorized'],
    error: 'RequestExpired'
  }

  const shareTokenPublicKey = database['share-token-public-key-' + shareTokenReadWritePermissions]
  if (!crypto.ecdsa.verify(Buffer.from(validationMessage, 'base64'), shareTokenPublicKey, signedValidationMessage)) throw {
    status: statusCodes['Unauthorized'],
    error: 'ShareTokenInvalid'
  }

  return shareTokenReadWritePermissions
}

exports.openDatabaseByDatabaseId = async function (logChildObject, userAtSignIn, app, admin, connectionId, databaseId, validationMessage, signedValidationMessage, reopenAtSeqNo) {
  let userId
  try {
    if (!databaseId) throw { status: statusCodes['Bad Request'], error: 'Missing database ID' }
    if (reopenAtSeqNo && typeof reopenAtSeqNo !== 'number') throw { status: statusCodes['Bad Request'], error: 'Reopen at seq no must be number' }
    userId = userAtSignIn['user-id']

    logChildObject.databaseId = databaseId
    logChildObject.reopenAtSeqNo = reopenAtSeqNo
    logger.child(logChildObject).info('Opening database by database ID')

    userController.validatePayment(userAtSignIn, app, admin)

    const [db, userDb, user] = await Promise.all([
      findDatabaseByDatabaseId(databaseId),
      _getUserDatabaseByUserIdAndDatabaseId(userId, databaseId),
      userController.getUserByUserId(userId),
    ])

    if (!db || !user || (!userDb && !validationMessage)) throw { status: statusCodes['Not Found'], error: 'Database not found' }

    // Not allowing developers to use databaseId's to interact with databases owned by the user keeps the current concurrency model safe.
    const isOwner = db['owner-id'] === userId
    if (isOwner) throw { status: statusCodes['Forbidden'], error: 'Database is owned by user' }

    const bundleSeqNo = db['bundle-seq-no']
    const bundleId = db['bundle-id']
    const numChunks = db['num-chunks']
    const encryptedBundleEncryptionKey = db['encrypted-bundle-encryption-key']
    const attribution = db['attribution']
    const plaintextDbKey = db['plaintext-db-key']

    logChildObject.bundleSeqNo = bundleSeqNo
    logChildObject.numChunks = numChunks

    const connectionParams = {
      userId, connectionId, databaseId, bundleSeqNo, bundleId, numChunks, encryptedBundleEncryptionKey,
      reopenAtSeqNo, isOwner, ownerId: db['owner-id'], attribution, plaintextDbKey
    }
    if (validationMessage) {
      const shareTokenReadWritePermissions = _validateAuthTokenSignature(userId, db, validationMessage, signedValidationMessage)

      connectionParams.shareTokenEncryptedDbKey = db['share-token-encrypted-db-key-' + shareTokenReadWritePermissions]
      connectionParams.shareTokenEncryptionKeySalt = db['share-token-encryption-key-salt-' + shareTokenReadWritePermissions]
      connectionParams.shareTokenReadWritePermissions = shareTokenReadWritePermissions
    } else {
      connectionParams.dbNameHash = userDb['database-name-hash']
      const dbKey = userDb['encrypted-db-key']

      // user must call getDatabases() first to set the db key
      if (!dbKey && !plaintextDbKey) throw { status: statusCodes['Not Found'], error: 'Database key not found' }
      connectionParams.dbKey = dbKey
      connectionParams.plaintextDbKey = plaintextDbKey

      // user must have the correct public key saved to access database
      if (!plaintextDbKey && userDb['recipient-ecdsa-public-key'] !== user['ecdsa-public-key']) throw {
        status: statusCodes['Not Found'], error: 'Database not found'
      }
    }

    if (connections.openDatabase(connectionParams)) {
      return responseBuilder.successResponse('Success!')
    } else {
      throw new Error('Unable to open database')
    }
  } catch (e) {
    const message = 'Failed to open database by database ID'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).info(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).warn(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}

const _queryUserDatabases = async (userId, nextPageToken) => {
  const userDatabasesParams = {
    TableName: setup.userDatabaseTableName,
    KeyConditionExpression: '#userId = :userId',
    ExpressionAttributeNames: {
      '#userId': 'user-id',
    },
    ExpressionAttributeValues: {
      ':userId': userId
    }
  }

  if (nextPageToken) {
    userDatabasesParams.ExclusiveStartKey = nextPageTokenToLastEvaluatedKey(nextPageToken)
  }

  const ddbClient = connection.ddbClient()
  const userDbsResponse = await ddbClient.query(userDatabasesParams).promise()

  return userDbsResponse
}

const _getFinalResultForGetDatabases = (databases, userId, userDbs, owners, user, senders) => {
  return databases.map((db, i) => {
    const isOwner = db['owner-id'] === userId
    const userDb = userDbs[i]

    const owner = owners[i]
    if (!owner || owner.deleted) {
      // do not return database with a deleted owner
      return null
    } else if (!db['plaintext-db-key'] && (owner['rotated-keys'] || user['rotated-keys'])) {
      // databases stored with plaintext db key should always be accessible, but if either owner or user has rotated keys,
      // need to make sure only returning databases user should be able to access

      // do not return database if owner has rotated their keys since creating database
      const ownerFingerprint = crypto.sha256.hash(Buffer.from(owner['ecdsa-public-key'], 'base64')).toString('base64')
      if (db['owner-fingerprint'] !== ownerFingerprint) {
        return null
      }

      // do not return database if user has rotated their keys since receiving access to database
      if (!isOwner && userDb['recipient-ecdsa-public-key'] !== user['ecdsa-public-key']) {
        return null
      }
    }

    return {
      databaseName: db['database-name'],
      databaseId: db['database-id'],

      isOwner,
      readOnly: isOwner ? false : userDb['read-only'],
      resharingAllowed: isOwner ? true : userDb['resharing-allowed'],
      databaseNameHash: userDb['database-name-hash'],
      senderUsername: (senders[i] && !senders[i].deleted) ? senders[i].username : undefined,
      senderEcdsaPublicKey: userDb['sender-ecdsa-public-key'],
      plaintextDbKey: db['plaintext-db-key'],

      // if already has access to database
      encryptedDbKey: userDb['encrypted-db-key'],

      // if still does not have access to database
      sharedEncryptedDbKey: userDb['shared-encrypted-db-key'],
      wrappedDbKey: userDb['wrapped-db-key'],
      ephemeralPublicKey: userDb['ephemeral-public-key'],
      signedEphemeralPublicKey: userDb['signed-ephemeral-public-key'],
    }
  })
}

const _getUserDbsForGetDatabases = async (userId, nextPageToken, databaseId, dbNameHash) => {
  let userDbsResponse
  if (!databaseId && !dbNameHash) {
    userDbsResponse = await _queryUserDatabases(userId, nextPageToken)
  } else if (databaseId) {
    const userDb = await _getUserDatabaseByUserIdAndDatabaseId(userId, databaseId)
    userDbsResponse = { Items: userDb ? [userDb] : [] }
  } else {
    const userDb = await _getUserDatabase(userId, dbNameHash)
    userDbsResponse = { Items: userDb ? [userDb] : [] }
  }
  return userDbsResponse
}

exports.getDatabases = async function (logChildObject, userId, nextPageToken, databaseId, dbNameHash) {
  try {
    const [userDbsResponse, user] = await Promise.all([
      _getUserDbsForGetDatabases(userId, nextPageToken, databaseId, dbNameHash),
      userController.getUserByUserId(userId),
    ])
    const userDbs = userDbsResponse.Items

    const [databases, senders] = await Promise.all([
      Promise.all(userDbs.map(userDb => findDatabaseByDatabaseId(userDb['database-id']))),
      Promise.all(userDbs.map(userDb => userDb['sender-id'] && userController.getUserByUserId(userDb['sender-id'])))
    ])

    // used to make sure not returning databases with deleted owner
    const owners = await Promise.all(databases.map(db => {
      if (db['owner-id'] === userId) return user

      // if already found it when searching for senders, no need to query for it again
      const owner = senders.find((sender) => sender && sender['user-id'] === db['owner-id'])
      return owner || userController.getUserByUserId(db['owner-id'])
    }))

    const finalResult = {
      databases: _getFinalResultForGetDatabases(databases, userId, userDbs, owners, user, senders).filter(finalDb => finalDb !== null),
      nextPageToken: userDbsResponse.LastEvaluatedKey && lastEvaluatedKeyToNextPageToken(userDbsResponse.LastEvaluatedKey)
    }

    return responseBuilder.successResponse(finalResult)
  } catch (e) {
    logChildObject.err = e
    return responseBuilder.errorResponse(
      statusCodes['Internal Server Error'],
      'Failed to get databases'
    )
  }
}

const _queryOtherUserDatabases = async function (dbId, userId, nextPageTokenLessThanUserId, nextPageTokenMoreThanUserId) {
  const otherUserDatabasesLessThanUserIdParams = {
    TableName: setup.userDatabaseTableName,
    IndexName: setup.userDatabaseIdIndex,
    // Condition operator != is not supported, must make separate queries using < and >
    KeyConditionExpression: '#dbId = :dbId and #userId < :userId',
    ExpressionAttributeNames: {
      '#dbId': 'database-id',
      '#userId': 'user-id'
    },
    ExpressionAttributeValues: {
      ':dbId': dbId,
      ':userId': userId
    },
  }

  const otherUserDatabasesMoreThanUserIdParams = {
    ...otherUserDatabasesLessThanUserIdParams,
    KeyConditionExpression: '#dbId = :dbId and #userId > :userId',
  }

  if (nextPageTokenLessThanUserId) {
    otherUserDatabasesLessThanUserIdParams.ExclusiveStartKey = nextPageTokenToLastEvaluatedKey(nextPageTokenLessThanUserId)
  }

  if (nextPageTokenMoreThanUserId) {
    otherUserDatabasesMoreThanUserIdParams.ExclusiveStartKey = nextPageTokenToLastEvaluatedKey(nextPageTokenMoreThanUserId)
  }

  const ddbClient = connection.ddbClient()
  const [otherUserDbsLessThanResponse, otherUserDbsMoreThanResponse] = await Promise.all([
    ddbClient.query(otherUserDatabasesLessThanUserIdParams).promise(),
    ddbClient.query(otherUserDatabasesMoreThanUserIdParams).promise(),
  ])

  const otherUserDbsLessThan = (otherUserDbsLessThanResponse && otherUserDbsLessThanResponse.Items) || []
  const otherUserDbsMoreThan = (otherUserDbsMoreThanResponse && otherUserDbsMoreThanResponse.Items) || []

  return {
    otherUserDatabases: otherUserDbsLessThan.concat(otherUserDbsMoreThan),
    nextPageTokenLessThanUserId: otherUserDbsLessThanResponse && otherUserDbsLessThanResponse.LastEvaluatedKey
      && lastEvaluatedKeyToNextPageToken(otherUserDbsLessThanResponse.LastEvaluatedKey),
    nextPageTokenMoreThanUserId: otherUserDbsMoreThanResponse && otherUserDbsMoreThanResponse.LastEvaluatedKey
      && lastEvaluatedKeyToNextPageToken(otherUserDbsMoreThanResponse.LastEvaluatedKey),
  }
}

const _getOtherDatabaseUsers = async function (dbId, userId, nextPageTokenLessThanUserId, nextPageTokenMoreThanUserId) {
  const otherDatabaseUsersQueryResult = await _queryOtherUserDatabases(dbId, userId, nextPageTokenLessThanUserId, nextPageTokenMoreThanUserId)
  const { otherUserDatabases } = otherDatabaseUsersQueryResult

  const userQueries = []
  for (const otherUserDb of otherUserDatabases) {
    const otherUserId = otherUserDb['user-id']
    userQueries.push(userController.getUserByUserId(otherUserId))
  }
  const otherDatabaseUsers = await Promise.all(userQueries)

  return {
    otherDatabaseUsers,
    otherUserDatabases,
    nextPageTokenLessThanUserId: otherDatabaseUsersQueryResult.nextPageTokenLessThanUserId,
    nextPageTokenMoreThanUserId: otherDatabaseUsersQueryResult.nextPageTokenMoreThanUserId,
  }
}

exports.getDatabaseUsers = async function (logChildObject, userId, databaseId, databaseNameHash,
  nextPageTokenLessThanUserId, nextPageTokenMoreThanUserId
) {
  try {
    logChildObject.databaseId = databaseId
    logChildObject.databaseNameHash = databaseNameHash

    const [userDatabase, database] = await Promise.all([
      _getUserDatabase(userId, databaseNameHash),
      findDatabaseByDatabaseId(databaseId)
    ])

    if (!userDatabase || !database || userDatabase['database-id'] !== databaseId) throw {
      status: statusCodes['Not Found'],
      error: { message: 'Database not found' }
    }

    const otherDatabaseUsersResult = await _getOtherDatabaseUsers(databaseId, userId, nextPageTokenLessThanUserId, nextPageTokenMoreThanUserId)
    const { otherDatabaseUsers, otherUserDatabases } = otherDatabaseUsersResult

    const usersByUserId = {}
    otherDatabaseUsers.forEach(user => {
      if (user) usersByUserId[user['user-id']] = user
    })

    const finalResult = {
      users: otherDatabaseUsers.map((user, i) => {
        if (!user || user.deleted) return null

        const otherUserDb = otherUserDatabases[i]
        const isOwner = database['owner-id'] === user['user-id']

        // make sure user still has access to database. No need to check if owner still does since already checked in .getDatabases()
        if (!database['plaintext-db-key'] && !isOwner && otherUserDb['recipient-ecdsa-public-key'] !== user['ecdsa-public-key']) {
          return null
        }

        const isChild = userId === otherUserDb['sender-id'] // user sent database to this user
        const isParent = userDatabase['sender-id'] === otherUserDb['user-id'] // user received database from this user
        const senderId = otherUserDb['sender-id']

        return {
          username: user['username'],
          isOwner,
          senderUsername: (usersByUserId[senderId] && !usersByUserId[senderId].deleted) ? usersByUserId[senderId].username : undefined,
          readOnly: isOwner ? false : otherUserDb['read-only'],
          resharingAllowed: isOwner ? true : otherUserDb['resharing-allowed'],

          // used to verify other user with access to the database
          verificationValues: {
            sentSignature: otherUserDb['sent-signature'],
            receivedSignature: otherUserDb['received-signature'],
            senderEcdsaPublicKey: otherUserDb['sender-ecdsa-public-key'],
            recipientEcdsaPublicKey: otherUserDb['recipient-ecdsa-public-key'],

            // used to verify the requesting user sent the database to this user
            isChild,

            // the folowing additional values are used to verify the requesting user received the database from this user
            mySentSignature: isParent && userDatabase['sent-signature'],
            myReceivedSignature: isParent && userDatabase['received-signature'],
            mySenderEcdsaPublicKey: isParent && userDatabase['sender-ecdsa-public-key'],
          }
        }
      }).filter(user => user !== null),
      nextPageTokenLessThanUserId: otherDatabaseUsersResult.nextPageTokenLessThanUserId,
      nextPageTokenMoreThanUserId: otherDatabaseUsersResult.nextPageTokenMoreThanUserId,
    }

    return responseBuilder.successResponse(finalResult)
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) {
      return responseBuilder.errorResponse(e.status, e.error.message)
    } else {
      return responseBuilder.errorResponse(
        statusCodes['Internal Server Error'],
        'Failed to get database users'
      )
    }
  }
}

const _getUserDatabaseOverWebSocket = async function (logChildObject, userDbDdbQuery, internalServerErrorLog) {
  try {
    const userDb = await userDbDdbQuery()
    if (!userDb) return responseBuilder.errorResponse(statusCodes['Not Found'], { message: 'DatabaseNotFound' })

    return responseBuilder.successResponse({
      encryptedDbKey: userDb['encrypted-db-key'],
      dbId: userDb['database-id'],
      dbNameHash: userDb['database-name-hash'],

    })
  } catch (e) {
    logChildObject.err = e
    return responseBuilder.errorResponse(
      statusCodes['Internal Server Error'],
      internalServerErrorLog
    )
  }
}

exports.getUserDatabaseByDbNameHash = async function (logChildObject, userId, dbNameHash) {
  const userDbDdbQuery = () => _getUserDatabase(userId, dbNameHash)
  const internalServerErrorLog = 'Failed to get user database by db name hash'
  const response = await _getUserDatabaseOverWebSocket(logChildObject, userDbDdbQuery, internalServerErrorLog)
  return response
}

exports.getUserDatabaseByDatabaseId = async function (logChildObject, userId, databaseId) {
  const userDbDdbQuery = () => _getUserDatabaseByUserIdAndDatabaseId(userId, databaseId)
  const internalServerErrorLog = 'Failed to get user database by db id'
  const response = await _getUserDatabaseOverWebSocket(logChildObject, userDbDdbQuery, internalServerErrorLog)
  return response
}

const _setUserForWriteAccess = function (username, userPromiseIndexes, users) {
  const promiseIndex = userPromiseIndexes[username]
  const user = users[promiseIndex]

  if (!user || user['deleted']) throw {
    status: statusCodes['Not Found'],
    error: { message: 'UserNotFound', username }
  }

  return { userId: user['user-id'], username }
}

const _getUsersForWriteAccess = function (users, appId, userPromises, userPromiseIndexes) {
  if (users.length > MAX_USERS_ALLOWED_FOR_ACCESS_CONTROL) throw {
    status: statusCodes['Bad Request'],
    error: { message: 'WriteAccessUsersExceedMax', max: MAX_USERS_ALLOWED_FOR_ACCESS_CONTROL }
  }

  for (const u of users) {
    const username = u.username.toLowerCase()
    if (typeof userPromiseIndexes[username] !== 'number') {
      userPromiseIndexes[username] = userPromises.push(userController.getUser(appId, username)) - 1
    }
  }
}

const _setUsersForWriteAccess = async function (transaction, appId) {
  const { command } = transaction

  const userPromises = []
  const userPromiseIndexes = {}

  if (command === 'Insert' || command === 'Update') {
    const { writeAccess } = transaction

    if (writeAccess && writeAccess.users) {
      _getUsersForWriteAccess(writeAccess.users, appId, userPromises, userPromiseIndexes)
      const users = await Promise.all(userPromises)
      transaction.writeAccess.users = writeAccess.users.map(u => _setUserForWriteAccess(u.username.toLowerCase(), userPromiseIndexes, users))
    }
  } else if (command === 'BatchTransaction') {
    const { operations } = transaction
    for (const op of operations) {
      const users = op.writeAccess && op.writeAccess.users
      if (users && (op.command === 'Insert' || op.command === 'Update')) {
        _getUsersForWriteAccess(users, appId, userPromises, userPromiseIndexes)
      }
    }

    const users = await Promise.all(userPromises)

    transaction.operations = operations.map(op => {
      const { writeAccess } = op
      return (writeAccess && writeAccess.users)
        ? {
          ...op,
          writeAccess: {
            ...writeAccess,
            users: writeAccess.users.map(u => _setUserForWriteAccess(u.username.toLowerCase(), userPromiseIndexes, users))
          }
        }
        : { ...op }
    })
  }
}

const _incrementSeqNo = async function (transaction, databaseId) {
  const incrementSeqNoParams = {
    TableName: setup.databaseTableName,
    Key: {
      'database-id': databaseId
    },
    UpdateExpression: 'add #nextSeqNumber :num',
    ExpressionAttributeNames: {
      '#nextSeqNumber': 'next-seq-number'
    },
    ExpressionAttributeValues: {
      ':num': 1
    },
    ReturnValues: 'UPDATED_NEW'
  }

  // atomically increments and gets the next sequence number for the database
  try {
    const ddbClient = connection.ddbClient()
    const db = await ddbClient.update(incrementSeqNoParams).promise()
    transaction['sequence-no'] = db.Attributes['next-seq-number']
    transaction['creation-date'] = new Date().toISOString()
  } catch (e) {
    throw new Error(`Failed to increment sequence number with ${e}.`)
  }
}

const putTransaction = async function (transaction, userId, appId, connectionId, databaseId) {
  if (!connections.isDatabaseOpen(userId, connectionId, databaseId)) throw {
    status: statusCodes['Bad Request'],
    error: { name: 'DatabaseNotOpen' }
  }

  const shareTokenReadWritePermissions = connections.getShareTokenReadWritePermissionsFromConnection(userId, connectionId, databaseId)

  // can be determined now, but not needed until later
  const userPromise = userController.getUserByUserId(userId)

  // incrementeSeqNo is only thing that needs to be done here, but making requests async to keep the
  // time for successful putTransaction low
  const [userDb, db] = await Promise.all([
    !shareTokenReadWritePermissions && _getUserDatabaseByUserIdAndDatabaseId(userId, databaseId),
    shareTokenReadWritePermissions && findDatabaseByDatabaseId(databaseId),
    _setUsersForWriteAccess(transaction, appId),
    _incrementSeqNo(transaction, databaseId)
  ])

  const ddbClient = connection.ddbClient()

  transaction['user-id'] = userId

  try {
    if (!userDb && !db) {
      throw {
        status: statusCodes['Not Found'],
        error: { name: 'DatabaseNotFound' }
      }
    } else if (shareTokenReadWritePermissions ? shareTokenReadWritePermissions === 'read-only' : userDb['read-only']) {
      throw {
        status: statusCodes['Forbidden'],
        error: { name: 'DatabaseIsReadOnly' }
      }
    } else {

      // write the transaction using the next sequence number
      const params = {
        TableName: setup.transactionsTableName,
        Item: transaction,
        ConditionExpression: 'attribute_not_exists(#databaseId)',
        ExpressionAttributeNames: {
          '#databaseId': 'database-id'
        }
      }

      await ddbClient.put(params).promise()
    }
  } catch (e) {
    // best effort rollback - if the rollback fails here, it will get attempted again when the transactions are read
    await rollbackAttempt(transaction, ddbClient)

    if (e.status && e.error) throw e
    else throw new Error(`Failed to put transaction with ${e}.`)
  }

  // username is put on the transaction for transmitting,
  // but not for storing.
  transaction['username'] = (await userPromise).username

  // notify all websocket connections that there's a database change
  connections.push(transaction)

  // broadcast transaction to all peers so they also push to their connected clients
  peers.broadcastTransaction(transaction, userId, connectionId)

  return transaction['sequence-no']
}

const rollbackAttempt = async function (transaction, ddbClient) {
  const rollbackParams = {
    TableName: setup.transactionsTableName,
    Item: {
      'database-id': transaction['database-id'],
      'sequence-no': transaction['sequence-no'],
      'command': 'Rollback',
      'creation-date': new Date().toISOString()
    },
    ConditionExpression: 'attribute_not_exists(#databaseId)',
    ExpressionAttributeNames: {
      '#databaseId': 'database-id'
    }
  }

  try {
    await ddbClient.put(rollbackParams).promise()
  } catch (e) {
    throw new Error(`Failed to rollback with ${e}.`)
  }
}

const doCommand = async function ({ command, userId, appId, connectionId, databaseId, itemKey, encryptedItem, writeAccess,
  fileId, fileEncryptionKey, fileMetadata }) {
  if (!databaseId) return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing database id')
  if (!itemKey) return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing item key')

  const transaction = {
    'database-id': databaseId,
    key: itemKey,
    command,
  }

  try {
    switch (command) {
      case 'Insert':
      case 'Update': {
        transaction.record = encryptedItem
        if (writeAccess || writeAccess === false) {
          transaction.writeAccess = writeAccess
        }
        break
      }
      case 'Delete': {
        transaction.record = encryptedItem
        break
      }
      case 'UploadFile': {
        transaction['file-id'] = fileId
        transaction['file-encryption-key'] = fileEncryptionKey
        transaction['file-metadata'] = fileMetadata
        break
      }
      default: {
        throw new Error('Unknown command')
      }
    }

    const sequenceNo = await putTransaction(transaction, userId, appId, connectionId, databaseId)
    return responseBuilder.successResponse({ sequenceNo })
  } catch (e) {
    const message = `Failed to ${command}`
    const logChildObject = { userId, databaseId, command, connectionId }

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).info(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).warn(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}
exports.doCommand = doCommand

exports.batchTransaction = async function (userId, appId, connectionId, databaseId, operations) {
  if (!databaseId) return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing database id')
  if (!operations || !operations.length) return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing operations')

  if (operations.length > MAX_OPERATIONS_IN_TX) return responseBuilder.errorResponse(statusCodes['Bad Request'], {
    error: 'OperationsExceedLimit',
    limit: MAX_OPERATIONS_IN_TX
  })

  const ops = []
  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i]
    const key = operation.itemKey
    const record = operation.encryptedItem
    const command = operation.command
    const writeAccess = operation.writeAccess

    if (!key) return responseBuilder.errorResponse(statusCodes['Bad Request'], `Operation ${i} missing item key`)
    if (!record) return responseBuilder.errorResponse(statusCodes['Bad Request'], `Operation ${i} missing record`)
    if (!command) return responseBuilder.errorResponse(statusCodes['Bad Request'], `Operation ${i} missing command`)

    ops.push({
      key,
      record,
      command,
      writeAccess,
    })
  }

  try {
    const command = 'BatchTransaction'

    const transaction = {
      'database-id': databaseId,
      command,
      operations: ops
    }

    const sequenceNo = await putTransaction(transaction, userId, appId, connectionId, databaseId)
    return responseBuilder.successResponse({ sequenceNo })
  } catch (e) {
    const message = 'Failed to batch transaction'
    const logChildObject = { userId, databaseId, connectionId, appId }

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).info(message)
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e }).warn(message)
      return responseBuilder.errorResponse(statusCode, message)
    }
  }
}

exports.initBundleUpload = async function (userId, connectionId, databaseId, bundleSeqNo) {
  let logChildObject = {}
  try {
    logChildObject = { userId, connectionId, databaseId, bundleSeqNo }
    logger.child(logChildObject).info('Initializing bundle upload')

    if (!databaseId) throw { status: statusCodes['Bad Request'], error: { message: 'Missing database id' } }

    if (!connections.isDatabaseOpen(userId, connectionId, databaseId)) {
      return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Database not open')
    }

    const database = await findDatabaseByDatabaseId(databaseId)
    if (!database) throw { status: statusCodes['Not Found'], message: 'Database not found' }

    const lastBundleSeqNo = database['bundle-seq-no']
    if (lastBundleSeqNo >= bundleSeqNo) {
      throw { status: statusCodes['Bad Request'], message: 'Bundle sequence no must be greater than current bundle' }
    }

    if (database['owner-id'] !== userId) {
      throw { status: statusCodes['Forbidden'], message: 'Only owner can bundle' }
    }

    // generate a new unique ID for this bundle upload
    const bundleId = uuidv4()

    // cache the bundle ID so server knows user is in the process of uploading this bundle
    connections.cacheToken(userId, databaseId + bundleSeqNo + bundleId)
    logChildObject.bundleId = bundleId

    logger.child(logChildObject).info('Initialized bundle upload')

    return responseBuilder.successResponse({ bundleId })
  } catch (e) {
    logChildObject.err = e

    logger.child(logChildObject).warn('Failed to init bundle upload')

    if (e.status && e.error) return responseBuilder.errorResponse(e.status, e.error.message)
    else return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to init bundle upload')
  }
}

exports.uploadBundleChunk = async function (req, res) {
  let logChildObject = {}
  try {
    const { userId, databaseId, bundleId, chunkNumber, seqNo } = req.query
    logChildObject = { userId, databaseId, bundleId, chunkNumber, bundleSeqNo: seqNo }

    const bundleSeqNo = Number(seqNo)
    const chunkNo = Number(chunkNumber)

    if (!bundleSeqNo) throw { status: statusCodes['Bad Request'], message: `Missing bundle sequence number` }

    if (!connections.isTokenCached(userId, databaseId + bundleSeqNo + bundleId)) {
      throw { status: statusCodes['Bad Request'], message: 'Token expired' }
    }

    const contentLength = Number(req.headers['content-length'])
    logChildObject.chunkSize = contentLength
    if (!contentLength) throw { status: statusCodes['Bad Request'], message: 'Missing chunk' }
    else if (contentLength > KB_512) throw { status: statusCodes['Bad Request'], message: 'Chunk too large' }

    const database = await findDatabaseByDatabaseId(databaseId)
    if (!database) throw { status: statusCodes['Not Found'], message: 'Database not found' }

    const lastBundleSeqNo = database['bundle-seq-no']
    if (lastBundleSeqNo >= bundleSeqNo) {
      throw { status: statusCodes['Bad Request'], message: 'Bundle sequence no must be greater than current bundle' }
    }

    const dbStateParams = {
      Bucket: setup.getDbStatesBucketName(),
      Key: getS3DbStateChunkKey(databaseId, bundleSeqNo, bundleId, chunkNo),
      Body: req
    }
    await setup.s3().upload(dbStateParams).promise()

    logger.child(logChildObject).info('Uploaded bundle chunk')
    return res.status(statusCodes['Success']).send()
  } catch (e) {
    logChildObject.err = e

    logger.child(logChildObject).warn('Failed to upload bundle chunk')

    if (e.status && e.error) return res.status(e.status).send(e.error.message)
    else return res.status(statusCodes['Internal Server Error']).send('Failed to upload bundle chunk')
  }
}

exports.completeBundleUpload = async function (userId, connectionId, databaseId, seqNo, bundleId, writersString, numChunks,
  encryptedBundleEncryptionKey) {
  let logChildObject = {}
  try {
    logChildObject = { userId, connectionId, databaseId, seqNo, bundleId, numChunks }
    const bundleSeqNo = Number(seqNo)
    if (!bundleSeqNo) throw { status: statusCodes['Bad Request'], message: `Missing bundle sequence number` }

    if (!connections.isTokenCached(userId, databaseId + bundleSeqNo + bundleId)) {
      throw { status: statusCodes['Bad Request'], message: 'Token expired' }
    }

    const database = await findDatabaseByDatabaseId(databaseId)
    if (!database) throw { status: statusCodes['Not Found'], message: 'Database not found' }

    const lastBundleSeqNo = database['bundle-seq-no']
    if (lastBundleSeqNo >= bundleSeqNo) {
      throw { status: statusCodes['Bad Request'], message: 'Bundle sequence no must be greater than current bundle' }
    }

    const dbWritersParams = {
      Bucket: setup.getDbStatesBucketName(),
      Key: getS3DbWritersKey(databaseId, bundleSeqNo),
      Body: writersString
    }
    await setup.s3().upload(dbWritersParams).promise()

    const bundleParams = {
      TableName: setup.databaseTableName,
      Key: {
        'database-id': databaseId
      },
      UpdateExpression: 'set #bundleSeqNo = :bundleSeqNo, #bundleId = :bundleId, #numChunks = :numChunks, #encryptedBundleEncryptionKey = :encryptedBundleEncryptionKey',
      ConditionExpression: '(attribute_not_exists(#bundleSeqNo) or #bundleSeqNo < :bundleSeqNo)',
      ExpressionAttributeNames: {
        '#bundleSeqNo': 'bundle-seq-no',
        '#bundleId': 'bundle-id',
        '#numChunks': 'num-chunks',
        '#encryptedBundleEncryptionKey': 'encrypted-bundle-encryption-key',
      },
      ExpressionAttributeValues: {
        ':bundleSeqNo': bundleSeqNo,
        ':bundleId': bundleId,
        ':numChunks': numChunks,
        ':encryptedBundleEncryptionKey': encryptedBundleEncryptionKey,
      }
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.update(bundleParams).promise()

    logger.child(logChildObject).info('Completed bundling database')
    return responseBuilder.successResponse({})
  } catch (e) {
    logChildObject.err = e

    logger.child(logChildObject).warn('Failed to complete bundle upload')

    if (e.status && e.error) return responseBuilder.errorResponse(e.status, e.error.message)
    else return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to complete bundle upload')
  }
}

exports.getBundleWriters = async function (databaseId, bundleSeqNo) {
  if (!bundleSeqNo) {
    throw new Error('Missing bundle sequence number')
  }

  try {
    const writersParams = {
      Bucket: setup.getDbStatesBucketName(),
      Key: getS3DbWritersKey(databaseId, bundleSeqNo)
    }

    const writersObject = await setup.s3().getObject(writersParams).promise()
    return writersObject.Body.toString()
  } catch (e) {
    throw new Error(`Failed to get bundle writers with ${e}`)
  }
}

exports.getBundleChunk = async function (databaseId, bundleSeqNo, bundleId, chunkNo) {
  if (!bundleSeqNo) throw new Error(`Missing bundle sequence number`)

  try {
    const params = {
      Bucket: setup.getDbStatesBucketName(),
      Key: getS3DbStateChunkKey(databaseId, bundleSeqNo, bundleId, chunkNo)
    }

    const bundleChunkObject = await setup.s3().getObject(params).promise()

    // conversion to Uint16Array before converting to string ensures string encoding
    // takes up same number of bytes as array buffer
    return arrayBufferToString(bufferToUint16Array(bundleChunkObject.Body))
  } catch (e) {
    throw new Error(`Failed to query db state chunk with ${e}`)
  }
}

exports.generateFileId = async function (logChildObject, userId, connectionId, databaseId) {
  try {
    if (!databaseId) throw { status: statusCodes['Bad Request'], error: { message: 'Missing database id' } }

    if (!connections.isDatabaseOpen(userId, connectionId, databaseId)) {
      return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Database not open')
    }

    const shareTokenReadWritePermissions = connections.getShareTokenReadWritePermissionsFromConnection(userId, connectionId, databaseId)

    const userDb = !shareTokenReadWritePermissions && await _getUserDatabaseByUserIdAndDatabaseId(userId, databaseId)

    if (!shareTokenReadWritePermissions ? userDb['read-only'] : shareTokenReadWritePermissions === 'read-only') {
      throw {
        status: statusCodes['Forbidden'],
        error: { message: 'DatabaseIsReadOnly' }
      }
    }

    // generate a new unique file ID for this file
    const fileId = uuidv4()
    logChildObject.fileId = fileId

    // cache the file ID so server knows user is in the process of uploading this file
    connections.cacheToken(userId, fileId)

    return responseBuilder.successResponse({ fileId })
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) return responseBuilder.errorResponse(e.status, e.error.message)
    else return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to generate file id')
  }
}

const _validateFileUpload = (userId, connectionId, databaseId, fileId) => {
  if (!databaseId) throw { status: statusCodes['Bad Request'], error: { message: 'Missing database id' } }

  if (!connections.isDatabaseOpen(userId, connectionId, databaseId)) {
    return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Database not open')
  }

  // server makes sure user is already in the process of uploading this exact file
  if (!connections.isTokenCached(userId, fileId)) {
    throw { status: statusCodes['Not Found'], error: { message: 'File not found' } }
  }
}

const uploadFileChunk = async function (logChildObject, userId, connectionId, databaseId, chunkEncryptionKey, chunk, chunkNumber, fileId) {
  logChildObject.databaseId = databaseId
  logChildObject.fileId = fileId
  logChildObject.chunkNumber = chunkNumber

  if (!chunk) throw { status: statusCodes['Bad Request'], error: { message: 'Missing chunk' } }
  if (!chunkEncryptionKey) throw { status: statusCodes['Bad Request'], error: { message: 'Missing chunk encryption key' } }
  if (typeof chunkNumber !== 'number') throw { status: statusCodes['Bad Request'], error: { message: 'Missing chunk number' } }

  _validateFileUpload(userId, connectionId, databaseId, fileId)

  const fileChunkParams = {
    Bucket: setup.getFilesBucketName(),
    Key: getS3FileChunkKey(databaseId, fileId, chunkNumber),
    Body: Buffer.concat([
      // necessary multi-step type conversion to maintain size of array buffer
      new Uint8Array(new Uint16Array(stringToArrayBuffer(chunkEncryptionKey))),
      new Uint8Array(new Uint16Array(stringToArrayBuffer(chunk)))
    ])
  }

  logger.child(logChildObject).info('Uploading file chunk')
  const s3 = setup.s3()
  await s3.upload(fileChunkParams).promise()

  return fileId
}

exports.uploadFileChunk = async function (logChildObject, userId, connectionId, databaseId, chunkEncryptionKey, chunk, chunkNumber, fileId) {
  try {
    await uploadFileChunk(logChildObject, userId, connectionId, databaseId, chunkEncryptionKey, chunk, chunkNumber, fileId)
    return responseBuilder.successResponse({ fileId })
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) return responseBuilder.errorResponse(e.status, e.error.message)
    else return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to upload file chunk')
  }
}

exports.completeFileUpload = async function (logChildObject, userId, appId, connectionId, databaseId, fileId, fileEncryptionKey, itemKey, fileMetadata) {
  try {
    logChildObject.databaseId = databaseId
    logChildObject.fileId = fileId

    _validateFileUpload(userId, connectionId, databaseId, fileId)

    // places transaction in transaction log to attach file to an item
    const command = 'UploadFile'
    const response = await doCommand({ command, userId, appId, connectionId, databaseId, itemKey, fileId, fileEncryptionKey, fileMetadata })
    return response
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) return responseBuilder.errorResponse(e.status, e.error.message)
    else return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to complete file upload')
  }
}

const getChunk = async function (userId, connectionId, databaseId, fileId, chunkNumber) {
  if (!databaseId) throw { status: statusCodes['Bad Request'], error: { message: 'Missing database id' } }
  if (!fileId) throw { status: statusCodes['Bad Request'], error: { message: 'Missing file id' } }
  if (typeof chunkNumber !== 'number') throw { status: statusCodes['Bad Request'], error: { message: 'Missing chunk number' } }

  if (!connections.isDatabaseOpen(userId, connectionId, databaseId)) {
    throw { status: statusCodes['Bad Request'], error: { message: 'Database not open' } }
  }

  const params = {
    Bucket: setup.getFilesBucketName(),
    Key: getS3FileChunkKey(databaseId, fileId, chunkNumber),
  }
  const s3 = setup.s3()
  const result = await s3.getObject(params).promise()

  const CHUNK_ENCRYPTION_KEY_BYTE_LENGTH = 60
  const chunkEncryptionKeyBuffer = result.Body.slice(0, CHUNK_ENCRYPTION_KEY_BYTE_LENGTH)
  const chunkBuffer = result.Body.slice(CHUNK_ENCRYPTION_KEY_BYTE_LENGTH)

  return {
    // reverse multi-step type conversion done at upload
    chunkEncryptionKey: arrayBufferToString(new Uint16Array(new Uint8Array(chunkEncryptionKeyBuffer))),
    chunk: arrayBufferToString(new Uint16Array(new Uint8Array(chunkBuffer))),
  }
}

exports.getChunk = async function (logChildObject, userId, connectionId, databaseId, fileId, chunkNumber) {
  try {
    logChildObject.databaseId = databaseId
    logChildObject.fileId = fileId
    logChildObject.chunkNumber = chunkNumber

    const { chunk, chunkEncryptionKey } = await getChunk(userId, connectionId, databaseId, fileId, chunkNumber)
    return responseBuilder.successResponse({ chunk, chunkEncryptionKey })
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) return responseBuilder.errorResponse(e.status, e.error.message)
    else return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to get file chunk')
  }
}

const _validateShareDatabase = async function (sender, dbId, dbNameHash, recipientUsername, readOnly, revoke) {
  const [database, senderUserDb, recipient] = await Promise.all([
    findDatabaseByDatabaseId(dbId),
    _getUserDatabase(sender['user-id'], dbNameHash),
    userController.getUser(sender['app-id'], recipientUsername)
  ])

  if (!database || !senderUserDb || senderUserDb['database-id'] !== dbId) throw {
    status: statusCodes['Not Found'],
    error: { message: 'DatabaseNotFound' }
  }

  if (!recipient || recipient['deleted']) throw {
    status: statusCodes['Not Found'],
    error: { message: 'UserNotFound' }
  }

  const revokingSelf = revoke && sender['user-id'] === recipient['user-id']
  if (sender['user-id'] === recipient['user-id'] && !revokingSelf) throw {
    status: statusCodes['Conflict'],
    error: { message: 'SharingWithSelfNotAllowed' }
  }

  if (database['owner-id'] !== sender['user-id'] && !senderUserDb['resharing-allowed'] && !revokingSelf) throw {
    status: statusCodes['Forbidden'],
    error: { message: 'ResharingNotAllowed' }
  }

  if (readOnly !== undefined && database['owner-id'] !== sender['user-id'] && senderUserDb['read-only'] && !readOnly) throw {
    status: statusCodes['Forbidden'],
    error: { message: 'ResharingWithWriteAccessNotAllowed' }
  }

  return { database, senderUserDb, recipient }
}

const _validateShareDatabaseToken = async function (sender, dbId, dbNameHash) {
  const [database, senderUserDb] = await Promise.all([
    findDatabaseByDatabaseId(dbId),
    _getUserDatabase(sender['user-id'], dbNameHash),
  ])

  if (!database || !senderUserDb || senderUserDb['database-id'] !== dbId) throw {
    status: statusCodes['Not Found'],
    error: { message: 'DatabaseNotFound' }
  }

  if (database['owner-id'] !== sender['user-id']) throw {
    status: statusCodes['Forbidden'],
    error: { message: 'ResharingNotAllowed' }
  }
}

const _buildSharedUserDatabaseParams = (userId, dbId, readOnly, resharingAllowed, senderId, sharedEncryptedDbKey, wrappedDbKey,
  ephemeralPublicKey, signedEphemeralPublicKey, ecdsaPublicKey, sentSignature, recipientEcdsaPublicKey) => {
  // user will only be able to open the database using database ID. Only requirement is that this value is unique
  const placeholderDbNameHash = '__userbase_shared_database_' + dbId

  // user must get the database within 24 hours or it will be deleted
  const expirationDate = Date.now() + MS_IN_A_DAY

  return {
    TableName: setup.userDatabaseTableName,
    Item: {
      'user-id': userId,
      'database-name-hash': placeholderDbNameHash,
      'database-id': dbId,
      'read-only': readOnly,
      'resharing-allowed': resharingAllowed,
      'shared-encrypted-db-key': sharedEncryptedDbKey,
      'wrapped-db-key': wrappedDbKey,
      'ephemeral-public-key': ephemeralPublicKey,
      'signed-ephemeral-public-key': signedEphemeralPublicKey,
      'sender-ecdsa-public-key': ecdsaPublicKey,
      'sent-signature': sentSignature,
      'sender-id': senderId,
      'recipient-ecdsa-public-key': recipientEcdsaPublicKey,
      ttl: getTtl(expirationDate),
    },
    ConditionExpression: 'attribute_not_exists(#userId) or #recipientPublicKey <> :recipientPublicKey',
    ExpressionAttributeNames: {
      '#userId': 'user-id',
      '#recipientPublicKey': 'recipient-ecdsa-public-key',
    },
    ExpressionAttributeValues: {
      ':recipientPublicKey': recipientEcdsaPublicKey,
    }
  }
}

exports.shareDatabase = async function (logChildObject, sender, dbId, dbNameHash, recipientUsername, readOnly, resharingAllowed,
  sharedEncryptedDbKey, wrappedDbKey, ephemeralPublicKey, signedEphemeralPublicKey, sentSignature, recipientEcdsaPublicKey
) {
  try {
    if (sharedEncryptedDbKey && wrappedDbKey) throw {
      status: statusCodes['Bad Request'],
      error: { message: 'CannotProvideBothDbKeyTypes' }
    }

    if (typeof readOnly !== 'boolean') throw {
      status: statusCodes['Bad Request'],
      error: { message: 'ReadOnlyMustBeBoolean' }
    }

    if (typeof resharingAllowed !== 'boolean') throw {
      status: statusCodes['Bad Request'],
      error: { message: 'ResharingAllowedMustBeBoolean' }
    }

    const { recipient, database } = await _validateShareDatabase(sender, dbId, dbNameHash, recipientUsername, readOnly)

    const recipientUserDbParams = _buildSharedUserDatabaseParams(recipient['user-id'], database['database-id'], readOnly, resharingAllowed, sender['user-id'],
      sharedEncryptedDbKey, wrappedDbKey, ephemeralPublicKey, signedEphemeralPublicKey, sender['ecdsa-public-key'], sentSignature, recipientEcdsaPublicKey)

    try {
      const ddbClient = connection.ddbClient()
      await ddbClient.put(recipientUserDbParams).promise()
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') throw {
        status: statusCodes['Conflict'],
        error: { message: 'DatabaseAlreadyShared' }
      }
      throw e
    }

    return responseBuilder.successResponse('Success!')
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) {
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to share database')
    }
  }
}

exports.shareDatabaseToken = async function (logChildObject, sender, dbId, dbNameHash, readOnly, keyData) {
  try {
    if (typeof readOnly !== 'boolean') throw {
      status: statusCodes['Bad Request'],
      error: { message: 'ReadOnlyMustBeBoolean' }
    }

    await _validateShareDatabaseToken(sender, dbId, dbNameHash)

    const {
      shareTokenEncryptedDbKey,
      shareTokenEncryptionKeySalt,
      shareTokenPublicKey,
      shareTokenEncryptedEcdsaPrivateKey,
      shareTokenEcdsaKeyEncryptionKeySalt,
    } = keyData

    const shareTokenReadWritePermissions = readOnly ? 'read-only' : 'write'
    const shareTokenId = uuidv4()

    const params = {
      TableName: setup.databaseTableName,
      Key: {
        'database-id': dbId,
      },
      UpdateExpression: `SET
        #shareTokenId = :shareTokenId,
        #shareTokenEncryptedDbKey = :shareTokenEncryptedDbKey,
        #shareTokenEncryptionKeySalt = :shareTokenEncryptionKeySalt,
        #shareTokenPublicKey = :shareTokenPublicKey,
        #shareTokenEncryptedEcdsaPrivateKey = :shareTokenEncryptedEcdsaPrivateKey,
        #shareTokenEcdsaKeyEncryptionKeySalt = :shareTokenEcdsaKeyEncryptionKeySalt
      `,
      ExpressionAttributeNames: {
        '#shareTokenId': 'share-token-id-' + shareTokenReadWritePermissions,
        '#shareTokenEncryptedDbKey': 'share-token-encrypted-db-key-' + shareTokenReadWritePermissions,
        '#shareTokenEncryptionKeySalt': 'share-token-encryption-key-salt-' + shareTokenReadWritePermissions,
        '#shareTokenPublicKey': 'share-token-public-key-' + shareTokenReadWritePermissions,
        '#shareTokenEncryptedEcdsaPrivateKey': 'share-token-encrypted-ecdsa-private-key-' + shareTokenReadWritePermissions,
        '#shareTokenEcdsaKeyEncryptionKeySalt': 'share-token-ecdsa-key-encryption-key-salt-' + shareTokenReadWritePermissions,
      },
      ExpressionAttributeValues: {
        ':shareTokenId': shareTokenId,
        ':shareTokenEncryptedDbKey': shareTokenEncryptedDbKey,
        ':shareTokenEncryptionKeySalt': shareTokenEncryptionKeySalt,
        ':shareTokenPublicKey': shareTokenPublicKey,
        ':shareTokenEncryptedEcdsaPrivateKey': shareTokenEncryptedEcdsaPrivateKey,
        ':shareTokenEcdsaKeyEncryptionKeySalt': shareTokenEcdsaKeyEncryptionKeySalt,
      }
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.update(params).promise()

    return responseBuilder.successResponse({ shareTokenId })
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) {
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to share database token')
    }
  }
}

const _findDatabaseByShareTokenId = async (shareTokenId) => {
  const params = {
    TableName: setup.databaseTableName,
    KeyConditionExpression: '#shareTokenId = :shareTokenId',
    Select: 'ALL_ATTRIBUTES'
  }

  const readOnlyParams = {
    ...params,
    IndexName: setup.shareTokenIdReadOnlyIndex,
    ExpressionAttributeNames: {
      '#shareTokenId': 'share-token-id-read-only',
    },
    ExpressionAttributeValues: {
      ':shareTokenId': shareTokenId,
    },
  }

  const writeParams = {
    ...params,
    IndexName: setup.shareTokenIdWriteIndex,
    ExpressionAttributeNames: {
      '#shareTokenId': 'share-token-id-write',
    },
    ExpressionAttributeValues: {
      ':shareTokenId': shareTokenId,
    },
  }

  const ddbClient = connection.ddbClient()
  const [readOnlyResponse, writeResponse] = await Promise.all([
    ddbClient.query(readOnlyParams).promise(),
    ddbClient.query(writeParams).promise(),
  ])

  if (readOnlyResponse.Items.length === 0 && writeResponse.Items.length === 0) return null
  return readOnlyResponse.Items[0] || writeResponse.Items[0]
}

exports.authenticateShareToken = async function (logChildObject, user, shareTokenId) {
  try {
    const database = await _findDatabaseByShareTokenId(shareTokenId)

    if (!database) throw {
      status: statusCodes['Not Found'],
      error: 'ShareTokenNotFound'
    }

    const shareTokenReadWritePermissions = database['share-token-id-read-only'] === shareTokenId ? 'read-only' : 'write'

    const shareTokenAuthKeyData = {
      shareTokenEncryptedEcdsaPrivateKey: database['share-token-encrypted-ecdsa-private-key-' + shareTokenReadWritePermissions],
      shareTokenEcdsaKeyEncryptionKeySalt: database['share-token-ecdsa-key-encryption-key-salt-' + shareTokenReadWritePermissions],
    }

    // user must sign this message to open the database with share token
    const validationMessage = crypto.randomBytes(VALIDATION_MESSAGE_LENGTH).toString('base64')

    // cache the read-write permissions keyed by validation message so server can validate access to share token on open
    connections.cacheShareTokenReadWritePermissions(user['user-id'], validationMessage, shareTokenReadWritePermissions)

    return responseBuilder.successResponse({ databaseId: database['database-id'], shareTokenAuthKeyData, validationMessage })
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) {
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to get database share token auth data')
    }
  }
}

exports.saveDatabase = async function (logChildObject, user, dbNameHash, encryptedDbKey, receivedSignature) {
  try {
    const params = {
      TableName: setup.userDatabaseTableName,
      Key: {
        'user-id': user['user-id'],
        'database-name-hash': dbNameHash,
      },
      UpdateExpression: 'SET #encryptedDbKey = :encryptedDbKey, #receivedSignature = :receivedSignature'
        + ' REMOVE #ttl, #wrappedDbKey, #ephemeralPublicKey, #signedEphemeralPublicKey',
      ExpressionAttributeNames: {
        '#encryptedDbKey': 'encrypted-db-key',
        '#receivedSignature': 'received-signature',
        '#ttl': 'ttl',
        '#wrappedDbKey': 'wrapped-db-key',
        '#ephemeralPublicKey': 'ephemeral-public-key',
        '#signedEphemeralPublicKey': 'signed-ephemeral-public-key',
      },
      ExpressionAttributeValues: {
        ':encryptedDbKey': encryptedDbKey,
        ':receivedSignature': receivedSignature,
      }
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.update(params).promise()

    return responseBuilder.successResponse('Success!')
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) {
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to save database')
    }
  }
}

exports.modifyDatabasePermissions = async function (logChildObject, sender, dbId, dbNameHash, recipientUsername, readOnly, resharingAllowed, revoke) {
  try {
    const { database, senderUserDb, recipient } = await _validateShareDatabase(sender, dbId, dbNameHash, recipientUsername, readOnly, revoke)
    const recipientUserDb = await _getUserDatabaseByUserIdAndDatabaseId(recipient['user-id'], senderUserDb['database-id'])

    if (recipientUserDb && recipientUserDb['user-id'] === database['owner-id']) throw {
      status: statusCodes['Forbidden'],
      error: { message: 'ModifyingOwnerPermissionsNotAllowed' }
    }

    const params = {
      TableName: setup.userDatabaseTableName,
      Key: {
        'user-id': recipientUserDb['user-id'],
        'database-name-hash': recipientUserDb['database-name-hash'],
      },
    }

    if (revoke) {
      // only need to delete if recipient has access to database
      if (recipientUserDb) {
        const ddbClient = connection.ddbClient()
        await ddbClient.delete(params).promise()
      }

    } else {
      if (readOnly === undefined && resharingAllowed === undefined) throw {
        status: statusCodes['Bad Request'],
        error: { message: 'ParamsMissing' }
      }

      if (!recipientUserDb) throw {
        status: statusCodes['Not Found'],
        error: { message: 'DatabaseNotFound' }
      }

      params.UpdateExpression = ''
      params.ExpressionAttributeNames = {}
      params.ExpressionAttributeValues = {}

      if (readOnly !== undefined) {
        if (typeof readOnly !== 'boolean') throw {
          status: statusCodes['Bad Request'],
          error: { message: 'ReadOnlyMustBeBoolean' }
        }

        // only update if necessary
        if (readOnly !== recipientUserDb['read-only']) {
          params.UpdateExpression += 'SET #readOnly = :readOnly'
          params.ExpressionAttributeNames['#readOnly'] = 'read-only'
          params.ExpressionAttributeValues[':readOnly'] = readOnly
        }
      }

      if (resharingAllowed !== undefined) {
        if (typeof resharingAllowed !== 'boolean') throw {
          status: statusCodes['Bad Request'],
          error: { message: 'ResharingAllowedMustBeBoolean' }
        }

        // only update if necessary
        if (resharingAllowed !== recipientUserDb['resharing-allowed']) {
          params.UpdateExpression += (params.UpdateExpression ? ', ' : 'SET ') + '#resharingAllowed = :resharingAllowed'
          params.ExpressionAttributeNames['#resharingAllowed'] = 'resharing-allowed'
          params.ExpressionAttributeValues[':resharingAllowed'] = resharingAllowed
        }
      }

      // only need to update if necessary
      if (params.UpdateExpression) {
        const ddbClient = connection.ddbClient()
        await ddbClient.update(params).promise()
      }
    }

    return responseBuilder.successResponse('Success!')
  } catch (e) {
    logChildObject.err = e

    if (e.status && e.error) {
      return responseBuilder.errorResponse(e.status, e.error)
    } else {
      return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to modify database permissions')
    }
  }
}

const _validateDatabaseId = (databaseId) => {
  if (!databaseId) throw { status: statusCodes['Bad Request'], error: { message: 'Database ID missing.' } }
  if (typeof databaseId !== 'string') throw { status: statusCodes['Bad Request'], error: { message: 'Database ID must be a string.' } }

  // can be less than UUID length because of test app + default admin app
  if (databaseId.length > UUID_STRING_LENGTH) throw { status: statusCodes['Bad Request'], error: { message: 'Database ID is incorrect length.' } }
}

const _validateListUsersForDatabaseLastEvaluatedKey = (lastEvaluatedKey, databaseId) => {
  userController._validateUserId(lastEvaluatedKey['user-id'])
  _validateDatabaseId(lastEvaluatedKey['database-id'])

  if (databaseId !== lastEvaluatedKey['database-id']) throw 'Token database ID must match authenticated app ID'
  if (!lastEvaluatedKey['database-name-hash']) throw 'Token database name hash invalid'
  if (Object.keys(lastEvaluatedKey).length !== 3) throw 'Token must only have 3 keys'
}

const _getUsersForDbQuery = async function (databaseId, lastEvaluatedKey) {
  const params = {
    TableName: setup.userDatabaseTableName,
    IndexName: setup.userDatabaseIdIndex,
    KeyConditionExpression: '#dbId = :dbId',
    ExpressionAttributeNames: {
      '#dbId': 'database-id',
    },
    ExpressionAttributeValues: {
      ':dbId': databaseId,
    },
  }

  if (lastEvaluatedKey) params.ExclusiveStartKey = lastEvaluatedKey

  const ddbClient = connection.ddbClient()
  const usersResponse = await ddbClient.query(params).promise()
  return usersResponse
}

const _buildUsersForDbList = (usersResponse, ownerId) => {
  const result = {
    users: usersResponse.Items.map(user => {
      const isOwner = user['user-id'] === ownerId
      return {
        userId: user['user-id'],
        isOwner,
        readOnly: isOwner ? false : user['read-only'],
        resharingAllowed: isOwner ? true : user['resharing-allowed'],
      }
    }),
  }

  if (usersResponse.LastEvaluatedKey) {
    result.nextPageToken = lastEvaluatedKeyToNextPageToken(usersResponse.LastEvaluatedKey)
  }

  return result
}


exports.listUsersForDatabaseWithPagination = async function (req, res) {
  let logChildObject
  try {
    const databaseId = req.params.databaseId
    const nextPageToken = req.query.nextPageToken

    logChildObject = { ...res.locals.logChildObject, databaseId, nextPageToken }
    logger.child(logChildObject).info('Listing users from Admin API')

    _validateDatabaseId(databaseId)

    // get database stuff
    const db = await dbController.findDatabaseByDatabaseId(databaseId)
    if (!db) throw {
      status: statusCodes['Not Found'],
      error: { message: 'Database not found.' }
    }
    const ownerId = db['owner-id']

    // get user stuff from db owner
    const owner = await userController.getUserByUserId(ownerId)
    if (!owner || owner.deleted) throw {
      status: statusCodes['Not Found'],
      error: { message: 'Database not found.' }
    }
    const appId = owner['app-id']

    const lastEvaluatedKey = nextPageTokenToLastEvaluatedKey(
      nextPageToken,
      (lastEvaluatedKey) => _validateListUsersForDatabaseLastEvaluatedKey(lastEvaluatedKey, databaseId)
    )

    const admin = res.locals.admin
    const adminId = admin['admin-id']

    const [app, usersResponse] = await Promise.all([
      appController.getAppByAppId(appId),
      _getUsersForDbQuery(db['database-id'], lastEvaluatedKey),
    ])

    try {
      appController._validateAppResponseToGetApp(app, adminId, logChildObject)
    } catch (err) {
      if (err.error && err.error.message === 'App not found.') {
        throw {
          status: statusCodes['Not Found'],
          error: { message: 'Database not found.' }
        }
      }
      throw err
    }

    const result = _buildUsersForDbList(usersResponse, ownerId)

    logChildObject.statusCode = statusCodes['Success']
    logger.child(logChildObject).info("Successfully listed one database's users from Admin API")

    return res.status(statusCodes['Success']).send(result)
  } catch (e) {
    const message = 'Failed to list users for one database.'

    if (e.status && e.error) {
      logger.child({ ...logChildObject, statusCode: e.status, err: e.error }).info(message)
      return res.status(e.status).send(e.error)
    } else {
      const statusCode = statusCodes['Internal Server Error']
      logger.child({ ...logChildObject, statusCode, err: e, }).error(message)
      return res.status(statusCode).send({ message })
    }
  }
}
