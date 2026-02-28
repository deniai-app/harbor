import type { Metadata } from "next";

const DEFAULT_SITE_URL = "http://localhost:3000";

function resolveSiteUrl(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.SITE_URL,
    DEFAULT_SITE_URL,
  ] as const;

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      return new URL(candidate).toString().replace(/\/$/, "");
    } catch {
      continue;
    }
  }

  return DEFAULT_SITE_URL;
}

export const siteConfig = {
  name: "Deni AI Harbor",
  title: "Deni AI Harbor | GitHub PR Review Automation",
  description:
    "Deni AI Harbor automates GitHub pull request reviews with safe, actionable feedback for OSS and self-hosted teams.",
  url: resolveSiteUrl(),
  keywords: [
    "GitHub App",
    "pull request review",
    "AI code review",
    "OSS automation",
    "self-hosted",
    "Deni AI Harbor",
  ],
} as const;

type PageMetadataOptions = {
  title: string;
  description?: string;
  path: `/${string}` | "/";
};

export function createPageMetadata(options: PageMetadataOptions): Metadata {
  const description = options.description ?? siteConfig.description;

  return {
    title: options.title,
    description,
    alternates: {
      canonical: options.path,
    },
    openGraph: {
      type: "website",
      title: options.title,
      description,
      url: options.path,
      siteName: siteConfig.name,
    },
    twitter: {
      card: "summary",
      title: options.title,
      description,
    },
  };
}

export function toAbsoluteUrl(path: `/${string}` | "/"): string {
  return new URL(path, `${siteConfig.url}/`).toString();
}
