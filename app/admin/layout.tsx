import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Grabbit Admin",
  description: "Manage Grabbit WhatsApp agent context",
};

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="min-h-screen bg-[var(--bg-surface)] text-[var(--text-ink)] transition-colors duration-200">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
        {children}
      </div>
    </div>
  );
}
