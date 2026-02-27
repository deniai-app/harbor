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
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">Settings</h1>
        <Link className="text-sm text-zinc-600 underline" href="/">
          Back to homepage
        </Link>
      </div>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-medium text-zinc-900">Required environment variables</h2>
        <ul className="mt-4 space-y-2">
          {envKeys.map((key) => (
            <li
              className="rounded-md bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-700"
              key={key}
            >
              {key}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-medium text-zinc-900">Review profile configuration</h2>
        <p className="mt-3 text-sm text-zinc-600">
          Set <code className="rounded bg-zinc-100 px-1 py-0.5">REVIEW_PROFILE</code> to <b>low</b>, <b>default</b> (default), or <b>high</b>.
          High mode uses heavier tool usage and broader suggestion coverage (max quality/speed at the cost of higher runtime),
          while Low is faster and quieter. High profile can optionally use <code className="rounded bg-zinc-100 px-1 py-0.5">LLM_MODEL_HIGH</code> (default: gpt-5.3-codex).
        </p>
      </section>

      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-medium text-zinc-900">Webhook URL</h2>
        <p className="mt-3 text-sm text-zinc-600">
          <code className="rounded bg-zinc-100 px-1 py-0.5">{`POST {BASE_URL}/webhooks/github`}</code>
        </p>
      </section>
    </main>
  );
}
