// mend — a small, strict patch applier for SPEC.md files.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Reads a patch (a file path, or stdin when PATCH is absent or "-"),
// applies its edits to the files under the current directory, and
// reports what changed. Exit 0 on success, 1 when edits failed,
// 2 for usage, unreadable-patch, format and parse problems.
//
// The applier works in three tiers of line matching (exact, then
// trailing-whitespace-insensitive, then whitespace-insensitive),
// picks the occurrence nearest the hunk's stated position for
// unified diffs, anchors V4A chunks by content, and never writes
// anything when any edit fails.
import * as fs from "node:fs";
import * as path from "node:path";

// ------------------------------------------------------------------
// small text helpers
// ------------------------------------------------------------------

function trimRightWs(s: string): string {
  return s.replace(/[ \t]+$/, "");
}
function trimBothWs(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}
function isBlank(s: string): boolean {
  return s.trim() === "";
}
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
function out(s: string): void {
  process.stdout.write(s);
}

// Split patch text into lines: split at "\n", strip one trailing "\r"
// from each piece, and drop the empty piece after a final "\n".
function splitPatchLines(text: string): string[] {
  const raw = text.split("\n");
  const lines = raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

// Split an inserted string into lines: like splitPatchLines, except an
// empty string has no lines at all.
function splitInsertedLines(text: string): string[] {
  if (text === "") return [];
  return splitPatchLines(text);
}

// ------------------------------------------------------------------
// paths
// ------------------------------------------------------------------

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return false;
  }
  return true;
}

// ------------------------------------------------------------------
// files in the tree
// ------------------------------------------------------------------

interface FileDoc {
  eol: string; // "\n" or "\r\n"
  lines: string[];
  endsWithBreak: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === "") return { eol: "\n", lines: [], endsWithBreak: false };
  let eol = "\n";
  const firstLf = text.indexOf("\n");
  if (firstLf > 0 && text[firstLf - 1] === "\r") eol = "\r\n";
  const parts = text.split(eol);
  let endsWithBreak = false;
  if (text.endsWith(eol)) {
    parts.pop();
    endsWithBreak = true;
  }
  return { eol, lines: parts, endsWithBreak };
}

function serializeDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return "";
  return doc.lines.join(doc.eol) + (doc.endsWithBreak ? doc.eol : "");
}

function cloneDoc(doc: FileDoc): FileDoc {
  return { eol: doc.eol, lines: doc.lines.slice(), endsWithBreak: doc.endsWithBreak };
}

function loadTree(root: string): Map<string, string> {
  const outMap = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel === "" ? e.name : rel + "/" + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, p);
      } else if (e.isFile()) {
        try {
          outMap.set(p, fs.readFileSync(full, "utf8"));
        } catch {
          // unreadable file: leave it out of the tree
        }
      } else if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(full).isFile()) outMap.set(p, fs.readFileSync(full, "utf8"));
        } catch {
          // dangling link: leave it out
        }
      }
    }
  };
  walk(root, "");
  return outMap;
}

function writeTree(original: Map<string, string>, finalMap: Map<string, string>): void {
  for (const [p, text] of finalMap) {
    if (original.get(p) !== text) {
      const full = path.join(process.cwd(), p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, "utf8");
    }
  }
  for (const p of original.keys()) {
    if (!finalMap.has(p)) {
      try {
        fs.unlinkSync(path.join(process.cwd(), p));
      } catch {
        // already gone
      }
    }
  }
}

// ------------------------------------------------------------------
// line matching (section 5 of the spec)
// ------------------------------------------------------------------

type Tier = 0 | 1 | 2;

function lineEqAt(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRightWs(a) === trimRightWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function occurrencesAt(lines: string[], pat: string[], tier: Tier, from: number): number[] {
  const outArr: number[] = [];
  if (pat.length === 0) return outArr;
  for (let i = Math.max(0, from); i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEqAt(lines[i + j], pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) outArr.push(i);
  }
  return outArr;
}

// First tier with at least one occurrence (from position 0), or null.
function findTier(lines: string[], pat: string[], strict: boolean): { tier: Tier; occ: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, pat, t, 0);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// First occurrence at or after `from`, at the first tier with one.
// When eof is true, only an occurrence ending at the file's last line
// counts.
function findTierFrom(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: Tier; pos: number } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = Math.max(0, from); i + pat.length <= lines.length; i++) {
      if (eof && i + pat.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < pat.length; j++) {
        if (!lineEqAt(lines[i + j], pat[j], t)) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier: t, pos: i };
    }
  }
  return null;
}

// Single-line anchor search at or after `from`, first tier with a hit.
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (lineEqAt(lines[i], anchor, t)) return i;
    }
  }
  return -1;
}

