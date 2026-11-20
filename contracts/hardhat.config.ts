import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

// No key lives in this file or in this repository. Tests run on Hardhat's in-memory chain.
// A deployment is signed by a key its owner hands to the process at run time: ARC_DEPLOYER_KEY,
// read only when a command uses the arcTestnet network, from Hardhat's encrypted keystore
// (`npx hardhat keystore set ARC_DEPLOYER_KEY`) or from the environment of that one command.
export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    version: "0.8.38",
    settings: {
      evmVersion: "prague",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    arcTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 5042002,
      url: "https://rpc.testnet.arc.io",
      accounts: [configVariable("ARC_DEPLOYER_KEY")],
    },
  },
});
