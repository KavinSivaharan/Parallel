import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@parallel/contracts"],
};

export default nextConfig;

