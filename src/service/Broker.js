const R = require('ramda');
const jayson = require('jayson');
const random = require('randomstring');
const golos = require('golos-js');
const core = require('gls-core-service');
const logger = core.Logger;
const stats = core.Stats.client;
const BasicService = core.service.Basic;
const env = require('../Env');
const errors = require('../Error');

class Broker extends BasicService {
    constructor(InnerGate, FrontendGate) {
        super();

        this._innerGate = new InnerGate();
        this._frontendGate = new FrontendGate();
        this._userMapping = new Map(); // channelId -> user
        this._pipeMapping = new Map(); // channelId -> pipe
        this._secretMapping = new Map(); // channelId -> secret
    }

    async start() {
        const inner = this._innerGate;
        const front = this._frontendGate;

        await inner.start({
            serverRoutes: {
                transfer: this._transferToClient.bind(this),
            },
            requiredClients: {
                notify: env.GLS_FACADE_CONNECT,
            },
        });

        await front.start(async (channelId, data, pipe) => {
            if (R.is(String, data)) {
                await this._handleFrontendEvent(channelId, data, pipe);
            } else {
                await this._handleRequest(channelId, data, pipe);
            }
        });

        this.addNested(inner, front);
    }

    async stop() {
        await this.stopNested();
    }

    async _handleFrontendEvent(channelId, event, pipe) {
        const userMap = this._userMapping;
        const pipeMap = this._pipeMapping;
        const secretMap = this._secretMapping;

        switch (event) {
            case 'open':
                const secret = random.generate();
                const request = this._makeAuthRequestObject(secret);

                userMap.set(channelId, null);
                secretMap.set(channelId, secret);

                pipe(request);
                break;

            case 'close':
            case 'error':
                userMap.delete(channelId);
                pipeMap.delete(channelId);
                secretMap.delete(channelId);
                break;
        }
    }

    async _handleRequest(channelId, data, pipe) {
        const parsedData = await this._parseRequest(data);

        if (parsedData.error) {
            pipe(parsedData);
            return;
        }

        if (this._userMapping.get(channelId) === null) {
            await this._authClient(channelId, data, pipe);
        } else {
            await this._handleClientRequest(channelId, data, pipe);
        }
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

    async _authClient(channelId, data, pipe) {
        const timer = new Date();

        if (!this._validateClientAuth(data)) {
            pipe(errors.E406);
            return;
        }

        const { user, sign } = data.params;
        const secret = this._secretMapping.get(channelId);
        const signObject = this._makeUserFakeTransactionObject(user, sign, secret);

        try {
            await golos.api.verifyAuthorityAsync(signObject);
        } catch (error) {
            pipe(errors.E403);

            stats.timing('user_failure_auth', new Date() - timer);
            return;
        }

        pipe(this._makeResponseObject(['Passed'], data.id));

        this._userMapping.set(channelId, user);
        this._pipeMapping.set(channelId, pipe);

        stats.timing('user_auth', new Date() - timer);
    }

    _validateClientAuth(data) {
        const params = data.params;

        if (!params) {
            return false;
        }

        return R.all(R.is(String), [params.user, params.sign]);
    }

    _makeUserFakeTransactionObject(user, sign, secret) {
        return {
            ref_block_num: 3367,
            ref_block_prefix: 879276768,
            expiration: '2018-07-06T14:52:24',
            operations: [
                [
                    'vote',
                    {
                        voter: user,
                        author: 'test',
                        permlink: secret,
                        weight: 1,
                    },
                ],
            ],
            extensions: [],
            signatures: [sign],
        };
    }

    async _handleClientRequest(channelId, data, pipe) {
        const serviceName = this._getTargetServiceName(data);
        const method = this._normalizeMethodName(data);
        const translate = this._makeTranslateToServiceData(channelId, data);

        try {
            const response = await this._innerGate.sendTo(serviceName, method, translate);

            response.id = data.id;

            pipe(response);
        } catch (error) {
            stats.increment(`pass_data_to_${serviceName}_error`);
            logger.error(
                `Fail to pass data from client to service - [${serviceName}, ${method}] - ${error}`
            );

            pipe(errors.E503);
        }
    }

    _getTargetServiceName(data) {
        let path = data.method.split('.');

        return path[0];
    }

    _normalizeMethodName(data) {
        return data.method
            .split('.')
            .slice(1)
            .join();
    }

    _makeTranslateToServiceData(channelId, data) {
        return {
            _frontendGate: true,
            channelId,
            requestId: data.id,
            user: this._userMapping.get(channelId),
            params: data.params,
        };
    }

    async _transferToClient(data) {
        const { channelId, requestId, error, result } = data;
        const pipe = this._pipeMapping.get(channelId);

        if (!pipe) {
            throw errors.E404.error;
        }

        try {
            let response;

            if (error) {
                response = this._makeResponseErrorObject(error);
            } else {
                response = this._makeResponseObject(result, requestId);
            }

            pipe(response);
        } catch (error) {
            throw errors.E500.error;
        }

        return 'Ok';
    }

    _makeAuthRequestObject(secret) {
        return jayson.utils.request('sign', [secret], null);
    }

    _makeResponseObject(data, id = null) {
        return jayson.utils.response(null, data, id);
    }

    _makeResponseErrorObject({ code, message }) {
        return errors.makeRPCErrorObject(code, message);
    }
}

module.exports = Broker;
