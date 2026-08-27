export default function AdminLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Top Nav Skeleton */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 rounded-[28px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620]">
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="h-10 w-10 rounded-2xl bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="space-y-1.5">
            <div className="h-4 w-28 rounded-md bg-[#EDEAE2] dark:bg-[#1D2620]" />
            <div className="h-3 w-36 rounded-md bg-[#EDEAE2] dark:bg-[#1D2620]" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-24 rounded-full bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-9 w-28 rounded-full bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-9 w-28 rounded-full bg-[#EDEAE2] dark:bg-[#1D2620]" />
        </div>
      </div>

      {/* Bento Grid Skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="h-36 rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 space-y-4">
          <div className="h-4 w-24 rounded bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-8 w-16 rounded bg-[#EDEAE2] dark:bg-[#1D2620]" />
        </div>
        <div className="h-36 rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 space-y-4">
          <div className="h-4 w-28 rounded bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-8 w-32 rounded bg-[#EDEAE2] dark:bg-[#1D2620]" />
        </div>
        <div className="h-36 rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 space-y-4">
          <div className="h-4 w-24 rounded bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-8 w-20 rounded bg-[#EDEAE2] dark:bg-[#1D2620]" />
        </div>
      </div>

      {/* Main Content Area Skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 h-72 rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 space-y-4">
          <div className="h-5 w-44 rounded bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-10 w-full rounded-2xl bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-10 w-full rounded-2xl bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-10 w-full rounded-2xl bg-[#EDEAE2] dark:bg-[#1D2620]" />
        </div>
        <div className="h-72 rounded-[24px] bg-[var(--bg-card)] border border-[#E8E5DC] dark:border-[#1D2620] p-6 space-y-4">
          <div className="h-5 w-32 rounded bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-10 w-full rounded-2xl bg-[#EDEAE2] dark:bg-[#1D2620]" />
          <div className="h-10 w-full rounded-2xl bg-[#EDEAE2] dark:bg-[#1D2620]" />
        </div>
      </div>
    </div>
  );
}
