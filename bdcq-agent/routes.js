// bdcq-agent/routes.js — Express router for all /api/bdcq/* endpoints
// Mounted in server.js via:  app.use("/api/bdcq", require("./bdcq-agent/routes"))
"use strict";

const express = require("express");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
const { spawn } = require("child_process");
const router  = express.Router();

const isWin          = process.platform === "win32";
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

// Resolve the claude executable on Windows.
// Priority: CLAUDE_PATH env var → known .local/bin path → PATH fallback
function resolveClaudeExe() {
  if (!isWin) return "claude";
  if (process.env.CLAUDE_PATH && fs.existsSync(process.env.CLAUDE_PATH)) {
    return process.env.CLAUDE_PATH;
  }
  // Known install location from Claude Code installer
  const userProfile = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const knownPaths = [
    path.join(userProfile, ".local", "bin", "claude.exe"),
    path.join(userProfile, "AppData", "Local", "Programs", "claude", "claude.exe"),
  ];
  for (const p of knownPaths) {
    if (fs.existsSync(p)) return p;
  }
  // Last resort: rely on PATH (may fail in child processes)
  return "claude";
}

// Spawn  claude --print  and resolve with stdout text
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const claudeExe = resolveClaudeExe();
    const isCmd     = isWin && claudeExe.toLowerCase().endsWith(".cmd");
    const proc = spawn(claudeExe, ["--model", CLAUDE_MODEL, "--print", "--dangerously-skip-permissions"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: isCmd,   // .cmd files require shell:true on Windows
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        PATH: [
          path.join(os.homedir(), ".local", "bin"),
          path.join(os.homedir(), "AppData", "Local", "Programs", "claude"),
          process.env.PATH || "",
        ].join(isWin ? ";" : ":"),
      },
    });
    let out = "", err = "";
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { err += d; });
    proc.on("error", e => {
      const msg = e.code === "ENOENT"
        ? "Claude CLI not installed. Download from claude.ai/code, install it, then restart START.bat."
        : `Claude CLI error: ${e.message}`;
      reject(new Error(msg));
    });
    proc.on("close", code => {
      // Log raw output to server console for debugging
      if (!out.includes("[")) {
        console.error("[BDCQ Claude] Exit:", code, "| stdout:", out.slice(0, 400), "| stderr:", err.slice(0, 200));
      }
      if (code !== 0) return reject(new Error(err.slice(0, 300) || `Claude exited with code ${code}`));
      resolve(out);
    });
    proc.stdin.write(prompt, "utf8");
    proc.stdin.end();
  });
}

// ── LOB → BDCQ domain fuzzy mapping ─────────────────────────────────────────
// Both sides are normalised to lowercase for comparison.
const LOB_KEYWORDS = [
  { lob: ["finance", "fac finance", "controlling", "accounting"],      domain: ["finance", "controlling"] },
  { lob: ["asset management"],                                          domain: ["asset"] },
  { lob: ["manufacturing"],                                             domain: ["manufactur"] },
  { lob: ["supply chain", "logistics"],                                 domain: ["supply chain", "logistic", "warehouse", "inventory"] },
  { lob: ["sales"],                                                     domain: ["sales", "order management"] },
  { lob: ["service"],                                                   domain: ["service"] },
  { lob: ["human resources", "hr"],                                     domain: ["human resource", "hr", "payroll", "workforce"] },
  { lob: ["sourcing", "procurement"],                                   domain: ["procure", "sourcing", "purchasing"] },
  { lob: ["professional services"],                                     domain: ["professional service", "project"] },
  { lob: ["r&d", "engineering"],                                        domain: ["r&d", "engineering", "product"] },
  { lob: ["solutions for specific industries"],                         domain: ["industry", "solution"] },
];

function lobsToDomains(lobs, availableDomains) {
  const result = new Set();
  const normLobs    = lobs.map(l => l.toLowerCase());
  const normDomains = availableDomains.map(d => ({ orig: d, norm: d.toLowerCase() }));

  for (const lobNorm of normLobs) {
    for (const rule of LOB_KEYWORDS) {
      const lobMatch = rule.lob.some(kw => lobNorm.includes(kw));
      if (!lobMatch) continue;
      for (const domEntry of normDomains) {
        if (rule.domain.some(kw => domEntry.norm.includes(kw))) {
          result.add(domEntry.orig);
        }
      }
    }
    // Fallback: direct substring match between lob and domain
    for (const domEntry of normDomains) {
      if (domEntry.norm.includes(lobNorm) || lobNorm.includes(domEntry.norm)) {
        result.add(domEntry.orig);
      }
    }
  }
  return [...result];
}

