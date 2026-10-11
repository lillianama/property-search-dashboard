// Pure helpers for parsing Zillow Research wide-format CSVs. Kept
// dependency-free and side-effect-free so they can be unit tested from
// Vitest and reused by the ingestion script without pulling in pg or fetch.

/**
 * Parses one CSV line into fields, handling RFC4180-style quoting (quoted
 * fields may contain commas, doubled quotes escape a literal quote). Zillow
 * research CSVs never contain embedded newlines, so line-at-a-time parsing
 * is safe.
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Splits a Zillow wide-format header into named metadata columns and the
 * trailing date columns ("YYYY-MM-DD" month-end labels).
 * @param {string[]} headerFields
 * @returns {{ meta: Record<string, number>, dateColumns: Array<{ index: number, month: string }> }}
 */
export function buildColumnIndex(headerFields) {
  const meta = {};
  const dateColumns = [];
  for (let i = 0; i < headerFields.length; i += 1) {
    const name = headerFields[i];
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) {
      dateColumns.push({ index: i, month: name });
    } else {
      meta[name] = i;
    }
  }
  return { meta, dateColumns };
}

/**
 * Unpivots one data row into { month, value } records, skipping blank cells
 * and anything that does not parse to a finite number. Never throws.
 * @param {string[]} fields
 * @param {Array<{ index: number, month: string }>} dateColumns
 * @returns {Array<{ month: string, value: number }>}
 */
export function rowToRecords(fields, dateColumns) {
  const records = [];
  for (const { index, month } of dateColumns) {
    const raw = fields[index];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    records.push({ month, value });
  }
  return records;
}

/**
 * Reads a metadata cell by header name, returning "" when the column or
 * cell is missing so callers can compare without null checks.
 * @param {string[]} fields
 * @param {Record<string, number>} meta
 * @param {string} name
 * @returns {string}
 */
export function metaField(fields, meta, name) {
  const index = meta[name];
  if (index === undefined) return "";
  return fields[index] ?? "";
}
