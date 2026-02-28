import Link from "next/link";
import { Button } from "@workspace/ui/components/button";

export default function Page() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-4xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-500">
        Deni AI Harbor
      </p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">
        GitHub PR review automation for OSS and self-hosted projects
      </h1>
      <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-600">
        Deni AI Harbor analyzes pull requests, posts safe and actionable review feedback,
        and keeps approval handling deterministic so teams can merge with confidence and
        less review churn.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild>
          <a href="https://github.com/apps/deni-ai-harbor" rel="noreferrer" target="_blank">
            Install Deni AI Harbor
          </a>
        </Button>
        <Button asChild variant="outline">
          <Link href="/settings">Setup guide</Link>
        </Button>
      </div>

      <section className="mt-12">
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">Features</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {[
            "Fast review iteration with automated PR feedback in minutes.",
            "Reduced review churn through focused, safe change suggestions.",
            "Deterministic approval handling for predictable merge readiness.",
            "Works for OSS repositories and self-hosted project workflows.",
          ].map((item) => (
            <div className="rounded-xl border border-zinc-200 bg-white p-4" key={item}>
              <p className="text-sm text-zinc-700">{item}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold tracking-tight text-zinc-900">How it works</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            "Install the GitHub App on your repository or organization.",
            "Open or update a pull request and Harbor reviews the diff.",
            "Apply feedback, iterate quickly, and merge with confidence.",
          ].map((item, index) => (
          <div className="rounded-xl border border-zinc-200 bg-white p-4" key={item}>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Step {index + 1}
            </p>
            <p className="mt-2 text-sm text-zinc-700">{item}</p>
          </div>
          ))}
        </div>
      </section>
    </main>
  );
}
