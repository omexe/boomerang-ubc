import path from "node:path";
import type { NextConfig } from "next";

// The site reuses the existing app's data, wallet and flow code straight from ../web/src and the
// contract kit from ../packages/kit, so there is one copy of every rule. Those folders sit outside
// this app, so the bundler is told to compile them and to resolve their packages from here.
const here = __dirname;
const mod = (name: string) => path.join(here, "node_modules", name);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: { externalDir: true },
  outputFileTracingRoot: path.join(here, ".."),
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      viem: mod("viem"),
    };
    config.resolve.modules = [path.join(here, "node_modules"), "node_modules"];
        return config;
  },
};

export default nextConfig;
