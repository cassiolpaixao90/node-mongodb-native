'use strict';

const EventEmitter = require('events');
const MessageStream = require('./message_stream');
const MongoError = require('../core/error').MongoError;
const MongoNetworkError = require('../core/error').MongoNetworkError;
const MongoWriteConcernError = require('../core/error').MongoWriteConcernError;
const CommandResult = require('../core/connection/command_result');
const wp = require('../core/wireprotocol');
const apm = require('../core/connection/apm');
const updateSessionFromResponse = require('../core/sessions').updateSessionFromResponse;
const uuidV4 = require('../core/utils').uuidV4;

const kStream = Symbol('stream');
const kQueue = Symbol('queue');
const kMessageStream = Symbol('messageStream');
const kGeneration = Symbol('generation');
const kLastUseTime = Symbol('lastUseTime');
const kClusterTime = Symbol('clusterTime');
const kDescription = Symbol('description');

class Connection extends EventEmitter {
  constructor(stream, options) {
    super(options);

    this.id = options.id;
    this.address = streamIdentifier(stream);
    this.bson = options.bson;
    this.socketTimeout = typeof options.socketTimeout === 'number' ? options.socketTimeout : 360000;
    this.monitorCommands =
      typeof options.monitorCommands === 'boolean' ? options.monitorCommands : false;
    this.closed = false;
    this.destroyed = false;

    this[kGeneration] = options.generation;
    this[kLastUseTime] = Date.now();

    // setup parser stream and message handling
    this[kQueue] = new Map();
    this[kMessageStream] = new MessageStream(options);
    this[kMessageStream].on('message', messageHandler(this));
    this[kStream] = stream;
    stream.on('error', () => {
      /* ignore errors, listen to `close` instead */
    });

    stream.on('close', () => {
      this.closed = true;
      this[kQueue].forEach(op =>
        op.cb(new MongoNetworkError(`connection ${this.id} to ${this.address} closed`))
      );
      this[kQueue].clear();

      this.emit('close');
    });

    stream.on('timeout', () => {
      this.closed = true;
      this[kQueue].forEach(op =>
        op.cb(new MongoNetworkError(`connection ${this.id} to ${this.address} timed out`))
      );
      this[kQueue].clear();

      this.emit('close');
    });

    // hook the message stream up to the passed in stream
    stream.pipe(this[kMessageStream]);
    this[kMessageStream].pipe(stream);

    if (options.compression) {
      this[kDescription] = { compression: options.compression };
    } else {
      this[kDescription] = undefined;
    }
  }

  get description() {
    return this[kDescription];
  }

  // the `connect` method stores the result of the handshake ismaster on the connection
  set ismaster(response) {
    if (response.compression) {
      const compression = this[kDescription].compression;
      const compressors = compression.compressors;
      response.compression = {
        compressor: compressors.filter(c => response.compression.indexOf(c) !== -1)[0]
      };

      if (compression.zlibCompressionLevel) {
        response.compression.zlibCompressionLevel = compression.zlibCompressionLevel;
      }
    }

    this[kDescription] = response;
  }

  get generation() {
    return this[kGeneration] || 0;
  }

  get idleTime() {
    return Date.now() - this[kLastUseTime];
  }

  get clusterTime() {
    return this[kClusterTime];
  }

  markAvailable() {
    this[kLastUseTime] = Date.now();
  }

  destroy(options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    options = Object.assign({ force: false }, options);
    if (this[kStream] == null || this.destroyed) {
      this.destroyed = true;
      if (typeof callback === 'function') {
        callback();
      }

      return;
    }

    if (options.force) {
      this[kStream].destroy();
      this.destroyed = true;
      if (typeof callback === 'function') {
        callback();
      }

      return;
    }

    this[kStream].end(err => {
      this.destroyed = true;
      if (typeof callback === 'function') {
        callback(err);
      }
    });
  }

  // Wire protocol methods
  command(ns, cmd, options, callback) {
    wp.command(makeServerTrampoline(this), ns, cmd, options, callback);
  }

  query(ns, cmd, cursorState, options, callback) {
    wp.query(makeServerTrampoline(this), ns, cmd, cursorState, options, callback);
  }

  getMore(ns, cursorState, batchSize, options, callback) {
    wp.getMore(makeServerTrampoline(this), ns, cursorState, batchSize, options, callback);
  }

  killCursors(ns, cursorState, callback) {
    wp.killCursors(makeServerTrampoline(this), ns, cursorState, callback);
  }

  insert(ns, ops, options, callback) {
    wp.insert(makeServerTrampoline(this), ns, ops, options, callback);
  }

  update(ns, ops, options, callback) {
    wp.update(makeServerTrampoline(this), ns, ops, options, callback);
  }

