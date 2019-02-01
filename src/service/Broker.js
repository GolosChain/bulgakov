const R = require('ramda');
const jayson = require('jayson');
const core = require('gls-core-service');
const logger = core.utils.Logger;
const stats = core.utils.statsClient;
const BasicService = core.services.Basic;
const RpcObject = core.utils.RpcObject;
const env = require('../env');

class Broker extends BasicService {
    constructor(InnerGate, FrontendGate) {
        super();

        this._innerGate = new InnerGate();
        this._frontendGate = new FrontendGate();
        this._pipeMapping = new Map(); // channelId -> pipe
        this._authMapping = new Map(); // channelId -> auth data
    }

    async start() {
        const inner = this._innerGate;
        const front = this._frontendGate;

        await inner.start({
            serverRoutes: {
                transfer: this._transferToClient.bind(this),
            },
            requiredClients: {
                facade: env.GLS_FACADE_CONNECT,
                auth: env.GLS_AUTH_CONNECT,
            },
        });

        await front.start(async ({ channelId, clientRequestIp }, data, pipe) => {
            if (R.is(String, data)) {
                await this._handleFrontendEvent(channelId, data, pipe);
            } else {
                await this._handleRequest({ channelId, clientRequestIp }, data, pipe);
            }
        });

        this.addNested(inner, front);
    }

    async stop() {
        await this.stopNested();
    }

    async _handleFrontendEvent(channelId, event, pipe) {
        const pipeMap = this._pipeMapping;
        const authMap = this._authMapping;

        switch (event) {
            case 'open':
                const { secret } = await this._innerGate.callService(
                    'auth',
                    'auth.generateSecret',
                    {
                        channelId,
                    }
                );

                const request = this._makeAuthRequestObject(secret);

                pipe(request);
                break;

            case 'close':
            case 'error':
                const auth = authMap.get(channelId);
                const user = auth.user;

                pipeMap.delete(channelId);
                authMap.delete(channelId);

                if (user) {
                    await this._notifyAboutOffline({ user, channelId });
                }
                break;
        }
    }

    async _handleRequest({ channelId, clientRequestIp }, data, pipe) {
        const parsedData = await this._parseRequest(data);

        if (parsedData.error) {
            pipe(parsedData);
            return;
        }

        await this._handleClient({ channelId, clientRequestIp }, data, pipe);
    }

    _parseRequest(data) {
        return new Promise((resolve, reject) => {
            const fakeJaysonRouter = {
                router: () => new jayson.Method(() => resolve(data)),
            };
            const fakeJaysonServer = jayson.server({}, fakeJaysonRouter);

            try {
                fakeJaysonServer.call(data, rpcError => resolve(rpcError));
            } catch (parseError) {
                reject(parseError);
            }
        });
    }

    async _handleClient({ channelId, clientRequestIp }, data, pipe) {
        try {
            let response = {};

            switch (data.method) {
                case 'auth.generateSecret':
                    response = await this._innerGate.sendTo('auth', data.method, {
                        ...data.params,
                        channelId,
                    });
                    break;

                case 'auth.authorize':
                    response = await this._innerGate.sendTo('auth', data.method, {
                        ...data.params,
                        channelId,
                    });
                    if (response.error) {
                        throw error;
                    }
                    this._authMapping.set(channelId, response.result);
                    break;
                default: {
                    const translate = this._makeTranslateToServiceData(
                        { channelId, clientRequestIp },
                        data
                    );

                    response = await this._innerGate.sendTo('facade', data.method, translate);
                    break;
                }
            }

            response.id = data.id;

            pipe(response);
        } catch (error) {
            stats.increment(`pass_data_error`);
            logger.error(`Fail to pass data from client to facade - ${error}`);

            pipe(RpcObject.error(1104, 'Fail to pass data from client to facade'));
        }
    }

    _makeTranslateToServiceData({ channelId, clientRequestIp }, data) {
        return {
            _frontendGate: true,
            auth: this._authMapping.get(channelId),
            routing: {
                requestId: data.id,
                channelId,
            },
            meta: {
                clientRequestIp,
            },
            params: data.params || {},
        };
    }

    async _transferToClient(data) {
        const { channelId, method, error, result } = data;
        const pipe = this._pipeMapping.get(channelId);

        if (!pipe) {
            throw { code: 1105, message: 'Cant transfer to client - not found' };
        }

        try {
            let response;

            if (error) {
                response = this._makeNotifyToClientObject(method, { error });
            } else {
                response = this._makeNotifyToClientObject(method, { result });
            }

            pipe(response);
        } catch (error) {
            throw { code: 1106, message: 'Notify client fatal error' };
        }

        return 'Ok';
    }

    async _notifyAboutOffline({ user, channelId }) {
        await this._innerGate.sendTo('facade', 'offline', { channelId, user });
    }

    _makeAuthRequestObject(secret) {
        return this._makeNotifyToClientObject('sign', { secret });
    }

    _makeNotifyToClientObject(method, data) {
        return RpcObject.request(method, data, 'rpc-notify');
    }
}

module.exports = Broker;
