"use client";

import { useActionState, useEffect, useState } from "react";
import { AdminNav } from "@/app/admin/admin-nav";
import {
  publishKnowledgeAction,
  resetKnowledgeToSeedAction,
  type AdminActionState,
} from "@/app/admin/actions";
import type { KnowledgeDocument } from "@/lib/admin/knowledge";

const initialState: AdminActionState = { ok: false };

export function KnowledgeEditor(props: {
  initial: KnowledgeDocument;
  agentEnabled: boolean;
}) {
  const [content, setContent] = useState(props.initial.content);
  const [publishState, publishAction, publishing] = useActionState(
    publishKnowledgeAction,
    initialState,
  );
  const [resetState, resetAction, resetting] = useActionState(
    async (_prev: AdminActionState, _formData: FormData) =>
      resetKnowledgeToSeedAction(),
    initialState,
  );

  useEffect(() => {
    if (resetState.ok) {
      window.location.reload();
    }
  }, [resetState.ok]);

  const status = publishState.message || resetState.message;
  const statusOk = publishState.ok || resetState.ok;
  const sourceLabel =
    props.initial.source === "blob" ? "Blob (published)" : "Local seed (docs.md)";

  return (
    <div className="space-y-6">
      <AdminNav active="knowledge" agentEnabled={props.agentEnabled} />

      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Agent context</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#4b5a50]">
          This text is injected into the WhatsApp agent system prompt. Publish
          to push changes live (Blob). Until published, the agent uses the repo
          seed or the last published version.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 text-sm text-[#4b5a50]">
        <span className="rounded-full border border-[#d7dfd1] bg-white px-3 py-1">
          Source: {sourceLabel}
        </span>
        <span className="rounded-full border border-[#d7dfd1] bg-white px-3 py-1">
          Updated:{" "}
          {props.initial.source === "seed"
            ? "not published yet"
            : props.initial.updatedAt.replace("T", " ").slice(0, 19) + " UTC"}
        </span>
        <span className="rounded-full border border-[#d7dfd1] bg-white px-3 py-1">
          {content.length.toLocaleString()} chars
        </span>
      </div>

      {status ? (
        <p
          className={`rounded-md px-3 py-2 text-sm ${
            statusOk
              ? "border border-[#b7dfc5] bg-[#eefaf2] text-[#14532d]"
              : "border border-[#f0c2c2] bg-[#fff5f5] text-[#9b2c2c]"
          }`}
          role="status"
        >
          {status}
        </p>
      ) : null}

      <form action={publishAction} className="space-y-4">
        <textarea
          name="content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          spellCheck={false}
          className="min-h-[28rem] w-full rounded-lg border border-[#c9d2c6] bg-white p-4 font-mono text-sm leading-6 outline-none ring-[#1f7a4c] focus:ring-2"
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="submit"
            disabled={publishing || resetting}
            className="rounded-md bg-[#1f7a4c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#18643e] disabled:opacity-60"
          >
            {publishing ? "Publishing…" : "Publish"}
          </button>
          <button
            type="submit"
            formAction={resetAction}
            disabled={publishing || resetting}
            className="rounded-md border border-[#c9d2c6] bg-white px-4 py-2.5 text-sm font-medium hover:bg-[#eef2ea] disabled:opacity-60"
          >
            {resetting ? "Resetting…" : "Reset to docs.md seed"}
          </button>
        </div>
      </form>
    </div>
  );
}