  remove(ns, ops, options, callback) {
    wp.remove(makeServerTrampoline(this), ns, ops, options, callback);
  }
}

/// This lets us emulate a legacy `Server` instance so we can work with the existing wire
/// protocol methods. Eventually, the operation executor will return a `Connection` to execute
/// against.
function makeServerTrampoline(connection) {
  return {
    description: connection.description,
    clusterTime: connection[kClusterTime],
    s: {
      bson: connection.bson,
      pool: { write: write.bind(connection) }
    }
  };
}

function messageHandler(conn) {
  return function messageHandler(message) {
    // always emit the message, in case we are streaming
    conn.emit('message', message);
    if (!conn[kQueue].has(message.responseTo)) {
      return;
    }

    const operationDescription = conn[kQueue].get(message.responseTo);
    conn[kQueue].delete(message.responseTo);

    const callback = operationDescription.cb;
    if (operationDescription.socketTimeoutOverride) {
      conn[kStream].setTimeout(conn.socketTimeout);
    }

    try {
      // Pass in the entire description because it has BSON parsing options
      message.parse(operationDescription);
    } catch (err) {
      callback(new MongoError(err));
      return;
    }

    if (message.documents[0]) {
      const document = message.documents[0];
      const session = operationDescription.session;
      if (session) {
        updateSessionFromResponse(session, document);
      }

      if (document.$clusterTime) {
        conn[kClusterTime] = document.$clusterTime;
        conn.emit('clusterTimeReceived', document.$clusterTime);
      }

      if (document.writeConcernError) {
        callback(new MongoWriteConcernError(document.writeConcernError, document));
        return;
      }

      if (document.ok === 0 || document.$err || document.errmsg || document.code) {
        callback(new MongoError(document));
        return;
      }
    }

    // NODE-2382: reenable in our glorious non-leaky abstraction future
    // callback(null, operationDescription.fullResult ? message : message.documents[0]);

    callback(
      undefined,
      new CommandResult(
        operationDescription.fullResult ? message : message.documents[0],
        conn,
        message
      )
    );
  };
}

function streamIdentifier(stream) {
  if (typeof stream.address === 'function') {
    return `${stream.address().address}:${stream.address().port}`;
  }

  return uuidV4().toString('hex');
}

// Not meant to be called directly, the wire protocol methods call this assuming it is a `Pool` instance
function write(command, options, callback) {
  if (typeof options === 'function') {
    callback = options;
  }

  options = options || {};
  const operationDescription = {
    requestId: command.requestId,
    cb: callback,
    session: options.session,
    fullResult: typeof options.fullResult === 'boolean' ? options.fullResult : false,
    noResponse: typeof options.noResponse === 'boolean' ? options.noResponse : false,

    // For BSON parsing
    promoteLongs: typeof options.promoteLongs === 'boolean' ? options.promoteLongs : true,
    promoteValues: typeof options.promoteValues === 'boolean' ? options.promoteValues : true,
    promoteBuffers: typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : false,
    raw: typeof options.raw === 'boolean' ? options.raw : false
  };

  if (this[kDescription] && this[kDescription].compression) {
    operationDescription.agreedCompressor = this[kDescription].compression.compressor;
  }

  if (typeof options.socketTimeout === 'number') {
    operationDescription.socketTimeoutOverride = true;
    this[kStream].setTimeout(options.socketTimeout);
  }

  // if command monitoring is enabled we need to modify the callback here
  if (this.monitorCommands) {
    this.emit('commandStarted', new apm.CommandStartedEvent(this, command));

    operationDescription.started = process.hrtime();
    operationDescription.cb = (err, reply) => {
      if (err) {
        this.emit(
          'commandFailed',
          new apm.CommandFailedEvent(this, command, err, operationDescription.started)
        );
      } else {
        if (reply && reply.result && (reply.result.ok === 0 || reply.result.$err)) {
          this.emit(
            'commandFailed',
            new apm.CommandFailedEvent(this, command, reply.result, operationDescription.started)
          );
        } else {
          this.emit(
            'commandSucceeded',
            new apm.CommandSucceededEvent(this, command, reply, operationDescription.started)
          );
        }
      }

      if (typeof callback === 'function') {
        callback(err, reply);
      }
    };
  }

  if (!operationDescription.noResponse) {
    this[kQueue].set(operationDescription.requestId, operationDescription);
  }

  try {
    this[kMessageStream].writeCommand(command, operationDescription);
  } catch (e) {
    if (!operationDescription.noResponse) {
      this[kQueue].delete(operationDescription.requestId);
      operationDescription.cb(e);
      return;
    }
  }

  if (operationDescription.noResponse) {
    operationDescription.cb();
  }
}

module.exports = {
  Connection
};