// Tier-2 re-indentation: a replacement line that starts with the old
// block's first-line indent P is rewritten with the file's indent F.
function reindentLine(line: string, p: string, f: string): string {
  if (line === "" || line.trim() === "") return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

// Build the replacement lines for a matched block: context lines come
// from the file itself; other lines are re-indented at tier 2 only.
function buildReplacement(
  doc: FileDoc,
  pos: number,
  nLines: { text: string; ctx: boolean; oIdx: number }[],
  tier: Tier,
  p: string,
): string[] {
  const f = leadingWs(doc.lines[pos]);
  const rep: string[] = [];
  for (const nl of nLines) {
    if (nl.ctx) rep.push(doc.lines[pos + nl.oIdx]);
    else if (tier === 2) rep.push(reindentLine(nl.text, p, f));
    else rep.push(nl.text);
  }
  return rep;
}

// ------------------------------------------------------------------
// edits
// ------------------------------------------------------------------

interface EditFailure {
  code: string;
  path: string;
}

type ApplyResult = { ok: true } | { ok: false; fail: EditFailure };

function fail(code: string, editPath: string): ApplyResult {
  return { ok: false, fail: { code, path: editPath } };
}

// One body line of a hunk/chunk: its text, whether it is a context
// line, and (when context) which index it has inside O.
interface BodyLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

interface Hunk {
  a: number; // old start, 1-based
  oLines: BodyLine[];
  nLines: BodyLine[];
  noEol: boolean; // a "\" line follows the hunk's last context/new line
}

type UnifiedMode = "create" | "delete" | "move" | "change";

interface UnifiedEdit {
  kind: "unified";
  oldPath: string | null; // null means /dev/null
  newPath: string | null;
  mode: UnifiedMode;
  hunks: Hunk[];
}

interface SrEdit {
  kind: "sr";
  path: string;
  oldLines: string[];
  newLines: string[];
}

interface V4aChunk {
  anchor: string | null;
  oLines: BodyLine[];
  nLines: BodyLine[];
  eof: boolean;
}

interface V4aEdit {
  kind: "v4a";
  op: "add" | "delete" | "update";
  path: string;
  newPath: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

type JsonCommand = "create" | "str_replace" | "insert";

interface JsonEdit {
  kind: "json";
  command: JsonCommand;
  path: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

type Edit = UnifiedEdit | SrEdit | V4aEdit | JsonEdit;

type ParseOut = { edits: Edit[] } | { parseError: number };

function parseErr(n: number): ParseOut {
  return { parseError: n };
}

// ------------------------------------------------------------------
// format detection
// ------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (!isBlank(l)) {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== null) {
    if (trimBothWs(firstNonBlank) === "*** Begin Patch") return "v4a";
    const ch = firstNonBlank.trimStart()[0];
    if (ch === "[" || ch === "{") return "json";
  }
  for (const l of lines) {
    if (trimRightWs(l) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ "))
      return "unified";
  }
  return null;
}

// ------------------------------------------------------------------
// unified diff parsing (section 6)
// ------------------------------------------------------------------

interface UnifiedSection {
  dashOld: string | null;
  dashNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function stripGitPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function dashPath(line: string): string {
  // line starts with "--- " or "+++ "; path is the text after 4 chars,
  // up to the first tab, surrounding spaces removed.
  let t = line.slice(4);
  const tab = t.indexOf("\t");
  if (tab >= 0) t = t.slice(0, tab);
  return trimBothWs(t);
}

function parseDiffGit(line: string): { old: string; new: string } | null {
  // "diff --git a/<X> b/<Y>" — X and Y have no spaces.
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (!m) return null;
  return { old: m[1], new: m[2] };
}

function parseHunkHeader(line: string): { a: number; c: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return { a: Number(m[1]), c: Number(m[3]) };
}

// Turn raw body ops into a Hunk. Body ops are {kind, text} with kind
// " " | "-" | "+" | "\\". Trailing empty context lines are dropped.
function finishHunk(
  a: number,
  ops: { kind: string; text: string }[],
): Hunk {
  while (ops.length > 0) {
    const last = ops[ops.length - 1];
    if (last.kind === " " && last.text === "") ops.pop();
    else break;
  }
  const oLines: BodyLine[] = [];
  const nLines: BodyLine[] = [];
  for (const op of ops) {
    if (op.kind === " ") {
      const idx = oLines.length;
      oLines.push({ text: op.text, ctx: true, oIdx: idx });
      nLines.push({ text: op.text, ctx: true, oIdx: idx });
    } else if (op.kind === "-") {
      oLines.push({ text: op.text, ctx: false, oIdx: -1 });
    } else if (op.kind === "+") {
      nLines.push({ text: op.text, ctx: false, oIdx: -1 });
    }
  }
  let noEol = false;
  // The last context or "+" op in the body; a "\" op right after it
  // means the result has no trailing line break there.
  let lastCtxNew = -1;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind === " " || ops[i].kind === "+") lastCtxNew = i;
  }
  if (lastCtxNew >= 0 && lastCtxNew + 1 < ops.length && ops[lastCtxNew + 1].kind === "\\") {
    noEol = true;
  }
  return { a, oLines, nLines, noEol };
}

function sectionToEdit(sec: UnifiedSection): UnifiedEdit {
  const norm = (p: string | null): string | null => (p === null || p === "/dev/null" ? null : p);
  const oldRaw = sec.dashOld !== null ? sec.dashOld : sec.renameOld !== null ? sec.renameOld : sec.diffOld;
  const newRaw = sec.dashNew !== null ? sec.dashNew : sec.renameNew !== null ? sec.renameNew : sec.diffNew;
  const oldPath = norm(oldRaw === null ? null : sec.dashOld !== null ? stripGitPrefix(oldRaw) : oldRaw);
  const newPath = norm(newRaw === null ? null : sec.dashNew !== null ? stripGitPrefix(newRaw) : newRaw);
  let mode: UnifiedMode;
  if (oldPath === null || sec.newFileMode) mode = "create";
  else if (newPath === null || sec.deletedFileMode) mode = "delete";
  else if (oldPath !== newPath) mode = "move";
  else mode = "change";
  return { kind: "unified", oldPath, newPath, mode, hunks: sec.hunks };
}

function parseUnified(lines: string[]): ParseOut {
  const edits: UnifiedEdit[] = [];
  let section: UnifiedSection | null = null;
  let hunk: { a: number; ops: { kind: string; text: string }[] } | null = null;

  const endHunk = (): void => {
    if (hunk !== null && section !== null) {
      section.hunks.push(finishHunk(hunk.a, hunk.ops));
      hunk = null;
    }
  };
  const endSection = (): void => {
    endHunk();
    if (section !== null) {
      edits.push(sectionToEdit(section));
      section = null;
    }
  };
  const newSection = (): UnifiedSection => {
    return {
      dashOld: null,
      dashNew: null,
      renameOld: null,
      renameNew: null,
      diffOld: null,
      diffNew: null,
      newFileMode: false,
      deletedFileMode: false,
      hunks: [],
    };
  };

  const isBodyLine = (l: string): boolean =>
    l === "" || l.startsWith(" ") || l.startsWith("-") || l.startsWith("+") || l.startsWith("\\");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;

    if (hunk !== null) {
      // Inside a hunk body.
      if (line.startsWith("diff --git ")) {
        endHunk();
        endSection();
        const dg = parseDiffGit(line);
        if (dg === null) return parseErr(lineNo);
        section = newSection();
        section.diffOld = dg.old;
        section.diffNew = dg.new;
        i++;
        continue;
      }
      if (
        line.startsWith("--- ") &&
        i + 1 < lines.length &&
        lines[i + 1].startsWith("+++ ")
      ) {
        endHunk();
        endSection();
        section = newSection();
        section.dashOld = dashPath(line);
        section.dashNew = dashPath(lines[i + 1]);
        i += 2;
        continue;
      }
      if (line.startsWith("@@")) {
        endHunk();
        const hh = parseHunkHeader(line);
        if (hh === null) return parseErr(lineNo);
        if (section === null) return parseErr(lineNo);
        hunk = { a: hh.a, ops: [] };
        i++;
        continue;
      }
      if (isBodyLine(line)) {
        const kind = line === "" ? " " : line[0];
        hunk.ops.push({ kind, text: line === "" ? "" : line.slice(1) });
        i++;
        continue;
      }
      // Any other line ends the body.
      endHunk();
      // Fall through to outside-body handling of this same line.
    }

    // Outside a hunk body.
    if (line.startsWith("diff --git ")) {
      const dg = parseDiffGit(line);
      if (dg === null) return parseErr(lineNo);
      endSection();
      section = newSection();
      section.diffOld = dg.old;
      section.diffNew = dg.new;
      i++;
      continue;
    }
    if (
      line.startsWith("--- ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+++ ")
    ) {
      if (section !== null && section.dashOld === null && section.hunks.length === 0) {
        // Still in the current section's header: this pair names it.
        section.dashOld = dashPath(line);
        section.dashNew = dashPath(lines[i + 1]);
        i += 2;
        continue;
      }
      endSection();
      section = newSection();
      section.dashOld = dashPath(line);
      section.dashNew = dashPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (section !== null && section.hunks.length === 0) {
        // A "--- " line not followed by "+++ " inside a section header.
        return parseErr(lineNo + 1);
      }
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const hh = parseHunkHeader(line);
      if (hh === null) return parseErr(lineNo);
      if (section === null) return parseErr(lineNo);
      hunk = { a: hh.a, ops: [] };
      i++;
      continue;
    }
    if (section !== null && section.hunks.length === 0) {
      // Header line of the current section.
      if (line.startsWith("+++ ")) {
        if (section.dashNew === null) section.dashNew = dashPath(line);
      } else if (line.startsWith("rename from ")) {
        section.renameOld = line.slice("rename from ".length).trim();
      } else if (line.startsWith("rename to ")) {
        section.renameNew = line.slice("rename to ".length).trim();
      } else if (line === "new file mode" || line.startsWith("new file mode ")) {
        section.newFileMode = true;
      } else if (line === "deleted file mode" || line.startsWith("deleted file mode ")) {
        section.deletedFileMode = true;
      }
      // index / old mode / new mode / similarity / dissimilarity /
      // Index: and anything else: ignored.
      i++;
      continue;
    }
    // Prose outside any section: ignored.
    i++;
  }
  endSection();
  return { edits };
}

