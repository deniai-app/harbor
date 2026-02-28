import Link from "next/link";

const envKeys = [
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY_PEM or GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_WEBHOOK_SECRET",
  "BASE_URL",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "OPENAI_API_KEY",
];

export default function SettingsPage() {
  return (
    <main className="mx-auto min-h-svh w-full max-w-4xl px-6 py-14">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-foreground text-3xl font-semibold tracking-tight">Settings</h1>
        <Link className="text-muted-foreground text-sm underline" href="/">
          Back to homepage
        </Link>
      </div>

      <section className="bg-background border-border rounded-2xl border p-6">
        <h2 className="text-foreground text-lg font-medium">Install Deni AI Harbor</h2>
        <ol className="text-muted-foreground mt-4 space-y-2 text-sm">
          <li>1. Open the Deni AI Harbor GitHub App installation page.</li>
          <li>2. Choose your organization or repository access scope.</li>
          <li>3. Complete install, then configure the webhook and environment values below.</li>
        </ol>
        <p className="mt-4 text-sm">
          <a
            className="underline"
            href="https://github.com/apps/deni-ai-harbor"
            rel="noreferrer"
            target="_blank"
          >
            Install Deni AI Harbor on GitHub
          </a>
        </p>
      </section>

      <section className="bg-background border-border mt-6 rounded-2xl border p-6">
        <h2 className="text-foreground text-lg font-medium">Required environment variables</h2>
        <ul className="mt-4 space-y-2">
          {envKeys.map((key) => (
            <li
              className="bg-muted text-muted-foreground rounded-md px-3 py-2 font-mono text-sm"
              key={key}
            >
              {key}
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-background border-border mt-6 rounded-2xl border p-6">
        <h2 className="text-foreground text-lg font-medium">Webhook URL</h2>
        <p className="text-muted-foreground mt-3 text-sm">
          <code className="bg-muted rounded px-1 py-0.5">{`POST {BASE_URL}/webhooks/github`}</code>
        </p>
      </section>
    </main>
  );
}
