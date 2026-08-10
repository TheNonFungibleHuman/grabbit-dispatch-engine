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
    <div className="min-h-full bg-[#f3f5f1] text-[#14201a]">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        {children}
      </div>
    </div>
  );
}
