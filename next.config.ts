import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp is a native module; keep it external so Next doesn't try to bundle it
  // into the serverless function.
  serverExternalPackages: ["sharp"],

  // The baseline JPEGs are read from disk at runtime and are invisible to
  // Next's static analysis, so they have to be traced in explicitly. Without
  // this the ingest route silently finds no reference in production and
  // classifies every frame — safe, but not what the CV stage is there for.
  outputFileTracingIncludes: {
    "/api/ingest": ["./reference/**/*"],
  },
};

export default nextConfig;
