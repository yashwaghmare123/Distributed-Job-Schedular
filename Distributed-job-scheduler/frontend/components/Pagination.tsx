"use client";

export function Pagination({ page, totalPages, hasMore, loading, onChange }: { page: number; totalPages?: number | null; hasMore?: boolean; loading?: boolean; onChange: (page: number) => void }) {
  if ((totalPages === undefined || totalPages === null || totalPages <= 1) && page <= 1 && !hasMore) return null;
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 16 }}>
    <button className="button secondary" type="button" disabled={page <= 1 || loading} onClick={() => onChange(page - 1)}>Previous</button>
    <span className="subtle">Page {page}{totalPages && totalPages > 1 ? ` of ${totalPages}` : ""}</span>
    <button className="button secondary" type="button" disabled={(totalPages && totalPages > 1 ? page >= totalPages : !hasMore) || loading} onClick={() => onChange(page + 1)}>Next</button>
  </div>;
}