// ------------------------------------------------------------------
// SEARCH/REPLACE parsing (section 7)
// ------------------------------------------------------------------

function parseSearchReplace(lines: string[]): ParseOut {
  const edits: SrEdit[] = [];
  let prevReplaceEnd = 0; // index of the line after the previous REPLACE
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimRightWs(lines[i]) !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchLineNo = i + 1;
    // Path: nearest line before SEARCH, after the previous block's
    // REPLACE (or the patch start), not blank and not a fence line.
    let pathLine: string | null = null;
    for (let j = i - 1; j >= prevReplaceEnd; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (trimBothWs(l).startsWith("```")) continue;
      pathLine = trimBothWs(l);
      break;
    }
    let editPath: string;
    if (pathLine !== null) editPath = pathLine;
    else if (prevPath !== null) editPath = prevPath;
    else return parseErr(searchLineNo);
    // Find "=======" then ">>>>>>> REPLACE" after the SEARCH line.
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = trimRightWs(lines[j]);
      if (t === "=======") {
        eq = j;
        break;
      }
      if (t === ">>>>>>> REPLACE" || t === "<<<<<<< SEARCH") break;
    }
    if (eq === -1) return parseErr(searchLineNo);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = trimRightWs(lines[j]);
      if (t === ">>>>>>> REPLACE") {
        rep = j;
        break;
      }
      if (t === "<<<<<<< SEARCH") break;
    }
    if (rep === -1) return parseErr(searchLineNo);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push({ kind: "sr", path: editPath, oldLines, newLines });
    prevPath = editPath;
    prevReplaceEnd = rep + 1;
    i = rep + 1;
  }
  return { edits };
}

