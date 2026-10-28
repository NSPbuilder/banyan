import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: { serverFunctions: false },
  // Finder expects collection URLs ending in '/'. Next would otherwise issue
  // a 308 before PROPFIND reaches proxy.ts. Proxy keeps the existing redirect
  // for ordinary app URLs and lets /dav paths retain their slash.
  skipTrailingSlashRedirect: true,
  // These server-only export libraries work with native Node loading. Keeping
  // them outside the compiler's module graph also reduces development work.
  serverExternalPackages: ['pdfkit', 'exceljs'],
  // Agent sessions and Git history contain no runtime attachment assets.
  outputFileTracingExcludes: { '/*': ['./.nsp/**/*', './.git/**/*', './build/**/*'] },
  experimental: {
    // Reclaim persisted compiler data after each snapshot on local dev servers.
    // Next 16.3 supports this only with its development filesystem cache.
    turbopackMemoryEviction: 'full',
    /**
     * A bill, and a receipt, arrive through a server action.
     *
     * Next caps an action's request body at 1 MB by default, and a scanned
     * PDF of a supplier's bill is routinely more than that — so the 8 MB
     * `bill-reading.ts` promises was a promise the framework refused before
     * the code ever saw it, with Next's own error rather than this system's
     * sentence (critic, 2026-09-07). Attachments allow 25 MB and go through
     * an action too.
     *
     * 26 MB, not 25: the limit is on the raw HTTP body, and multipart adds
     * boundaries, part headers and field names on top of the file itself.
     * The libraries' own limits stay where they are — this only stops the
     * framework from refusing first, so the refusal a person reads is the
     * one written for them.
     */
    serverActions: { bodySizeLimit: '26mb' },
    // Proxy buffers route-handler uploads too; its default 10 MB would
    // truncate a valid attachment before the bounded multipart reader sees it.
    proxyClientMaxBodySize: '26mb',
  },
};

export default nextConfig;
