import Link from "next/link";
import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Setup Guide",
  description:
    "Install Deni AI Harbor and configure required environment variables and webhook URL for GitHub App review automation.",
  path: "/settings",
});

export default function SettingsPage() {
  return (
    <main className="mx-auto min-h-svh w-full max-w-4xl px-6 py-14">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-foreground text-3xl font-semibold tracking-tight">Settings</h1>
        <Link className="text-muted-foreground text-sm underline tracking-tight" href="/">
          Back to homepage
        </Link>
      </div>

      <section className="bg-background border-border rounded-2xl border p-6">
        <h2 className="text-foreground text-lg font-medium tracking-tight">
          Install Deni AI Harbor
        </h2>
        <ol className="text-muted-foreground mt-4 space-y-2 text-sm tracking-tight">
          <li>1. Open the Deni AI Harbor GitHub App installation page.</li>
          <li>2. Choose your organization or repository access scope.</li>
          <li>3. Complete install, then configure the webhook and environment values below.</li>
        </ol>
        <p className="mt-4 text-sm tracking-tight">
          <a
            className="underline tracking-tight"
            href="https://github.com/apps/deni-ai-harbor"
            rel="noreferrer"
            target="_blank"
          >
            Install Deni AI Harbor on GitHub
          </a>
        </p>
      </section>
    </main>
  );
}