// ------------------------------------------------------------------
// V4A parsing (section 8)
// ------------------------------------------------------------------

function isV4aSectionStart(l: string): boolean {
  return (
    l.startsWith("*** Add File:") ||
    l.startsWith("*** Delete File:") ||
    l.startsWith("*** Update File:")
  );
}

function parseV4a(lines: string[]): ParseOut {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return parseErr(1);
  if (trimBothWs(lines[first]) !== "*** Begin Patch") return parseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (trimBothWs(lines[last]) !== "*** End Patch") return parseErr(lines.length + 1);

  const edits: V4aEdit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i++;
      continue;
    }
    const line = lines[i];
    if (line.startsWith("*** Add File:")) {
      const editPath = trimBothWs(line.slice("*** Add File:".length));
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j])) j++;
      let secLines = lines.slice(i + 1, j);
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1])) secLines.pop();
      const addLines: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k];
        if (l.startsWith("+")) addLines.push(l.slice(1));
        else if (isBlank(l)) addLines.push("");
        else return parseErr(i + 2 + k);
      }
      edits.push({ kind: "v4a", op: "add", path: editPath, newPath: null, addLines, chunks: [] });
      i = j;
      continue;
    }
    if (line.startsWith("*** Delete File:")) {
      const editPath = trimBothWs(line.slice("*** Delete File:".length));
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j])) j++;
      let secLines = lines.slice(i + 1, j);
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1])) secLines.pop();
      if (secLines.length > 0) return parseErr(i + 2);
      edits.push({ kind: "v4a", op: "delete", path: editPath, newPath: null, addLines: [], chunks: [] });
      i = j;
      continue;
    }
    if (line.startsWith("*** Update File:")) {
      const editPath = trimBothWs(line.slice("*** Update File:".length));
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j])) j++;
      let secLines = lines.slice(i + 1, j);
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1])) secLines.pop();
      const baseIdx = i + 1; // absolute index of secLines[0]
      let newPath: string | null = null;
      let k = 0;
      if (secLines.length > 0 && secLines[0].startsWith("*** Move to:")) {
        newPath = trimBothWs(secLines[0].slice("*** Move to:".length));
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: { anchor: string | null; ops: { kind: string; text: string }[]; eof: boolean } | null = null;
      let seenChunk = false;
      const closeChunk = (): void => {
        if (cur !== null) {
          const oLines: BodyLine[] = [];
          const nLines: BodyLine[] = [];
          for (const op of cur.ops) {
            if (op.kind === " ") {
              const idx = oLines.length;
              oLines.push({ text: op.text, ctx: true, oIdx: idx });
              nLines.push({ text: op.text, ctx: true, oIdx: idx });
            } else if (op.kind === "-") {
              oLines.push({ text: op.text, ctx: false, oIdx: -1 });
            } else if (op.kind === "+") {
              nLines.push({ text: op.text, ctx: false, oIdx: -1 });
            }
          }
          chunks.push({ anchor: cur.anchor, oLines, nLines, eof: cur.eof });
          cur = null;
        }
      };
      for (; k < secLines.length; k++) {
        const l = secLines[k];
        const absNo = baseIdx + k + 1;
        if (l.startsWith("@@")) {
          closeChunk();
          const anchorText = trimBothWs(l.slice(2));
          cur = { anchor: anchorText === "" ? null : anchorText, ops: [], eof: false };
          seenChunk = true;
        } else if (l === "*** End of File") {
          if (cur === null) return parseErr(absNo);
          cur.eof = true;
          closeChunk();
          seenChunk = true;
        } else if (l === "" || l.startsWith(" ") || l.startsWith("-") || l.startsWith("+")) {
          if (cur === null) {
            if (seenChunk) return parseErr(absNo);
            cur = { anchor: null, ops: [], eof: false };
            seenChunk = true;
          }
          const kind = l === "" ? " " : l[0];
          cur.ops.push({ kind, text: l === "" ? "" : l.slice(1) });
        } else {
          return parseErr(absNo);
        }
      }
      closeChunk();
      if (chunks.length === 0 && newPath === null) return parseErr(i + 1);
      edits.push({ kind: "v4a", op: "update", path: editPath, newPath, addLines: [], chunks });
      i = j;
      continue;
    }
    return parseErr(i + 1);
  }
  return { edits };
}

