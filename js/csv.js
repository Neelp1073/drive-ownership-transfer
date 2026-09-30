function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function previewRows(state) {
  const rows = [];
  const selected = new Set(state.selectedIds || []);
  const queued = state.queue?.length
    ? state.queue
    : (state.eligible || []).filter((item) => selected.has(item.id));
  for (const item of queued) {
    rows.push({
      id: item.id,
      name: item.name,
      type: item.isFolder ? "folder" : "file",
      mimeType: item.mimeType,
      status: "selected",
      reason: "",
      permissionId: "",
      error: "",
    });
  }
  for (const item of state.results || []) {
    rows.push({
      id: item.id,
      name: item.name,
      type: item.isFolder ? "folder" : "file",
      mimeType: item.mimeType || "",
      status: item.status,
      reason: item.reason || "",
      permissionId: item.permissionId || "",
      error: item.error || "",
    });
  }
  return rows;
}

export const CSV_HEADERS = [
  "id",
  "name",
  "type",
  "mimeType",
  "status",
  "reason",
  "permissionId",
  "error",
];
