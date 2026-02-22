import Link from "next/link";
import { Button } from "@workspace/ui/components/button";

export default function Page() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-4xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-500">Deni AI Harbor</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">
        Suggested change を GitHub PR に自動投稿する
      </h1>
      <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-600">
        Harbor は GitHub App の pull_request webhook を受け取り、差分を解析して安全な
        <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5">```suggestion```</code>
        形式のレビューコメントを自動で投稿します。
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/settings">設定ページへ</Link>
        </Button>
        <Button asChild variant="outline">
          <a href="https://github.com/settings/apps" rel="noreferrer" target="_blank">
            GitHub Apps
          </a>
        </Button>
      </div>

      <section className="mt-12 grid gap-4 sm:grid-cols-3">
        {[
          "Webhook署名検証 (X-Hub-Signature-256)",
          "PR files API + diff position 算出",
          "read-only 仮想IDE tools + LLM function calling",
        ].map((item) => (
          <div className="rounded-xl border border-zinc-200 bg-white p-4" key={item}>
            <p className="text-sm text-zinc-700">{item}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