// ------------------------------------------------------------------
// JSON parsing (section 9)
// ------------------------------------------------------------------

function validateJsonEdit(obj: unknown): JsonEdit | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== "string") return null;
  if (typeof o.command !== "string") return null;
  if (o.command === "create") {
    if (typeof o.file_text !== "string") return null;
    return { kind: "json", command: "create", path: o.path, fileText: o.file_text };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || o.old_str === "") return null;
    if (o.new_str !== undefined && typeof o.new_str !== "string") return null;
    return {
      kind: "json",
      command: "str_replace",
      path: o.path,
      oldStr: o.old_str,
      newStr: o.new_str === undefined ? "" : o.new_str,
    };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== "string") return null;
    return {
      kind: "json",
      command: "insert",
      path: o.path,
      insertLine: o.insert_line,
      newStr: o.new_str,
    };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): ParseOut {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return parseErr(1);
  const firstChar = lines[firstIdx].trimStart()[0];
  if (firstChar === "[") {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      return parseErr(firstIdx + 1);
    }
    if (!Array.isArray(arr)) return parseErr(firstIdx + 1);
    const edits: JsonEdit[] = [];
    for (const item of arr) {
      const e = validateJsonEdit(item);
      if (e === null) return parseErr(firstIdx + 1);
      edits.push(e);
    }
    if (edits.length === 0) return parseErr(1);
    return { edits };
  }
  // JSON Lines form.
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      return parseErr(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (e === null) return parseErr(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) return parseErr(1);
  return { edits };
}

// ------------------------------------------------------------------
// applying edits
// ------------------------------------------------------------------

