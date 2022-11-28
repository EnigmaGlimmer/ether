/**
 *  Addresses in Ethereum can be of several formats. These functions
 *  help convert between them, checksum them, etc.
 *
 *  @_section: api/address:Addresses  [addresses]
 */

export interface Addressable {
    getAddress(): Promise<string>;
}

export type AddressLike = string | Promise<string> | Addressable;

export interface NameResolver {
    resolveName(name: string): Promise<null | string>;
}

export { getAddress, getIcapAddress } from "./address.js";

export { getCreateAddress, getCreate2Address } from "./contract-address.js";


export { isAddressable, isAddress, resolveAddress } from "./checks.js";
