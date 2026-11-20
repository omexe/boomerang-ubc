// The one-signature pledge, as both the page (which asks the wallet to sign) and the keeper
// (which checks the signer and submits it) see it: Circle's EIP-3009 ReceiveWithAuthorization on
// USDC, payable only to SignedPledge, with a nonce that binds one campaign and one amount.
import { encodeAbiParameters, keccak256 } from "viem";

/** USDC's EIP-712 name and version. Arc Testnet's USDC answers this domain (its DOMAIN_SEPARATOR matches), and so does TestUSDC. */
export const USDC_DOMAIN = { name: "USDC", version: "2" } as const;

export const AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The nonce a backer signs, as SignedPledge.nonceFor computes it: keccak256(abi.encode(id, amount, salt)). */
export function nonceFor(id: bigint, amount: bigint, salt: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [id, amount, salt]));
}

/** USDC's record of whether an authorization's nonce has been used. */
export const authorizationStateAbi = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