// Apply one unified hunk to a doc. Returns the new doc (or the
// failure). The doc is not mutated on failure: the caller works on a
// clone and commits it only when every hunk succeeded.
function applyHunk(
  doc: FileDoc,
  hunk: Hunk,
  d: number,
  strict: boolean,
  failPath: string,
): { doc: FileDoc; d: number } | ApplyResult {
  const oText = hunk.oLines.map((l) => l.text);
  if (oText.length === 0) {
    let pos = hunk.a + d;
    if (pos < 0) pos = 0;
    if (pos > doc.lines.length) pos = doc.lines.length;
    const atEnd = pos === doc.lines.length;
    const ins = hunk.nLines.map((nl) => nl.text);
    const next: FileDoc = {
      eol: doc.eol,
      lines: doc.lines.slice(),
      endsWithBreak: doc.endsWithBreak,
    };
    next.lines.splice(pos, 0, ...ins);
    if (atEnd && ins.length > 0) next.endsWithBreak = !hunk.noEol;
    return { doc: next, d: d + ins.length };
  }
  const found = findTier(doc.lines, oText, strict);
  if (found === null) return fail("no-match", failPath);
  const target = hunk.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const toEnd = pos + oText.length === doc.lines.length;
  const rep = buildReplacement(doc, pos, hunk.nLines, found.tier, leadingWs(oText[0]));
  const next: FileDoc = {
    eol: doc.eol,
    lines: doc.lines.slice(),
    endsWithBreak: doc.endsWithBreak,
  };
  next.lines.splice(pos, oText.length, ...rep);
  if (toEnd) next.endsWithBreak = !hunk.noEol;
  return { doc: next, d: d + (rep.length - oText.length) };
}

function applyUnified(edit: UnifiedEdit, tree: Map<string, FileDoc>, strict: boolean): ApplyResult {
  if (edit.oldPath !== null && !isSafePath(edit.oldPath)) return fail("unsafe", edit.oldPath);
  if (edit.newPath !== null && !isSafePath(edit.newPath)) return fail("unsafe", edit.newPath);
  if (edit.mode === "create") {
    const np = edit.newPath;
    if (np === null) return { ok: true }; // degenerate: both ends /dev/null
    if (tree.has(np)) return fail("exists", np);
    const plus: string[] = [];
    let lastWithPlus: Hunk | null = null;
    for (const h of edit.hunks) {
      const ps = h.nLines.filter((nl) => !nl.ctx).map((nl) => nl.text);
      if (ps.length > 0) {
        plus.push(...ps);
        lastWithPlus = h;
      }
    }
    tree.set(np, {
      eol: "\n",
      lines: plus,
      endsWithBreak: plus.length > 0 ? !lastWithPlus!.noEol : false,
    });
    return { ok: true };
  }
  if (edit.mode === "delete") {
    const op = edit.oldPath;
    if (op === null) return { ok: true };
    if (!tree.has(op)) return fail("missing", op);
    tree.delete(op);
    return { ok: true };
  }
  const op = edit.oldPath!;
  if (!tree.has(op)) return fail("missing", op);
  if (edit.mode === "move" && tree.has(edit.newPath!)) return fail("exists", edit.newPath!);
  let doc = cloneDoc(tree.get(op)!);
  let d = 0;
  for (const h of edit.hunks) {
    const r = applyHunk(doc, h, d, strict, op);
    if ("ok" in r) return r;
    doc = r.doc;
    d = r.d;
  }
  if (edit.mode === "move") {
    tree.delete(op);
    tree.set(edit.newPath!, doc);
  } else {
    tree.set(op, doc);
  }
  return { ok: true };
}

function applySr(edit: SrEdit, tree: Map<string, FileDoc>, strict: boolean): ApplyResult {
  if (!isSafePath(edit.path)) return fail("unsafe", edit.path);
  if (edit.oldLines.length === 0) {
    if (tree.has(edit.path)) return fail("exists", edit.path);
    const lines = edit.newLines;
    tree.set(edit.path, { eol: "\n", lines, endsWithBreak: lines.length > 0 });
    return { ok: true };
  }
  const doc = tree.get(edit.path);
  if (doc === undefined) return fail("missing", edit.path);
  const found = findTier(doc.lines, edit.oldLines, strict);
  if (found === null) return fail("no-match", edit.path);
  if (found.occ.length > 1) return fail("ambiguous", edit.path);
  const pos = found.occ[0];
  const p = leadingWs(edit.oldLines[0]);
  const rep = edit.newLines.map((l) => (found.tier === 2 ? reindentLine(l, p, leadingWs(doc.lines[pos])) : l));
  doc.lines.splice(pos, edit.oldLines.length, ...rep);
  return { ok: true };
}

