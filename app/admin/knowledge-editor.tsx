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
  scheduleSummary: string;
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
    props.initial.source === "blob" ? "Cloud Published" : "Local Repository (docs.md)";

  return (
    <div className="space-y-6">
      <AdminNav
        active="knowledge"
        agentEnabled={props.agentEnabled}
        scheduleSummary={props.scheduleSummary}
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#101412] dark:text-[#F6F3EC]">
            Agent Knowledge & Fares
          </h1>
          <p className="text-xs text-[#6C746E] dark:text-[#8E9690] mt-1 max-w-2xl">
            This document is injected directly into the WhatsApp AI agent prompt. Updating fares or policies here immediately updates the AI live responses.
          </p>
        </div>

        {/* Source and Stats Pill */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center px-3 py-1 rounded-full bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] text-[#101412] dark:text-[#F6F3EC] font-semibold">
            {sourceLabel}
          </span>
          <span className="inline-flex items-center px-3 py-1 rounded-full bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] text-[#6C746E] dark:text-[#8E9690] font-mono">
            {content.length.toLocaleString()} chars
          </span>
        </div>
      </div>

      {status && (
        <div
          className={`p-4 rounded-2xl text-xs font-semibold flex items-center justify-between shadow-sm border ${
            statusOk
              ? "bg-[#7ed957]/15 text-[#101412] dark:text-[#7ed957] border-[#7ed957]/30"
              : "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20"
          }`}
        >
          <span>{status}</span>
        </div>
      )}

      {/* Bento Editor Card */}
      <div className="rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 shadow-sm space-y-5">
        <form action={publishAction} className="space-y-4">
          <div className="relative">
            <textarea
              name="content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
              rows={22}
              className="w-full rounded-[16px] border border-[#E8E5DC] dark:border-[#1D2620] bg-[#F6F3EC] dark:bg-[#0B0F0C] p-4 font-mono text-xs leading-relaxed text-[#101412] dark:text-[#F6F3EC] focus:border-[#7ed957] focus:outline-none transition-colors"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={publishing || resetting}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#7ed957] hover:bg-[#6fc847] text-[#101412] font-bold text-xs shadow-sm transition-all disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                <span>{publishing ? "Publishing to AI..." : "Publish Live to Agent"}</span>
              </button>

              <button
                type="submit"
                formAction={resetAction}
                disabled={publishing || resetting}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690] hover:text-[#101412] dark:hover:text-[#F6F3EC] border border-[#E8E5DC] dark:border-[#1D2620] text-xs font-semibold transition-all disabled:opacity-50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
                <span>{resetting ? "Resetting..." : "Reset to Default Seed"}</span>
              </button>
            </div>

            <span className="text-[11px] text-[#6C746E] dark:text-[#8E9690]">
              Last published: {props.initial.source === "seed" ? "Never" : props.initial.updatedAt.replace("T", " ").slice(0, 19) + " UTC"}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
