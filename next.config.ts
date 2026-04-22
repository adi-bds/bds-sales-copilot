import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensures the /knowledge folder is bundled into the /api/chat serverless
  // function on Vercel. Without this, fs.readFileSync would fail in production.
  outputFileTracingIncludes: {
    "/api/chat": ["./knowledge/**/*"],
  },
};

export default nextConfig;