// ROOT is two levels up from this file (bdcq-agent/ → explore-accelerator/)
const ROOT = path.join(__dirname, "..");

// ── Locate bdcq-questions.json ────────────────────────────────────────────────
// Checked in priority order; first match wins.
const SEARCH_PATHS = [
  path.join(ROOT, "bdcq", "bdcq-questions.json"),
  path.join(ROOT, "output", "bdcq", "bdcq-questions.json"),
  path.join(ROOT, "bdcq-questions.json")
];

function findBDCQFile() {
  for (const p of SEARCH_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readBDCQData() {
  const p = findBDCQFile();
  if (!p) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Determine if a sheet name is a 2-letter country/locale code
const isCountrySheet = name => /^[A-Za-z]{2}$/.test(name);

// ── GET /api/bdcq/status ──────────────────────────────────────────────────────
// Returns metadata from bdcq-questions.json without exposing row data.
router.get("/status", (req, res) => {
  try {
    const data = readBDCQData();
    if (!data) {
      return res.json({ found: false });
    }

    const globalColumnSet = new Set();
    const countrySet      = new Set();
    let   totalQuestions  = 0;

    // Per-domain metadata: name + its own column set + question count
    const domainMeta = (data.domains || []).map(domain => {
      const domColSet = new Set();
      let   domQCount = 0;
      for (const sheet of (domain.sheets || [])) {
        const sheetName = sheet.sheet || "";
        (sheet.headers || []).forEach(h => {
          if (h) { domColSet.add(h); globalColumnSet.add(h); }
        });
        if (isCountrySheet(sheetName)) countrySet.add(sheetName.toUpperCase());
        const rowCount = (sheet.rows || []).length;
        domQCount      += rowCount;
        totalQuestions += rowCount;
      }
      return {
        name:      domain.domain || "",
        filename:  domain.filename || "",
        columns:   [...domColSet],
        questions: domQCount
      };
    }).filter(d => d.name);

    res.json({
      found:          true,
      totalDomains:   data.totalDomains || domainMeta.length,
      totalQuestions,
      modules:        domainMeta.map(d => d.name),
      columns:        [...globalColumnSet],   // kept for backward compat
      domainMeta,                             // per-domain: name, columns, questions
      countries:      [...countrySet].sort(),
      generatedAt:    data.generatedAt || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bdcq/upload ─────────────────────────────────────────────────────
// Accepts { content: base64 } body, validates and saves to bdcq/bdcq-questions.json.
router.post("/upload", express.json({ limit: "50mb" }), (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ ok: false, error: "No content provided" });

  try {
    const buf  = Buffer.from(content, "base64");
    const text = buf.toString("utf8");
    const data = JSON.parse(text);

    if (!data || !Array.isArray(data.domains)) {
      return res.status(400).json({ ok: false, error: "Invalid file: missing domains array" });
    }

    const dir  = path.join(ROOT, "bdcq");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "bdcq-questions.json");
    fs.writeFileSync(dest, text, "utf8");

    res.json({ ok: true, totalDomains: (data.domains || []).length, savedTo: dest });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/bdcq/generate ───────────────────────────────────────────────────
// Runs the builder with user-supplied config, returns filename + rowCount.
router.post("/generate", express.json({ limit: "512kb" }), (req, res) => {
  const {
    filename,
    scopeIds        = [],
    selectedDomains = [],
    selectedColumns = [],
    countries       = [],
    clientName      = "",
    projectName     = "",
    overviewText    = "",
    clientLogo      = null,   // base64 data URL
    partnerLogo     = null    // base64 data URL
  } = req.body || {};

  if (!filename) {
    return res.status(400).json({ ok: false, error: "filename is required" });
  }

  try {
    const data = readBDCQData();
    if (!data) {
      return res.status(404).json({
        ok: false,
        error: "bdcq-questions.json not found. Upload the file first."
      });
    }

    const { buildBDCQExcel } = require("./bdcq-builder");
    const outDir = path.join(ROOT, "output");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const result = buildBDCQExcel({
      bdcqData:        data,
      scopeIds:        Array.isArray(scopeIds)        ? scopeIds        : [],
      selectedDomains: Array.isArray(selectedDomains) ? selectedDomains : [],
      selectedColumns: Array.isArray(selectedColumns) ? selectedColumns : [],
      countries:       Array.isArray(countries)       ? countries       : [],
      clientName,
      projectName,
      overviewText,
      clientLogo,
      partnerLogo,
      filename,
      outputDir: outDir
    });

    res.json({ ok: true, filename: result.filename, rowCount: result.rowCount, logoFiles: result.logoFiles || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/bdcq/scope-lookup?ids=BD6,J59 ───────────────────────────────────
// Maps scope item IDs (from DDA) to BDCQ domain names via LOB field.
router.get("/scope-lookup", (req, res) => {
  const ids = (req.query.ids || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!ids.length) return res.json({ domains: [], matchedIds: [], matchedLobs: [] });

  const catalogPath = path.join(ROOT, "scope-catalog.json");
  if (!fs.existsSync(catalogPath)) {
    return res.json({ domains: [], error: "scope-catalog.json not found" });
  }

  const catalog  = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const processes = catalog.processes || [];

  const lobSet     = new Set();
  const matchedIds = [];
  for (const item of processes) {
    if (ids.includes((item.id || "").toUpperCase())) {
      matchedIds.push(item.id);
      if (item.lob) lobSet.add(item.lob);
    }
  }

  const bdcqData        = readBDCQData();
  const availableDomains = bdcqData ? (bdcqData.domains || []).map(d => d.domain || "").filter(Boolean) : [];
  const domains         = lobsToDomains([...lobSet], availableDomains);

  res.json({ domains, matchedIds, matchedLobs: [...lobSet] });
});

// ── POST /api/bdcq/preview ────────────────────────────────────────────────────
// Same filtering as generate, but returns rows as JSON for the in-browser editor.
router.post("/preview", express.json({ limit: "512kb" }), (req, res) => {
  const {
    scopeIds        = [],
    selectedDomains = [],
    selectedColumns = [],
    countries       = []
  } = req.body || {};

  try {
    const data = readBDCQData();
    if (!data) return res.status(404).json({ ok: false, error: "bdcq-questions.json not found. Upload the file first." });

    const scopeSet   = new Set((scopeIds        || []).map(s => s.toUpperCase().trim()).filter(Boolean));
    const countrySet = new Set((countries       || []).map(c => c.toUpperCase().trim()).filter(Boolean));
    const domainSet  = new Set((selectedDomains || []).map(d => d.toLowerCase().trim()).filter(Boolean));
    const isCountrySheet = name => /^[A-Za-z]{2}$/.test(name);

    const allRows    = [];
    const allHeaders = [];
    const headerSet  = new Set();

    for (const domain of data.domains) {
      const domainName = domain.domain || "";
      if (domainSet.size > 0 && !domainSet.has(domainName.toLowerCase().trim())) continue;

      for (const sheet of (domain.sheets || [])) {
        const sheetName = sheet.sheet || "";
        if (isCountrySheet(sheetName)) {
          if (countrySet.size === 0 || !countrySet.has(sheetName.toUpperCase())) continue;
        }
        (sheet.headers || []).forEach(h => {
          if (h && !headerSet.has(h)) { headerSet.add(h); allHeaders.push(h); }
        });
        for (const row of (sheet.rows || [])) {
          if (scopeSet.size > 0) {
            const values = Object.values(row).map(v => String(v || "").toUpperCase().trim());
            if (!values.some(v => scopeSet.has(v))) continue;
          }
          allRows.push({
            Module: domainName,
            Section: sheetName,
            _localizationCountry: isCountrySheet(sheetName) ? sheetName.toUpperCase() : "Global",
            ...row
          });
        }
      }
    }

    // Determine output columns (same logic as builder)
    const baseColumns = ["Module", "Section"];
    let dataColumns;
    if (selectedColumns && selectedColumns.length > 0) {
      // Match known headers case-insensitively; keep custom column names as-is
      // (custom cols won't be in allHeaders — they appear empty in Excel, ready for manual fill-in)
      dataColumns = selectedColumns
        .map(c => allHeaders.find(h => h.toLowerCase() === c.toLowerCase()) || c)
        .filter(Boolean);
    } else {
      dataColumns = allHeaders;
    }
    const outputColumns = [...baseColumns, ...dataColumns];

    // Detect the "question" column: prefer a col named "question",
    // fallback to the data column with the most cumulative content length.
    const dataOnlyCols = dataColumns.filter(Boolean);
    const colContentScore = {};
    for (const row of allRows.slice(0, 30)) {
      for (const col of dataOnlyCols) {
        const len = String(row[col] || "").trim().length;
        colContentScore[col] = (colContentScore[col] || 0) + len;
      }
    }
    const questionCol =
      dataOnlyCols.find(c => /question/i.test(c)) ||
      Object.entries(colContentScore).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      dataOnlyCols[0] || "Question";

    res.json({ ok: true, rows: allRows, columns: outputColumns, questionCol, rowCount: allRows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/bdcq/enrich ─────────────────────────────────────────────────────
// Claude enriches a batch of rows with SAP Standard Value + Watch Out columns.
// Body: { domain: string, questionCol: string, rows: [...] }
router.post("/enrich", express.json({ limit: "2mb" }), async (req, res) => {
  const { domain = "", questionCol = "Question", rows: rawRows = [] } = req.body || {};
  if (!rawRows.length) return res.json({ ok: true, enrichments: [] });

  // ── Column name aliases — SAP BDCQ files use slightly different names ────────
  function getCol(row, ...candidates) {
    for (const c of candidates) {
      const key = Object.keys(row).find(k => k.toLowerCase().includes(c.toLowerCase()));
      if (key && String(row[key]).trim()) return String(row[key]).trim();
    }
    return "";
  }

  // ── Filter out rows with no real question text ────────────────────────────────
  // Only skip rows that are truly blank or are a literal copy of the domain name.
  // Do NOT filter by regex patterns — SAP BDCQ questions can be short 2-word phrases
  // like "Payment Terms", "Fiscal Year", "Cost Object" which are valid config decisions.
  const domainNameLower = (domain || "").trim().toLowerCase();
  const isInvalidRow = (r) => {
    const q = String(r[questionCol] || r["Question"] || "").trim();
    if (!q || q.length < 3)               return true;  // truly blank
    if (q.toLowerCase() === domainNameLower) return true;  // row is just the domain name
    return false;
  };

  const rows = rawRows.filter(r => !isInvalidRow(r));

  // Track original indices so enrichments map back to rawRows correctly
  const validIndices = rawRows.map(r => !isInvalidRow(r));

  if (!rows.length) {
    console.warn(`[BDCQ enrich] All ${rawRows.length} rows for "${domain}" were filtered as invalid questions.`);
    return res.json({ ok: true, enrichments: rawRows.map(() => ({ standardValue: "", watchOut: "" })) });
  }

  // Build per-question reference block from the SAP-authored BDCQ data already
  // present in the Excel rows. This grounds Claude in the real SAP standard values
  // and watch-out points instead of having it generate them from scratch.
  const questionLines = rows.map((r, i) => {
    const question   = String(r[questionCol] || r["Question"] || "").trim().slice(0, 300);
    const topicDef   = getCol(r, "topic definition", "definition", "description").slice(0, 400);
    const stdVal     = getCol(r, "sample value", "standard value", "standard values").slice(0, 600);
    const watchOut   = getCol(r, "watch out", "constraint", "watch-out").slice(0, 500);

    let block = `${i + 1}. Question: ${question}`;
    if (topicDef) block += `\n   SAP Context: ${topicDef}`;
    if (stdVal)   block += `\n   SAP Standard Value (from BDCQ): ${stdVal}`;
    if (watchOut) block += `\n   SAP Watch-Out (from BDCQ): ${watchOut}`;
    return block;
  }).join("\n\n");

  const hasRefData = rows.some(r =>
    getCol(r, "sample value", "standard value") || getCol(r, "watch out", "constraint")
  );

  const prompt = `You are an SAP S/4HANA Cloud Public Edition (Cloud PE) configuration expert.
${hasRefData ? `
The SAP-authored BDCQ reference data is included for each question (SAP Standard Value and Watch-Out Point columns from the source Excel).
Your job is to CLEAN, CONSOLIDATE and REFORMAT that reference data — not to invent new content.
- "standardValue": Rewrite the SAP Standard Value in 1–3 concise sentences. Name the Fiori app used to configure it. Keep specific values (codes, types, IDs).
- "watchOut": Rewrite the Watch-Out / Constraints in 1–3 concise bullet points. Keep specific constraints. Remove repetition.
If the reference data is empty for a question, derive the answer from SAP Cloud PE standards.` : `
For each question provide:
- "standardValue": SAP-standard default or recommended value for Cloud PE. Name the Fiori app. If client-specific, say "Client-specific — confirm in workshop".
- "watchOut": Key constraints or irreversible decisions. Empty string "" if none.`}

RULES — strictly enforced:
- SAP S/4HANA Cloud Public Edition ONLY. No T-codes, SPRO, ABAP, SAP GUI, or on-premise references.
- Return ONLY a valid JSON array — no markdown fences, no explanation outside the array.
- Array length MUST exactly match the number of questions (${rows.length}).

Domain: ${domain}
Questions (${rows.length} total):
${questionLines}

Return format (one object per question, same order):
[{"standardValue":"...","watchOut":"..."},...]`;

  try {
    const raw = await runClaude(prompt);
    // Strip markdown code fences if present (```json ... ```)
    const cleaned = raw.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();
    const s = cleaned.indexOf("[");
    const e = cleaned.lastIndexOf("]");
    if (s === -1 || e === -1) {
      // Show first 300 chars of what Claude actually said to help diagnose
      const preview = cleaned.slice(0, 300).replace(/\n/g, " ");
      throw new Error(`No JSON array in Claude response. Claude said: "${preview}"`);
    }
    const validEnrichments = JSON.parse(cleaned.slice(s, e + 1));

    // Map enrichments back to rawRows — skipped rows get empty enrichment
    let validIdx = 0;
    const enrichments = validIndices.map(isValid => {
      if (isValid) return validEnrichments[validIdx++] || { standardValue: "", watchOut: "" };
      return { standardValue: "", watchOut: "" };
    });

    res.json({ ok: true, enrichments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/bdcq/export-editor ─────────────────────────────────────────────
// Builds Excel with Cover sheet + BDCQ Questionnaire sheet.
// Body: { filename, rows, columns, clientName, clientLogo, partnerLogo }
//   clientLogo / partnerLogo: base64 data URL strings (optional)
router.post("/export-editor", express.json({ limit: "20mb" }), async (req, res) => {
  const { filename, rows: rawRows = [], columns = [], clientName = "", overviewText = "", clientLogo = null, partnerLogo = null } = req.body || {};
  if (!filename) return res.status(400).json({ ok: false, error: "filename is required" });
  if (!rawRows.length) return res.status(400).json({ ok: false, error: "No rows to export" });
  console.log(`[BDCQ export] columns received (${columns.length}):`, columns.join(", "));

  // ── Filter out empty / template rows before export ────────────────────────
  // Rows where the question field is blank, a section header, or just the
  // domain name (e.g. "Template Overview", "Asset Management") are skipped.
  const questionCol = "Question";
  // Only filter truly blank rows — do not use regex patterns that discard valid SAP questions
  const rows = rawRows.filter(r => {
    const q = String(r[questionCol] || r["Business Driven Configuration Questionnaire"] || "").trim();
    return q.length >= 3;
  });

  try {
    const ExcelJS = require("exceljs");
    const outDir  = path.join(ROOT, "output");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const wb = new ExcelJS.Workbook();
    wb.creator  = "Fulcrum";
    wb.created  = new Date();

    // ── Helper: parse base64 data URL → Buffer ──────────────────────────────
    function dataUrlToBuffer(dataUrl) {
      if (!dataUrl) return null;
      const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/i);
      if (!match) return null;
      return { ext: match[1].replace("jpg","jpeg"), buf: Buffer.from(match[2], "base64") };
    }

    // ── SHEET 1: Cover ───────────────────────────────────────────────────────
    const cover = wb.addWorksheet("Cover", { views: [{ showGridLines: false }] });
    cover.getColumn("A").width = 4;
    cover.getColumn("B").width = 28;
    cover.getColumn("C").width = 36;
    cover.getColumn("D").width = 28;
    cover.getColumn("E").width = 4;

    // Purple header band (rows 1-8)
    for (let r = 1; r <= 8; r++) {
      const row = cover.getRow(r);
      row.height = r === 1 || r === 8 ? 8 : 30;
      ["A","B","C","D","E"].forEach(c => {
        const cell = cover.getCell(`${c}${r}`);
        cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF5B21B6" } };
      });
    }

    // Logo placeholders / actual logos in header
    const clientImg  = dataUrlToBuffer(clientLogo);
    const partnerImg = dataUrlToBuffer(partnerLogo);

    if (clientImg) {
      const imgId = wb.addImage({ buffer: clientImg.buf, extension: clientImg.ext });
      cover.addImage(imgId, { tl:{ col:1, row:1 }, br:{ col:2.8, row:7 }, editAs:"oneCell" });
    } else if (clientName) {
      const nc = cover.getCell("B3");
      nc.value = clientName;
      nc.font  = { name:"Calibri", size:18, bold:true, color:{ argb:"FFFFFFFF" } };
      nc.alignment = { vertical:"middle" };
      cover.mergeCells("B3:C6");
    }

    if (partnerImg) {
      const imgId2 = wb.addImage({ buffer: partnerImg.buf, extension: partnerImg.ext });
      cover.addImage(imgId2, { tl:{ col:3, row:1 }, br:{ col:4.8, row:7 }, editAs:"oneCell" });
    } else {
      const pc = cover.getCell("D3");
      pc.value = "Accenture";
      pc.font  = { name:"Calibri", size:16, bold:true, color:{ argb:"FFFFFFFF" } };
      pc.alignment = { vertical:"middle", horizontal:"right" };
      cover.mergeCells("D3:D6");
    }

    // Title row (row 9)
    cover.getRow(9).height = 14;

    // Main title (rows 10-13)
    cover.mergeCells("B10:D12");
    const title = cover.getCell("B10");
    title.value = "Business Driven Configuration Questionnaire";
    title.font  = { name:"Calibri", size:22, bold:true, color:{ argb:"FF1E293B" } };
    title.alignment = { vertical:"middle", wrapText:true };
    cover.getRow(10).height = 36;
    cover.getRow(11).height = 36;
    cover.getRow(12).height = 36;

    // Subtitle
    cover.mergeCells("B13:D13");
    const sub = cover.getCell("B13");
    sub.value = "SAP S/4HANA Cloud Public Edition · Explore Phase";
    sub.font  = { name:"Calibri", size:12, color:{ argb:"FF64748B" } };
    cover.getRow(13).height = 20;

    // Divider row
    cover.getRow(14).height = 12;
    ["B","C","D"].forEach(c => {
      cover.getCell(`${c}14`).border = { bottom:{ style:"medium", color:{ argb:"FF5B21B6" } } };
    });

    // Summary stats (row 16+)
    const domains   = [...new Set(rows.map(r => r.Module).filter(Boolean))];
    const answered  = rows.filter(r => String(r.Answer||"").trim()).length;
    const exported  = new Date().toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" });

    const stats = [
      ["Client",           clientName || "—"],
      ["Total Questions",  String(rows.length)],
      ["Domains Covered",  domains.join(", ") || "—"],
      ["Answered",         `${answered} / ${rows.length}`],
      ["Export Date",      exported],
      ["Prepared by",      "Fulcrum v1 · Accenture"],
    ];

    cover.getRow(15).height = 10;
    stats.forEach(([label, value], i) => {
      const rowNum = 16 + i * 2;
      cover.getRow(rowNum).height = 22;

      const lc = cover.getCell(`B${rowNum}`);
      lc.value = label;
      lc.font  = { name:"Calibri", size:10, bold:true, color:{ argb:"FF9CA3AF" } };

      const vc = cover.getCell(`C${rowNum}`);
      vc.value = value;
      vc.font  = { name:"Calibri", size:11, color:{ argb:"FF1E293B" } };
      cover.mergeCells(`C${rowNum}:D${rowNum}`);
    });

    // Overview text row (below stats, only if provided)
    if (overviewText) {
      const ovRow = 16 + stats.length * 2 + 1;
      cover.getRow(ovRow - 1).height = 10;
      const ovCell = cover.getCell(`B${ovRow}`);
      cover.getRow(ovRow).height = 50;
      ovCell.value = overviewText;
      ovCell.font  = { name:"Calibri", size:10, italic:true, color:{ argb:"FF475569" } };
      ovCell.alignment = { wrapText:true, vertical:"top" };
      cover.mergeCells(`B${ovRow}:D${ovRow}`);
    }

    // ── SHEET 2: BDCQ Questionnaire ─────────────────────────────────────────
    const ws = wb.addWorksheet("BDCQ Questionnaire", {
      views: [{ state:"frozen", ySplit:1 }]
    });

    const aiCols   = ["SAP Standard Value", "Watch Out / Constraint", "Answer", "Notes"];
    const INTERNAL = new Set(["_localizationCountry"]);

    // Use the columns array from frontend (includes custom cols the user added).
    // Fall back to row keys only if columns wasn't sent.
    const allRowKeys = rows.length ? Object.keys(rows[0]).filter(k => !aiCols.includes(k) && !INTERNAL.has(k)) : [];
    const rawBase  = columns.length > 0 ? columns : allRowKeys;
    const baseCols = rawBase.filter(k => !INTERNAL.has(k));

    // Ensure any custom columns not in row data are still included (they'll be blank)
    const hasLocale  = rows.some(r => r._localizationCountry && r._localizationCountry !== "Global");
    const sectionIdx = baseCols.indexOf("Section");
    if (hasLocale) {
      const insertAt = sectionIdx >= 0 ? sectionIdx + 1 : baseCols.length;
      baseCols.splice(insertAt, 0, "Localization Country");
    }

    // Add # row number as first column
    const outCols = ["#", ...baseCols, ...aiCols];

    // Column widths
    ws.columns = outCols.map(col => {
      const cl = col.toLowerCase();
      let width = 22;
      if (cl.includes("standard value") || cl.includes("watch out") ||
          cl.includes("question") || cl.includes("guidance")) width = 55;
      else if (cl === "answer" || cl === "notes") width = 38;
      return { header: col, key: col, width };
    });

    // Header row style
    const headerRow = ws.getRow(1);
    headerRow.height = 22;
    outCols.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col;
      cell.font  = { name:"Calibri", size:10, bold:true, color:{ argb:"FFFFFFFF" } };
      cell.fill  = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF5B21B6" } };
      cell.alignment = { vertical:"middle", wrapText:true };
      cell.border = { bottom:{ style:"thin", color:{ argb:"FF7C3AED" } } };
    });

    // Data rows
    rows.forEach((row, ri) => {
      const dataRow = ws.addRow(outCols.map((col, ci) => {
        if (col === "#")                     return ri + 1;                          // row number
        if (col === "Localization Country")  return row._localizationCountry || "Global";
        const v = row[col];
        return (v === undefined || v === null) ? "" : String(v);                     // custom cols → blank
      }));
      dataRow.height = 36;
      dataRow.eachCell({ includeEmpty:true }, cell => {
        cell.alignment = { vertical:"top", wrapText:true };
        cell.font = { name:"Calibri", size:10 };
        // Alternate row shading
        if (ri % 2 === 1) {
          cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFF5F3FF" } };
        }
      });
      // Highlight AI columns
      ["SAP Standard Value","Watch Out / Constraint"].forEach(col => {
        const ci = outCols.indexOf(col);
        if (ci >= 0) {
          const cell = dataRow.getCell(ci + 1);
          cell.font = { name:"Calibri", size:10, color:{ argb:"FF3730A3" } };
        }
      });
    });

    // ── Save ─────────────────────────────────────────────────────────────────
    const outFilename = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
    const outPath     = path.join(outDir, outFilename);
    await wb.xlsx.writeFile(outPath);

    res.json({ ok: true, filename: outFilename, rowCount: rows.length });
  } catch (e) {
    console.error("[BDCQ export]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
