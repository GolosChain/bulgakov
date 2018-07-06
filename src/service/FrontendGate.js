const WebSocket = require('ws');
const uuid = require('uuid');
const core = require('griboyedov');
const logger = core.Logger;
const stats = core.Stats.client;
const env = require('../Env');
const BasicService = core.service.Basic;
const errors = require('../Error');

class FrontendGate extends BasicService {
    constructor() {
        super();

        this._server = null;
        this._idMapping = new Map();
        this._deadMapping = new Map();
        this._brokenDropperIntervalId = null;
    }

    async start(callback) {
        logger.info('Make Frontend Gate server...');

        const timer = new Date();
        const port = env.FRONTEND_GATE_LISTEN_PORT;

        this._server = new WebSocket.Server({ port });
        this._callback = callback;

        this._server.on('connection', this._handleConnection.bind(this));
        this._makeBrokenDropper();

        stats.timing('make_gate_server', new Date() - timer);
        logger.info(`Frontend Gate listening at ${port}`);
    }

    async stop() {
        clearInterval(this._brokenDropperIntervalId);

        if (this._server) {
            this._server.close();
        }
    }

    _handleConnection(socket, request) {
        const from = this._getRequestAddressLogString(request);
        const uuidMap = this._idMapping;
        const deadMap = this._deadMapping;

        logger.log(`Frontend Gate connection open - ${from}`);

        uuidMap.set(socket, uuid());
        deadMap.set(socket, false);
        this._notifyCallback(socket, 'open');

        socket.on('message', message => {
            deadMap.set(socket, false);
            this._handleMessage(socket, message, from);
        });

        socket.on('close', () => {
            logger.log(`Frontend Gate connection close - ${from}`);

            uuidMap.delete(socket);
            deadMap.delete(socket);
            this._notifyCallback(socket, 'close');
        });

        socket.on('error', error => {
            logger.log(`Frontend Gate client connection error - ${error}`);

            this._safeTerminateSocket(socket);

            uuidMap.delete(socket);
            deadMap.delete(socket);
            this._notifyCallback(socket, 'error');
        });

        socket.on('pong', () => {
            deadMap.set(socket, false);
        });
    }

    _getRequestAddressLogString(request) {
        const ip = request.connection.remoteAddress;
        const forwardHeader = request.headers['x-forwarded-for'];
        let forward = '';
        let result = ip;

        if (forwardHeader) {
            forward = forwardHeader.split(/\s*,\s*/)[0];
            result += `<= ${forward}`;
        }

        return result;
    }

    _makeBrokenDropper() {
        const deadMap = this._deadMapping;

        this._brokenDropperIntervalId = setInterval(() => {
            for (let socket of deadMap.keys()) {
                if (deadMap.get(socket) === true) {
                    this._safeTerminateSocket(socket);
                    deadMap.delete(socket);
                } else {
                    deadMap.set(socket, true);
                    socket.ping(this._noop);
                }
            }
        }, env.FRONTEND_GATE_TIMEOUT_FOR_CLIENT);
    }

    _handleMessage(socket, message, from) {
        const requestData = this._deserializeMessage(message);

        if (requestData.error) {
            this._handleConnectionError(socket, requestData, from);
        } else {
            this._notifyCallback(socket, requestData);
        }
    }

    _notifyCallback(socket, requestData) {
        const uuid = this._idMapping.get(socket);

        this._callback(uuid, requestData, responseData => {
            socket.send(this._serializeMessage(responseData));
        }).catch(error => {
            logger.error(`Frontend Gate internal server error ${error}`);
            socket.send(this._serializeMessage(errors.E500));
            stats.increment('frontend_gate_internal_server_error');
        });
    }

    _safeTerminateSocket(socket) {
        try {
            socket.terminate();
        } catch (error) {
            // already terminated
        }
    }

    _handleConnectionError(socket, data, from) {
        stats.increment('frontend_gate_connection_error');
        logger.error(
            `Frontend Gate connection error [${from}] - ${data.error}`
        );
    }

    _serializeMessage(data) {
        let result;

        try {
            result = JSON.stringify(data);
        } catch (error) {
            stats.increment('frontend_gate_serialization_error');
            logger.error(`Frontend Gate serialization error - ${error}`);
            result = JSON.stringify(errors.E500);
        }

        return result;
    }

    _deserializeMessage(message) {
        let data;

        try {
            data = JSON.parse(message);
        } catch (error) {
            return { error };
        }

        return data;
    }

    _noop() {
        // just empty function
    }
}

module.exports = FrontendGate;
