import Link from "next/link";
import { logoutAdminAction } from "@/app/admin/actions";

export function AdminNav(props: { active: "knowledge" | "messages" }) {
  const linkClass = (id: "knowledge" | "messages") =>
    [
      "rounded-md px-3 py-2 text-sm font-medium",
      props.active === id
        ? "bg-[#1f7a4c] text-white"
        : "border border-[#c9d2c6] bg-white text-[#14201a] hover:bg-[#eef2ea]",
    ].join(" ");

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-2 text-sm font-semibold tracking-wide text-[#1f7a4c]">
          Grabbit Admin
        </p>
        <Link href="/admin/knowledge" className={linkClass("knowledge")}>
          Context
        </Link>
        <Link href="/admin/messages" className={linkClass("messages")}>
          Messages
        </Link>
      </div>
      <form action={logoutAdminAction}>
        <button
          type="submit"
          className="rounded-md border border-[#c9d2c6] bg-white px-3 py-2 text-sm font-medium hover:bg-[#eef2ea]"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
