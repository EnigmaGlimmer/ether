import { Transaction } from "../transaction/index.js";
import {
    defineProperties, getBigInt, resolveProperties,
    assertArgument, throwError
} from "../utils/index.js";

import type { TypedDataDomain, TypedDataField } from "../hash/index.js";
import type { TransactionLike } from "../transaction/index.js";

import type {
    BlockTag, Provider, TransactionRequest, TransactionResponse
} from "./provider.js";
import type { Signer } from "./signer.js";


export abstract class AbstractSigner<P extends null | Provider = null | Provider> implements Signer {
    readonly provider!: P;

    constructor(provider?: P) {
        defineProperties<AbstractSigner>(this, { provider: (provider || null) });
    }

    abstract getAddress(): Promise<string>;
    abstract connect(provider: null | Provider): Signer;

    #checkProvider(operation: string): Provider {
        if (this.provider) { return this.provider; }
        return throwError("missing provider", "UNSUPPORTED_OPERATION", { operation });
    }

    async getNonce(blockTag?: BlockTag): Promise<number> {
        return this.#checkProvider("getTransactionCount").getTransactionCount(await this.getAddress(), blockTag);
    }

    async #populate(op: string, tx: TransactionRequest): Promise<{ provider: Provider, pop: TransactionLike<string> }> {
        const provider = this.#checkProvider(op);

        //let pop: Deferrable<TransactionRequest> = Object.assign({ }, tx);
        let pop: any = Object.assign({ }, tx);

        if (pop.to != null) {
            pop.to = provider.resolveName(pop.to).then((to) => {
                assertArgument(to != null, "transaction to ENS name not configured", "tx.to", pop.to);
                return to;
            });
        }

        if (pop.from != null) {
            const from = pop.from;
            pop.from = Promise.all([
                this.getAddress(),
                this.resolveName(from)
            ]).then(([ address, from ]) => {
                assertArgument(from && address.toLowerCase() === from.toLowerCase(),
                    "transaction from mismatch", "tx.from", from);
                return address;
            });
        }

        return { pop: await resolveProperties(pop), provider };
    }

    async populateCall(tx: TransactionRequest): Promise<TransactionLike<string>> {
        const { pop }  = await this.#populate("populateCall", tx);

        return pop;
    }

    async populateTransaction(tx: TransactionRequest): Promise<TransactionLike<string>> {
        const { pop, provider } = await this.#populate("populateTransaction", tx);

        if (pop.nonce == null) {
            pop.nonce = await this.getNonce("pending");
        }

        if (pop.gasLimit == null) {
            pop.gasLimit = await this.estimateGas(pop);
        }

        // Populate the chain ID
        const network = await (<Provider>(this.provider)).getNetwork();
        if (pop.chainId != null) {
            const chainId = getBigInt(pop.chainId);
            assertArgument(chainId === network.chainId, "transaction chainId mismatch", "tx.chainId", tx.chainId);
        } else {
            pop.chainId = network.chainId;
        }

        // Do not allow mixing pre-eip-1559 and eip-1559 properties
        const hasEip1559 = (pop.maxFeePerGas != null || pop.maxPriorityFeePerGas != null);
        if (pop.gasPrice != null && (pop.type === 2 || hasEip1559)) {
            assertArgument(false, "eip-1559 transaction do not support gasPrice", "tx", tx);
        } else if ((pop.type === 0 || pop.type === 1) && hasEip1559) {
            assertArgument(false, "pre-eip-1559 transaction do not support maxFeePerGas/maxPriorityFeePerGas", "tx", tx);
        }

        if ((pop.type === 2 || pop.type == null) && (pop.maxFeePerGas != null && pop.maxPriorityFeePerGas != null)) {
            // Fully-formed EIP-1559 transaction (skip getFeeData)
            pop.type = 2;

        } else if (pop.type === 0 || pop.type === 1) {
            // Explicit Legacy or EIP-2930 transaction

            // We need to get fee data to determine things
            const feeData = await provider.getFeeData();

            if (feeData.gasPrice == null) {
                throwError("network does not support gasPrice", "UNSUPPORTED_OPERATION", {
                    operation: "getGasPrice"
                });
            }

            // Populate missing gasPrice
            if (pop.gasPrice == null) { pop.gasPrice = feeData.gasPrice; }

        } else {

            // We need to get fee data to determine things
            const feeData = await provider.getFeeData();

            if (pop.type == null) {
                // We need to auto-detect the intended type of this transaction...

                if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
                    // The network supports EIP-1559!

                    // Upgrade transaction from null to eip-1559
                    pop.type = 2;

                    if (pop.gasPrice != null) {
                        // Using legacy gasPrice property on an eip-1559 network,
                        // so use gasPrice as both fee properties
                        const gasPrice = pop.gasPrice;
                        delete pop.gasPrice;
                        pop.maxFeePerGas = gasPrice;
                        pop.maxPriorityFeePerGas = gasPrice;

                    } else {
                        // Populate missing fee data

                        if (pop.maxFeePerGas == null) {
                            pop.maxFeePerGas = feeData.maxFeePerGas;
                        }

                        if (pop.maxPriorityFeePerGas == null) {
                            pop.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
                        }
                    }

                } else if (feeData.gasPrice != null) {
                    // Network doesn't support EIP-1559...

                    // ...but they are trying to use EIP-1559 properties
                    if (hasEip1559) {
                        throwError("network does not support EIP-1559", "UNSUPPORTED_OPERATION", {
                            operation: "populateTransaction"
                        });
                    }

                    // Populate missing fee data
                    if (pop.gasPrice == null) {
                        pop.gasPrice = feeData.gasPrice;
                    }

                    // Explicitly set untyped transaction to legacy
                    // @TODO: Maybe this shold allow type 1?
                    pop.type = 0;

               } else {
                    // getFeeData has failed us.
                    throwError("failed to get consistent fee data", "UNSUPPORTED_OPERATION", {
                        operation: "signer.getFeeData"
                    });
                }

            } else if (pop.type === 2) {
                // Explicitly using EIP-1559

                // Populate missing fee data
                if (pop.maxFeePerGas == null) {
                    pop.maxFeePerGas = feeData.maxFeePerGas;
                }

                if (pop.maxPriorityFeePerGas == null) {
                    pop.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
                }
            }
        }

