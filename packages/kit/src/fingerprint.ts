// A fingerprint of the compiled Boomerang runtime code, so a browser can check the live code
// without holding the whole artifact: the runtime code's length in bytes, where its immutable
// slots sit (flattened and sorted by start), how long the trailing metadata blob is, and the
// keccak256 of the code with the immutables zeroed and that blob removed (exactly the bytes the
// command-line `codeCheck` compares), and the keccak256 of the blob itself. These are the values `fingerprintOf` gives for
// `contracts/artifacts/contracts/Boomerang.sol/Boomerang.json`; `contracts/test/fingerprint.test.ts`
// pins them to the build, so a code change that is not reflected here fails that test.
export const BOOMERANG_FINGERPRINT = {
  bytes: 13390,
  immutables: [
    { start: 524, length: 32 },
    { start: 7423, length: 32 },
    { start: 7577, length: 32 },
    { start: 7815, length: 32 },
    { start: 9220, length: 32 },
  ],
  metadataBytes: 53,
  codeHash: "0xd5ffd3fd31ff80c59fe5c65d1ac38959ed1c2b2289a0b7fb3379b2718c2eb7f7",
  metadataHash: "0xdb76c70468c6cb767190fccae94b1fa5cf03d2b58aeb591226fc0c7db5749acc",
} as const;