function applyV4a(edit: V4aEdit, tree: Map<string, FileDoc>, strict: boolean): ApplyResult {
  if (!isSafePath(edit.path)) return fail("unsafe", edit.path);
  if (edit.newPath !== null && !isSafePath(edit.newPath)) return fail("unsafe", edit.newPath);
  if (edit.op === "add") {
    if (tree.has(edit.path)) return fail("exists", edit.path);
    const lines = edit.addLines;
    tree.set(edit.path, { eol: "\n", lines, endsWithBreak: lines.length > 0 });
    return { ok: true };
  }
  if (edit.op === "delete") {
    if (!tree.has(edit.path)) return fail("missing", edit.path);
    tree.delete(edit.path);
    return { ok: true };
  }
  const doc0 = tree.get(edit.path);
  if (doc0 === undefined) return fail("missing", edit.path);
  if (edit.newPath !== null && tree.has(edit.newPath)) return fail("exists", edit.newPath);
  const doc = cloneDoc(doc0);
  let cursor = 0;
  for (const chunk of edit.chunks) {
    if (chunk.anchor !== null) {
      const idx = findAnchor(doc.lines, chunk.anchor, cursor, strict);
      if (idx === -1) return fail("no-match", edit.path);
      cursor = idx + 1;
    }
    const oText = chunk.oLines.map((l) => l.text);
    if (oText.length === 0) {
      const pos = chunk.eof ? doc.lines.length : cursor;
      const ins = chunk.nLines.map((nl) => nl.text);
      doc.lines.splice(pos, 0, ...ins);
      cursor = pos + ins.length;
      continue;
    }
    const found = findTierFrom(doc.lines, oText, cursor, strict, chunk.eof);
    if (found === null) return fail("no-match", edit.path);
    const pos = found.pos;
    const rep = buildReplacement(doc, pos, chunk.nLines, found.tier, leadingWs(oText[0]));
    doc.lines.splice(pos, oText.length, ...rep);
    cursor = pos + rep.length;
  }
  if (edit.newPath !== null) {
    tree.delete(edit.path);
    tree.set(edit.newPath, doc);
  } else {
    tree.set(edit.path, doc);
  }
  return { ok: true };
}

function countOccurrences(text: string, sub: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let idx = text.indexOf(sub);
  while (idx !== -1) {
    count++;
    if (first === -1) first = idx;
    idx = text.indexOf(sub, idx + 1);
  }
  return { count, first };
}

function applyJson(edit: JsonEdit, tree: Map<string, FileDoc>): ApplyResult {
  if (!isSafePath(edit.path)) return fail("unsafe", edit.path);
  if (edit.command === "create") {
    if (tree.has(edit.path)) return fail("exists", edit.path);
    tree.set(edit.path, parseDoc(edit.fileText!));
    return { ok: true };
  }
  const doc = tree.get(edit.path);
  if (doc === undefined) return fail("missing", edit.path);
  if (edit.command === "str_replace") {
    const text = serializeDoc(doc);
    let normText = text;
    let normOld = edit.oldStr!;
    let normNew = edit.newStr!;
    if (doc.eol === "\r\n") {
      normText = text.replace(/\r\n/g, "\n");
      normOld = normOld.replace(/\r\n/g, "\n");
      normNew = normNew.replace(/\r\n/g, "\n");
    }
    const { count, first } = countOccurrences(normText, normOld);
    if (count === 0) return fail("no-match", edit.path);
    if (count > 1) return fail("ambiguous", edit.path);
    const result = normText.slice(0, first) + normNew + normText.slice(first + normOld.length);
    tree.set(edit.path, parseDoc(doc.eol === "\r\n" ? result.replace(/\n/g, "\r\n") : result));
    return { ok: true };
  }
  // insert
  const n = doc.lines.length;
  const at = edit.insertLine!;
  if (at < 0 || at > n) return fail("no-match", edit.path);
  const ins = splitInsertedLines(edit.newStr!);
  doc.lines.splice(at, 0, ...ins);
  return { ok: true };
}

function applyEdit(edit: Edit, tree: Map<string, FileDoc>, strict: boolean): ApplyResult {
  if (edit.kind === "unified") return applyUnified(edit, tree, strict);
  if (edit.kind === "sr") return applySr(edit, tree, strict);
  if (edit.kind === "v4a") return applyV4a(edit, tree, strict);
  return applyJson(edit, tree);
}

// ------------------------------------------------------------------
// change report
// ------------------------------------------------------------------

function computeChanges(
  original: Map<string, string>,
  finalMap: Map<string, string>,
  edits: Edit[],
): string[] {
  const moves: { old: string; next: string }[] = [];
  for (const e of edits) {
    if (e.kind === "unified" && e.mode === "move" && e.oldPath !== null && e.newPath !== null) {
      moves.push({ old: e.oldPath, next: e.newPath });
    }
    if (e.kind === "v4a" && e.op === "update" && e.newPath !== null) {
      moves.push({ old: e.path, next: e.newPath });
    }
  }
  const lines: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const m of moves) {
    const oldInOrig = original.has(m.old);
    const oldInFinal = finalMap.has(m.old);
    const newInOrig = original.has(m.next);
    const newInFinal = finalMap.has(m.next);
    if (oldInOrig && !oldInFinal && !newInOrig && newInFinal) {
      lines.push({ key: m.next, text: `R ${m.old} -> ${m.next}` });
      used.add(m.old);
      used.add(m.next);
    }
  }
  const allPaths = new Set<string>([...original.keys(), ...finalMap.keys()]);
  for (const p of allPaths) {
    if (used.has(p)) continue;
    const inOrig = original.has(p);
    const inFinal = finalMap.has(p);
    if (inOrig && !inFinal) lines.push({ key: p, text: `D ${p}` });
    else if (!inOrig && inFinal) lines.push({ key: p, text: `A ${p}` });
    else if (inOrig && inFinal && original.get(p) !== finalMap.get(p)) {
      lines.push({ key: p, text: `M ${p}` });
    }
  }
  lines.sort((a, b) => byteCompare(a.key, b.key));
  return lines.map((l) => l.text);
}