//@TOOD: Don't await all over the place; save them up for
// the end for better batching
        return await resolveProperties(pop);
    }

    async estimateGas(tx: TransactionRequest): Promise<bigint> {
        return this.#checkProvider("estimateGas").estimateGas(await this.populateCall(tx));
    }

    async call(tx: TransactionRequest): Promise<string> {
        return this.#checkProvider("call").call(await this.populateCall(tx));
    }

    async resolveName(name: string): Promise<null | string> {
        const provider = this.#checkProvider("resolveName");
        return await provider.resolveName(name);
    }

    async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
        const provider = this.#checkProvider("sendTransaction");

        const pop = await this.populateTransaction(tx);
        const txObj = Transaction.from(pop);
        return await provider.broadcastTransaction(await this.signTransaction(txObj));
    }

    abstract signTransaction(tx: TransactionRequest): Promise<string>;
    abstract signMessage(message: string | Uint8Array): Promise<string>;
    abstract signTypedData(domain: TypedDataDomain, types: Record<string, Array<TypedDataField>>, value: Record<string, any>): Promise<string>;
}

export class VoidSigner extends AbstractSigner {
    readonly address!: string;

    constructor(address: string, provider?: null | Provider) {
        super(provider);
        defineProperties<VoidSigner>(this, { address });
    }

    async getAddress(): Promise<string> { return this.address; }

    connect(provider: null | Provider): VoidSigner {
        return new VoidSigner(this.address, provider);
    }

    #throwUnsupported(suffix: string, operation: string): never {
        return throwError(`VoidSigner cannot sign ${ suffix }`, "UNSUPPORTED_OPERATION", {
            operation
        });
    }

    async signTransaction(tx: TransactionRequest): Promise<string> {
        this.#throwUnsupported("transactions", "signTransaction");
    }

    async signMessage(message: string | Uint8Array): Promise<string> {
        this.#throwUnsupported("messages", "signMessage");
    }

    async signTypedData(domain: TypedDataDomain, types: Record<string, Array<TypedDataField>>, value: Record<string, any>): Promise<string> {
        this.#throwUnsupported("typed-data", "signTypedData");
    }
}

export class WrappedSigner extends AbstractSigner {
    #signer: Signer;

    constructor(signer: Signer) {
        super(signer.provider);
        this.#signer = signer;
    }

    async getAddress(): Promise<string> {
        return await this.#signer.getAddress();
    }

    connect(provider: null | Provider): WrappedSigner {
        return new WrappedSigner(this.#signer.connect(provider));
    }

    async getNonce(blockTag?: BlockTag): Promise<number> {
        return await this.#signer.getNonce(blockTag);
    }

    async populateCall(tx: TransactionRequest): Promise<TransactionLike<string>> {
        return await this.#signer.populateCall(tx);
    }

    async populateTransaction(tx: TransactionRequest): Promise<TransactionLike<string>> {
        return await this.#signer.populateTransaction(tx);
    }

    async estimateGas(tx: TransactionRequest): Promise<bigint> {
        return await this.#signer.estimateGas(tx);
    }

    async call(tx: TransactionRequest): Promise<string> {
        return await this.#signer.call(tx);
    }

    async resolveName(name: string): Promise<null | string> {
        return this.#signer.resolveName(name);
    }

    async signTransaction(tx: TransactionRequest): Promise<string> {
        return await this.#signer.signTransaction(tx);
    }

    async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
        return await this.#signer.sendTransaction(tx);
    }

    async signMessage(message: string | Uint8Array): Promise<string> {
        return await this.#signer.signMessage(message);
    }

    async signTypedData(domain: TypedDataDomain, types: Record<string, Array<TypedDataField>>, value: Record<string, any>): Promise<string> {
        return await this.#signer.signTypedData(domain, types, value);
    }
}
