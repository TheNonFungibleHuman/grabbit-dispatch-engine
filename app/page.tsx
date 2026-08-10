import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-[#f3f5f1] px-6 py-16 text-[#14201a]">
      <main className="w-full max-w-lg rounded-xl border border-[#d7dfd1] bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold tracking-wide text-[#1f7a4c]">
          Grabbit Express
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          WhatsApp agent
        </h1>
        <p className="mt-3 text-sm leading-6 text-[#4b5a50]">
          Customer chat runs through WhatsApp. Manage agent context from the
          admin panel.
        </p>
        <Link
          href="/admin"
          className="mt-6 inline-flex rounded-md bg-[#1f7a4c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#18643e]"
        >
          Open admin
        </Link>
      </main>
    </div>
  );
}