// ------------------------------------------------------------------
// argument parsing and main
// ------------------------------------------------------------------

interface CliArgs {
  format: string; // "auto" | "unified" | "search-replace" | "v4a" | "json"
  check: boolean;
  strict: boolean;
  patch: string | null; // null means stdin
  usageError: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { format: "auto", check: false, strict: false, patch: null, usageError: false };
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOptions = false;
  let positional = 0;
  for (const a of argv) {
    if (!noMoreOptions && a === "--") {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith("--format=")) {
      if (seenFormat) {
        args.usageError = true;
        return args;
      }
      seenFormat = true;
      const v = a.slice("--format=".length);
      if (v !== "unified" && v !== "search-replace" && v !== "v4a" && v !== "json" && v !== "auto") {
        args.usageError = true;
        return args;
      }
      args.format = v;
      continue;
    }
    if (!noMoreOptions && a === "--check") {
      if (seenCheck) {
        args.usageError = true;
        return args;
      }
      seenCheck = true;
      args.check = true;
      continue;
    }
    if (!noMoreOptions && a === "--strict") {
      if (seenStrict) {
        args.usageError = true;
        return args;
      }
      seenStrict = true;
      args.strict = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith("-") && a !== "-") {
      args.usageError = true;
      return args;
    }
    positional++;
    if (positional > 1) {
      args.usageError = true;
      return args;
    }
    args.patch = a;
  }
  return args;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.usageError) {
    out("error: usage\n");
    return 2;
  }
  let patchText: string;
  if (args.patch === null || args.patch === "-") {
    patchText = fs.readFileSync(0, "utf8");
  } else {
    try {
      patchText = fs.readFileSync(args.patch, "utf8");
    } catch {
      out("error: no-patch\n");
      return 2;
    }
  }
  const lines = splitPatchLines(patchText);
  let format = args.format;
  if (format === "auto") {
    const detected = detectFormat(lines);
    if (detected === null) {
      out("error: format\n");
      return 2;
    }
    format = detected;
  }
  let parsed: ParseOut;
  if (format === "unified") parsed = parseUnified(lines);
  else if (format === "search-replace") parsed = parseSearchReplace(lines);
  else if (format === "v4a") parsed = parseV4a(lines);
  else parsed = parseJson(lines, patchText);
  if ("parseError" in parsed) {
    out(`error: parse ${parsed.parseError}\n`);
    return 2;
  }
  const edits = parsed.edits;
  if (edits.length === 0) {
    out("error: parse 1\n");
    return 2;
  }
  const original = loadTree(process.cwd());
  const tree = new Map<string, FileDoc>();
  for (const [p, text] of original) tree.set(p, parseDoc(text));
  const failures: EditFailure[] = [];
  for (const e of edits) {
    const r = applyEdit(e, tree, args.strict);
    if (!r.ok) failures.push(r.fail);
  }
  if (failures.length > 0) {
    let s = "";
    for (const f of failures) s += `error: ${f.code} ${f.path}\n`;
    s += `failed: ${failures.length} of ${edits.length} edits\n`;
    out(s);
    return 1;
  }
  const finalMap = new Map<string, string>();
  for (const [p, doc] of tree) finalMap.set(p, serializeDoc(doc));
  const changeLines = computeChanges(original, finalMap, edits);
  let s = "";
  for (const l of changeLines) s += l + "\n";
  s += changeLines.length === 1 ? "ok: 1 file\n" : `ok: ${changeLines.length} files\n`;
  out(s);
  if (!args.check) writeTree(original, finalMap);
  return 0;
}

// ------------------------------------------------------------------
// runner: when MAKEFUN_ENV_URL is set, hand over to runner.ts.
// ------------------------------------------------------------------

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== "") {
  // The runner lives next to this file; load it dynamically so the
  // plain CLI path stays fast and dependency-free.
  import("./runner.ts").then((mod) => {
    const p = mod.run(envUrl);
    Promise.resolve(p).then(
      (code) => {
        process.exit(code);
      },
      (err) => {
        process.stderr.write(String(err) + "\n");
        process.exit(1);
      },
    );
  });
} else {
  process.exit(main(process.argv.slice(2)));
}
