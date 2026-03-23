/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Prevent Next from bundling these packages into the route handler.
    // Bundling the ESM `.mjs` builds can crash at runtime inside the app route
    // (e.g. `Object.defineProperty called on non-object` from webpack interop).
    serverComponentsExternalPackages: ["pdf-parse", "tesseract.js"],
  },
};

module.exports = nextConfig;
