import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensures the /knowledge folder is bundled into the /api/chat serverless
  // function on Vercel. Without this, fs.readFileSync would fail in production.
  // Vercel/Next.js App Router — include knowledge files in the serverless bundle.
  // Multiple key formats listed for compatibility across Next.js versions.
  outputFileTracingIncludes: {
    "/api/chat": ["./knowledge/**/*"],
    "app/api/chat": ["./knowledge/**/*"],
    "/app/api/chat/route": ["./knowledge/**/*"],
  },
};

export default nextConfig;
