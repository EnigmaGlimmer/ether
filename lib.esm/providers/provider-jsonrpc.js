// @TODO:
// - Add the batching API
// https://playground.open-rpc.org/?schemaUrl=https://raw.githubusercontent.com/ethereum/eth1.0-apis/assembled-spec/openrpc.json&uiSchema%5BappBar%5D%5Bui:splitView%5D=true&uiSchema%5BappBar%5D%5Bui:input%5D=false&uiSchema%5BappBar%5D%5Bui:examplesDropdown%5D=false
import { resolveAddress } from "../address/index.js";
import { hexlify } from "../utils/data.js";
import { FetchRequest } from "../utils/fetch.js";
import { toQuantity } from "../utils/maths.js";
import { defineProperties } from "../utils/properties.js";
import { TypedDataEncoder } from "../hash/typed-data.js";
import { toUtf8Bytes } from "../utils/utf8.js";
import { accessListify } from "../transaction/index.js";
import { AbstractProvider, UnmanagedSubscriber } from "./abstract-provider.js";
import { AbstractSigner } from "./abstract-signer.js";
import { Network } from "./network.js";
import { FilterIdEventSubscriber, FilterIdPendingSubscriber } from "./subscriber-filterid.js";
import { logger } from "../utils/logger.js";
//function copy<T = any>(value: T): T {
//    return JSON.parse(JSON.stringify(value));
//}
const Primitive = "bigint,boolean,function,number,string,symbol".split(/,/g);
//const Methods = "getAddress,then".split(/,/g);
function deepCopy(value) {
    if (value == null || Primitive.indexOf(typeof (value)) >= 0) {
        return value;
    }
    // Keep any Addressable
    if (typeof (value.getAddress) === "function") {
        return value;
    }
    if (Array.isArray(value)) {
        return (value.map(deepCopy));
    }
    if (typeof (value) === "object") {
        return Object.keys(value).reduce((accum, key) => {
            accum[key] = value[key];
            return accum;
        }, {});
    }
    throw new Error(`should not happen: ${value} (${typeof (value)})`);
}
function getLowerCase(value) {
    if (value) {
        return value.toLowerCase();
    }
    return value;
}
function isPollable(value) {
    return (value && typeof (value.pollingInterval) === "number");
}
const defaultOptions = {
    polling: false,
    staticNetwork: null,
    batchStallTime: 10,
    batchMaxSize: (1 << 20),
    batchMaxCount: 100 // 100 requests
};
// @TODO: Unchecked Signers
export class JsonRpcSigner extends AbstractSigner {
    address;
    constructor(provider, address) {
        super(provider);
        defineProperties(this, { address });
    }
    connect(provider) {
        return logger.throwError("cannot reconnect JsonRpcSigner", "UNSUPPORTED_OPERATION", {
            operation: "signer.connect"
        });
    }
    async getAddress() {
        return this.address;
    }
    // JSON-RPC will automatially fill in nonce, etc. so we just check from
    async populateTransaction(tx) {
        return await this.populateCall(tx);
    }
    //async getNetwork(): Promise<Frozen<Network>> {
    //    return await this.provider.getNetwork();
    //}
    //async estimateGas(tx: TransactionRequest): Promise<bigint> {
    //    return await this.provider.estimateGas(tx);
    //}
    //async call(tx: TransactionRequest): Promise<string> {
    //    return await this.provider.call(tx);
    //}
    //async resolveName(name: string | Addressable): Promise<null | string> {
    //    return await this.provider.resolveName(name);
    //}
    //async getNonce(blockTag?: BlockTag): Promise<number> {
    //    return await this.provider.getTransactionCountOf(this.address);
    //}
    // Returns just the hash of the transaction after sent, which is what
    // the bare JSON-RPC API does;
    async sendUncheckedTransaction(_tx) {
        const tx = deepCopy(_tx);
        const promises = [];
        // Make sure the from matches the sender
        if (tx.from) {
            const _from = tx.from;
            promises.push((async () => {
                const from = await resolveAddress(_from, this.provider);
                if (from == null || from.toLowerCase() !== this.address.toLowerCase()) {
                    logger.throwArgumentError("from address mismatch", "transaction", _tx);
                }
                tx.from = from;
            })());
        }
        else {
            tx.from = this.address;
        }
        // The JSON-RPC for eth_sendTransaction uses 90000 gas; if the user
        // wishes to use this, it is easy to specify explicitly, otherwise
        // we look it up for them.
        if (tx.gasLimit == null) {
            promises.push((async () => {
                tx.gasLimit = await this.provider.estimateGas({ ...tx, from: this.address });
            })());
        }
        // The address may be an ENS name or Addressable
        if (tx.to != null) {
            const _to = tx.to;
            promises.push((async () => {
                tx.to = await resolveAddress(_to, this.provider);
            })());
        }
        // Wait until all of our properties are filled in
        if (promises.length) {
            await Promise.all(promises);
        }
        const hexTx = this.provider.getRpcTransaction(tx);
        return this.provider.send("eth_sendTransaction", [hexTx]);
    }
    async sendTransaction(tx) {
        // This cannot be mined any earlier than any recent block
        const blockNumber = await this.provider.getBlockNumber();
        // Send the transaction
        const hash = await this.sendUncheckedTransaction(tx);
        // Unfortunately, JSON-RPC only provides and opaque transaction hash
        // for a response, and we need the actual transaction, so we poll
        // for it; it should show up very quickly
        return await (new Promise((resolve, reject) => {
            const timeouts = [1000, 100];
            const checkTx = async () => {
                // Try getting the transaction
                const tx = await this.provider.getTransaction(hash);
                if (tx != null) {
                    resolve(this.provider._wrapTransaction(tx, hash, blockNumber));
                    return;
                }
                // Wait another 4 seconds
                this.provider._setTimeout(() => { checkTx(); }, timeouts.pop() || 4000);
            };
            checkTx();
        }));
    }
    async signTransaction(_tx) {
        const tx = deepCopy(_tx);
        // Make sure the from matches the sender
        if (tx.from) {
            const from = await resolveAddress(tx.from, this.provider);
            if (from == null || from.toLowerCase() !== this.address.toLowerCase()) {
                return logger.throwArgumentError("from address mismatch", "transaction", _tx);
            }
            tx.from = from;
        }
        else {
            tx.from = this.address;
        }
        const hexTx = this.provider.getRpcTransaction(tx);
        return await this.provider.send("eth_sign_Transaction", [hexTx]);
    }
    async signMessage(_message) {
        const message = ((typeof (_message) === "string") ? toUtf8Bytes(_message) : _message);
        return await this.provider.send("personal_sign", [
            hexlify(message), this.address.toLowerCase()
        ]);
    }
    async signTypedData(domain, types, _value) {
        const value = deepCopy(_value);
        // Populate any ENS names (in-place)
        const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (value) => {
            const address = await resolveAddress(value);
            if (address == null) {
                return logger.throwArgumentError("TypedData does not support null address", "value", value);
            }
            return address;
        });
        return await this.provider.send("eth_signTypedData_v4", [
            this.address.toLowerCase(),
            JSON.stringify(TypedDataEncoder.getPayload(populated.domain, types, populated.value))
        ]);
    }
    async unlock(password) {
        return this.provider.send("personal_unlockAccount", [
            this.address.toLowerCase(), password, null
        ]);
    }
    // https://github.com/ethereum/wiki/wiki/JSON-RPC#eth_sign
    async _legacySignMessage(_message) {
        const message = ((typeof (_message) === "string") ? toUtf8Bytes(_message) : _message);
        return await this.provider.send("eth_sign", [
            this.address.toLowerCase(), hexlify(message)
        ]);
    }
}
export class JsonRpcApiProvider extends AbstractProvider {
    #options;
    #nextId;
    #payloads;
    #drainTimer;
    constructor(network, options) {
        super(network);
        this.#nextId = 1;
        this.#options = Object.assign({}, defaultOptions, options || {});
        this.#payloads = [];
        this.#drainTimer = null;
        // This could be relaxed in the future to just check equivalent networks
        const staticNetwork = this._getOption("staticNetwork");
        if (staticNetwork && staticNetwork !== network) {
            logger.throwArgumentError("staticNetwork MUST match network object", "options", options);
        }
    }
    _getOption(key) {
        return this.#options[key];
    }
    // @TODO: Merge this into send
    //prepareRequest(method: string, params: Array<any>): JsonRpcPayload {
    //    return {
    //        method, params, id: (this.#nextId++), jsonrpc: "2.0"
    //    };
    //}
    /*
        async send<T = any>(method: string, params: Array<any>): Promise<T> {
            // @TODO: This should construct and queue the payload
            throw new Error("sub-class must implement this");
        }
    */
    #scheduleDrain() {
        if (this.#drainTimer) {
            return;
        }
        this.#drainTimer = setTimeout(() => {
            this.#drainTimer = null;
            const payloads = this.#payloads;
            this.#payloads = [];
            while (payloads.length) {
                // Create payload batches that satisfy our batch constraints
                const batch = [(payloads.shift())];
                while (payloads.length) {
                    if (batch.length === this.#options.batchMaxCount) {
                        break;
                    }
                    batch.push((payloads.shift()));
                    const bytes = JSON.stringify(batch.map((p) => p.payload));
                    if (bytes.length > this.#options.batchMaxSize) {
                        payloads.unshift((batch.pop()));
                        break;
                    }
                }
                // Process the result to each payload
                (async () => {
                    const payload = ((batch.length === 1) ? batch[0].payload : batch.map((p) => p.payload));
                    this.emit("debug", { action: "sendRpcPayload", payload });
                    try {
                        const result = await this._send(payload);
                        this.emit("debug", { action: "receiveRpcResult", result });
                        // Process results in batch order
                        for (const { resolve, reject, payload } of batch) {
                            // Find the matching result
                            const resp = result.filter((r) => (r.id === payload.id))[0];
                            // No result; the node failed us in unexpected ways
                            if (resp == null) {
                                return reject(new Error("@TODO: no result"));
                            }
                            // The response is an error
                            if ("error" in resp) {
                                return reject(this.getRpcError(payload, resp));
                            }
                            // All good; send the result
                            resolve(resp.result);
                        }
                    }
                    catch (error) {
                        this.emit("debug", { action: "receiveRpcError", error });
                        for (const { reject } of batch) {
                            // @TODO: augment the error with the payload
                            reject(error);
                        }
                    }
                })();
            }
        }, this.#options.batchStallTime);
    }
    // Sub-classes should **NOT** override this
    send(method, params) {
        // @TODO: cache chainId?? purge on switch_networks
        const id = this.#nextId++;
        const promise = new Promise((resolve, reject) => {
            this.#payloads.push({
                resolve, reject,
                payload: { method, params, id, jsonrpc: "2.0" }
            });
        });
        // If there is not a pending drainTimer, set one
        this.#scheduleDrain();
        return promise;
    }
    // Sub-classes MUST override this
    _send(payload) {
        return logger.throwError("sub-classes must override _send", "UNSUPPORTED_OPERATION", {
            operation: "jsonRpcApiProvider._send"
        });
    }
    async getSigner(address = 0) {
        const accountsPromise = this.send("eth_accounts", []);
        // Account index
        if (typeof (address) === "number") {
            const accounts = (await accountsPromise);
            if (address > accounts.length) {
                throw new Error("no such account");
            }
            return new JsonRpcSigner(this, accounts[address]);
        }
        const [network, accounts] = await Promise.all([this.getNetwork(), accountsPromise]);
        // Account address
        address = network.formatter.address(address);
        for (const account of accounts) {
            if (network.formatter.address(account) === account) {
                return new JsonRpcSigner(this, account);
            }
        }
        throw new Error("invalid account");
    }
    // Sub-classes can override this; it detects the *actual* network we
    // are connected to
    async _detectNetwork() {
        // We have a static network (like INFURA)
        const network = this._getOption("staticNetwork");
        if (network) {
            return network;
        }
        return Network.from(logger.getBigInt(await this._perform({ method: "chainId" })));
    }
    _getSubscriber(sub) {
        // Pending Filters aren't availble via polling
        if (sub.type === "pending") {
            return new FilterIdPendingSubscriber(this);
        }
        if (sub.type === "event") {
            return new FilterIdEventSubscriber(this, sub.filter);
        }
        // Orphaned Logs are handled automatically, by the filter, since
        // logs with removed are emitted by it
        if (sub.type === "orphan" && sub.filter.orphan === "drop-log") {
            return new UnmanagedSubscriber("orphan");
        }
        return super._getSubscriber(sub);
    }
    // Normalize a JSON-RPC transaction
    getRpcTransaction(tx) {
        const result = {};
        // JSON-RPC now requires numeric values to be "quantity" values
        ["chainId", "gasLimit", "gasPrice", "type", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "value"].forEach((key) => {
            if (tx[key] == null) {
                return;
            }
            let dstKey = key;
            if (key === "gasLimit") {
                dstKey = "gas";
            }
            result[dstKey] = toQuantity(logger.getBigInt(tx[key], `tx.${key}`));
        });
        // Make sure addresses and data are lowercase
        ["from", "to", "data"].forEach((key) => {
            if (tx[key] == null) {
                return;
            }
            result[key] = hexlify(tx[key]);
        });
        // Normalize the access list object
        if (tx.accessList) {
            result["accessList"] = accessListify(tx.accessList);
        }
        return result;
    }
    // Get the necessary paramters for making a JSON-RPC request
    getRpcRequest(req) {
        switch (req.method) {
            case "chainId":
                return { method: "eth_chainId", args: [] };
            case "getBlockNumber":
                return { method: "eth_blockNumber", args: [] };
            case "getGasPrice":
                return { method: "eth_gasPrice", args: [] };
            case "getBalance":
                return {
                    method: "eth_getBalance",
                    args: [getLowerCase(req.address), req.blockTag]
                };
            case "getTransactionCount":
                return {
                    method: "eth_getTransactionCount",
                    args: [getLowerCase(req.address), req.blockTag]
                };
            case "getCode":
                return {
                    method: "eth_getCode",
                    args: [getLowerCase(req.address), req.blockTag]
                };
            case "getStorageAt":
                return {
                    method: "eth_getStorageAt",
                    args: [
                        getLowerCase(req.address),
                        ("0x" + req.position.toString(16)),
                        req.blockTag
                    ]
                };
            case "broadcastTransaction":
                return {
                    method: "eth_sendRawTransaction",
                    args: [req.signedTransaction]
                };
            case "getBlock":
                if ("blockTag" in req) {
                    return {
                        method: "eth_getBlockByNumber",
                        args: [req.blockTag, !!req.includeTransactions]
                    };
                }
                else if ("blockHash" in req) {
                    return {
                        method: "eth_getBlockByHash",
                        args: [req.blockHash, !!req.includeTransactions]
                    };
                }
                break;
            case "getTransaction":
                return {
                    method: "eth_getTransactionByHash",
                    args: [req.hash]
                };
            case "getTransactionReceipt":
                return {
                    method: "eth_getTransactionReceipt",
                    args: [req.hash]
                };
            case "call":
                return {
                    method: "eth_call",
                    args: [this.getRpcTransaction(req.transaction), req.blockTag]
                };
            case "estimateGas": {
                return {
                    method: "eth_estimateGas",
                    args: [this.getRpcTransaction(req.transaction)]
                };
            }
            case "getLogs":
                if (req.filter && req.filter.address != null) {
                    if (Array.isArray(req.filter.address)) {
                        req.filter.address = req.filter.address.map(getLowerCase);
                    }
                    else {
                        req.filter.address = getLowerCase(req.filter.address);
                    }
                }
                return { method: "eth_getLogs", args: [req.filter] };
        }
        return null;
    }
    getRpcError(payload, error) {
        console.log("getRpcError", payload, error);
        return new Error(`JSON-RPC badness; @TODO: ${error}`);
        /*
            if (payload.method === "eth_call") {
                const result = spelunkData(error);
                if (result) {
                    // @TODO: Extract errorSignature, errorName, errorArgs, reason if
                    //        it is Error(string) or Panic(uint25)
                    return logger.makeError("execution reverted during JSON-RPC call", "CALL_EXCEPTION", {
                        data: result.data,
                        transaction: args[0]
                    });
                }
    
                return logger.makeError("missing revert data during JSON-RPC call", "CALL_EXCEPTION", {
                    data: "0x", transaction: args[0], info: { error }
                });
            }
    
            if (method === "eth_estimateGas") {
                // @TODO: Spelunk, and adapt the above to allow missing data.
                //        Then throw an UNPREDICTABLE_GAS exception
            }
    
            const message = JSON.stringify(spelunkMessage(error));
    
            if (message.match(/insufficient funds|base fee exceeds gas limit/)) {
                return logger.makeError("insufficient funds for intrinsic transaction cost", "INSUFFICIENT_FUNDS", {
                    transaction: args[0]
                });
            }
    
            if (message.match(/nonce/) && message.match(/too low/)) {
                return logger.makeError("nonce has already been used", "NONCE_EXPIRED", {
                    transaction: args[0]
                });
            }
    
            // "replacement transaction underpriced"
            if (message.match(/replacement transaction/) && message.match(/underpriced/)) {
                return logger.makeError("replacement fee too low", "REPLACEMENT_UNDERPRICED", {
                    transaction: args[0]
                });
            }
    
            if (message.match(/only replay-protected/)) {
                return logger.makeError("legacy pre-eip-155 transactions not supported", "UNSUPPORTED_OPERATION", {
                    operation: method, info: { transaction: args[0] }
                });
            }
    
            if (method === "estimateGas" && message.match(/gas required exceeds allowance|always failing transaction|execution reverted/)) {
                return logger.makeError("cannot estimate gas; transaction may fail or may require manual gas limit", "UNPREDICTABLE_GAS_LIMIT", {
                    transaction: args[0]
                });
            }
    
            return error;
            */
    }
    async _perform(req) {
        // Legacy networks do not like the type field being passed along (which
        // is fair), so we delete type if it is 0 and a non-EIP-1559 network
        if (req.method === "call" || req.method === "estimateGas") {
            let tx = req.transaction;
            if (tx && tx.type != null && logger.getBigInt(tx.type)) {
                // If there are no EIP-1559 properties, it might be non-EIP-a559
                if (tx.maxFeePerGas == null && tx.maxPriorityFeePerGas == null) {
                    const feeData = await this.getFeeData();
                    if (feeData.maxFeePerGas == null && feeData.maxPriorityFeePerGas == null) {
                        // Network doesn't know about EIP-1559 (and hence type)
                        req = Object.assign({}, req, {
                            transaction: Object.assign({}, tx, { type: undefined })
                        });
                    }
                }
            }
        }
        const request = this.getRpcRequest(req);
        if (request != null) {
            return await this.send(request.method, request.args);
            /*
              @TODO: Add debug output to send
                        this.emit("debug", { type: "sendRequest", request });
                        try {
                            const result =
                            //console.log("RR", result);
                            this.emit("debug", { type: "getResponse", result });
                            return result;
                        } catch (error) {
                            this.emit("debug", { type: "getError", error });
                            throw error;
                            //throw this.getRpcError(request.method, request.args, <Error>error);
                        }
            */
        }
        return super._perform(req);
    }
}
export class JsonRpcProvider extends JsonRpcApiProvider {
    #connect;
    #pollingInterval;
    constructor(url, network, options) {
        if (url == null) {
            url = "http:/\/localhost:8545";
        }
        super(network, options);
        if (typeof (url) === "string") {
            this.#connect = new FetchRequest(url);
        }
        else {
            this.#connect = url.clone();
        }
        this.#pollingInterval = 4000;
    }
    async _send(payload) {
        // Configure a POST connection for the requested method
        const request = this.#connect.clone();
        request.body = JSON.stringify(payload);
        const response = await request.send();
        response.assertOk();
        let resp = response.bodyJson;
        if (!Array.isArray(resp)) {
            resp = [resp];
        }
        return resp;
    }
    get pollingInterval() { return this.#pollingInterval; }
    set pollingInterval(value) {
        if (!Number.isInteger(value) || value < 0) {
            throw new Error("invalid interval");
        }
        this.#pollingInterval = value;
        this._forEachSubscriber((sub) => {
            if (isPollable(sub)) {
                sub.pollingInterval = this.#pollingInterval;
            }
        });
    }
}
// This class should only be used when it is not possible for the
// underlying network to change, such as with INFURA. If you are
// using MetaMask or some other client which allows users to change
// their network DO NOT USE THIS. Bad things will happen.
/*
export class StaticJsonRpcProvider extends JsonRpcProvider {
    readonly network!: Network;

    constructor(url: string | ConnectionInfo, network?: Network, options?: JsonRpcOptions) {
        super(url, network, options);
        defineProperties<StaticJsonRpcProvider>(this, { network });
    }

    async _detectNetwork(): Promise<Network> {
        return this.network;
    }
}
*/
/*
function spelunkData(value: any): null | { message: string, data: string } {
    if (value == null) { return null; }

    // These *are* the droids we're looking for.
    if (typeof(value.message) === "string" && value.message.match("reverted") && isHexString(value.data)) {
        return { message: value.message, data: value.data };
    }

    // Spelunk further...
    if (typeof(value) === "object") {
        for (const key in value) {
            const result = spelunkData(value[key]);
            if (result) { return result; }
        }
        return null;
    }

    // Might be a JSON string we can further descend...
    if (typeof(value) === "string") {
        try {
            return spelunkData(JSON.parse(value));
        } catch (error) { }
    }

    return null;
}

function _spelunkMessage(value: any, result: Array<string>): void {
    if (value == null) { return; }

    // These *are* the droids we're looking for.
    if (typeof(value.message) === "string") {
        result.push(value.message);
    }

    // Spelunk further...
    if (typeof(value) === "object") {
        for (const key in value) {
            _spelunkMessage(value[key], result);
        }
    }

    // Might be a JSON string we can further descend...
    if (typeof(value) === "string") {
        try {
            return _spelunkMessage(JSON.parse(value), result);
        } catch (error) { }
    }
}

function spelunkMessage(value: any): Array<string> {
    const result: Array<string> = [ ];
    _spelunkMessage(value, result);
    return result;
}
*/
//# sourceMappingURL=provider-jsonrpc.js.map