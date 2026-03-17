path: next.config.ts
purpose: Configure Next.js defaults for the Foseer MVP workspace.
*/

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
