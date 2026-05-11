import { extname } from "node:path";
import { UiGuidelinesStore } from "./uiGuidelinesStore.js";

export interface Violation {
  rule: string;
  severity: "blocker" | "warning";
  file: string;
  line: number;
  matched: string;
  message: string;
}

export interface ValidationResult {
  violations: Violation[];
  summary: {
    blockers: number;
    warnings: number;
    filesScanned: number;
  };
}

const UI_VALIDATABLE_EXTS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".tsx",
  ".jsx",
  ".ts",
  ".js",
  ".vue",
  ".svelte",
  ".astro",
]);

const IAC_VALIDATABLE_EXTS = new Set([".bicep", ".bicepparam", ".tf"]);

const INFRA_RULE_SLUG = "bufab-infrastructure-context-overlay";

const WEB_FONT_NAMES = [
  "Inter",
  "Roboto",
  "Poppins",
  "Montserrat",
  "Open Sans",
  "Lato",
  "Nunito",
  "Source Sans",
  "Source Sans Pro",
  "Raleway",
  "Ubuntu",
  "Work Sans",
  "Manrope",
  "DM Sans",
  "Plus Jakarta",
  "Geist",
];

export class Validator {
  private tokenHexSet: Set<string> | null = null;

  constructor(private uiStore: UiGuidelinesStore) {}

  private async getTokenHexSet(): Promise<Set<string>> {
    if (this.tokenHexSet) return this.tokenHexSet;

    const guidelines = await this.uiStore.exportMergedGuidelines();
    const set = new Set<string>();

    const visit = (val: any, key?: string) => {
      if (key === "forbiddenColors") return;
      if (typeof val === "string") {
        const matches = val.match(/#[0-9a-fA-F]{3,8}\b/g);
        if (matches) for (const m of matches) set.add(m.toLowerCase());
      } else if (Array.isArray(val)) {
        for (const v of val) visit(v);
      } else if (val && typeof val === "object") {
        for (const [k, v] of Object.entries(val)) visit(v, k);
      }
    };

    visit(guidelines);

    // Accept short and long forms of black/white interchangeably.
    const whiteLong = "#" + "ffffff";
    const whiteShort = "#" + "fff";
    const blackLong = "#" + "000000";
    const blackShort = "#" + "000";
    if (set.has(whiteLong)) set.add(whiteShort);
    if (set.has(whiteShort)) set.add(whiteLong);
    if (set.has(blackLong)) set.add(blackShort);
    if (set.has(blackShort)) set.add(blackLong);

    this.tokenHexSet = set;
    return set;
  }

  private normalizeHex(hex: string): string {
    const lower = hex.toLowerCase();
    if (lower.length === 4) {
      // #a b c -> #a a b b c c
      return `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`;
    }
    return lower;
  }

  private async isTokenHex(hex: string): Promise<boolean> {
    const norm = this.normalizeHex(hex);
    const set = await this.getTokenHexSet();
    if (set.has(norm)) return true;
    for (const t of set) {
      if (this.normalizeHex(t) === norm) return true;
    }
    return false;
  }

  private lineOf(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
      if (content[i] === "\n") line++;
    }
    return line;
  }

  public isValidatableFile(path: string): boolean {
    const ext = extname(path).toLowerCase();
    if (UI_VALIDATABLE_EXTS.has(ext)) return true;
    if (IAC_VALIDATABLE_EXTS.has(ext)) return true;
    if (path.toLowerCase().endsWith(".tf.json")) return true;
    return false;
  }

  private isUiFile(path: string): boolean {
    return UI_VALIDATABLE_EXTS.has(extname(path).toLowerCase());
  }

  private isIacFile(path: string): boolean {
    const ext = extname(path).toLowerCase();
    if (IAC_VALIDATABLE_EXTS.has(ext)) return true;
    if (path.toLowerCase().endsWith(".tf.json")) return true;
    return false;
  }

  public async validateContent(content: string, file: string): Promise<Violation[]> {
    const violations: Violation[] = [];
    if (this.isUiFile(file)) {
      this.detectGradients(content, file, violations);
      this.detectWebFonts(content, file, violations);
      this.detectBorderRadius(content, file, violations);
      this.detectHeaderScrollListener(content, file, violations);
      this.detectAccentColorMisuse(content, file, violations);
      await this.detectOffPaletteHex(content, file, violations);
      this.detectFontFamilyShape(content, file, violations);
    }
    if (this.isIacFile(file)) {
      this.detectInfraRequiredTags(content, file, violations);
      this.detectInfraNaming(content, file, violations);
      this.detectHardcodedSecrets(content, file, violations);
    }
    return violations;
  }

  private detectGradients(content: string, file: string, out: Violation[]) {
    // AP-03 (No Gradients) is retired in v2.0.1.
    // The Glassmorphism theme requires the dark teal gradient.
  }

  private detectWebFonts(content: string, file: string, out: Violation[]) {
    // AP-05 (No Web Fonts) is retired in v2.0.1.
    // The Glassmorphism theme uses 'Roboto', 'Roboto Condensed', and 'Roboto Mono'.
  }

  private detectBorderRadius(content: string, file: string, out: Violation[]) {
    const cssRe = /border-radius\s*:\s*([^;]+);/gi;
    for (const m of content.matchAll(cssRe)) {
      const value = m[1];
      const pxMatch = value.match(/(\d+(?:\.\d+)?)\s*px/);
      if (pxMatch) {
        const px = Number(pxMatch[1]);
        if (px > 24) {
          out.push({
            rule: "AP-06",
            severity: "blocker",
            file,
            line: this.lineOf(content, m.index!),
            matched: `border-radius: ${value.trim()}`,
            message: `border-radius ${px}px exceeds the 24px maximum (AP-06).`,
          });
        }
      }
      const remMatch = value.match(/(\d+(?:\.\d+)?)\s*rem/);
      if (remMatch && Number(remMatch[1]) > 1.5) {
        out.push({
          rule: "AP-06",
          severity: "blocker",
          file,
          line: this.lineOf(content, m.index!),
          matched: `border-radius: ${value.trim()}`,
          message: `border-radius ${remMatch[1]}rem exceeds the 24px (~1.5rem) maximum (AP-06).`,
        });
      }
    }
    const twRe = /\brounded(?:-(?:t|r|b|l|tl|tr|bl|br))?-(full)\b/g;
    for (const m of content.matchAll(twRe)) {
      out.push({
        rule: "AP-06",
        severity: "blocker",
        file,
        line: this.lineOf(content, m.index!),
        matched: m[0],
        message: `Tailwind class '${m[0]}' implies border-radius > 24px (AP-06). Use 'rounded-xl' (24px) or smaller.`,
      });
    }
    const twArbRe = /\brounded(?:-(?:t|r|b|l|tl|tr|bl|br))?-\[(\d+(?:\.\d+)?)px\]/g;
    for (const m of content.matchAll(twArbRe)) {
      const px = Number(m[1]);
      if (px > 24) {
        out.push({
          rule: "AP-06",
          severity: "blocker",
          file,
          line: this.lineOf(content, m.index!),
          matched: m[0],
          message: `Tailwind '${m[0]}' = ${px}px exceeds the 24px maximum (AP-06).`,
        });
      }
    }
  }

  private detectHeaderScrollListener(content: string, file: string, out: Violation[]) {
    const heuristics = [
      new RegExp("\\." + "scrolled\\b", "g"),
      /\bisScrolled\b/g,
      /\bsetScrolled\b/g,
      /\bsetIsScrolled\b/g,
      /addEventListener\s*\(\s*['"`]scroll['"`]/g,
      /window\.onscroll\s*=/g,
    ];
    for (const re of heuristics) {
      for (const m of content.matchAll(re)) {
        const window = content.slice(Math.max(0, m.index! - 400), m.index! + 400);
        if (/\bheader\b/i.test(window) || /<Header\b/.test(window)) {
          out.push({
            rule: "AP-07/08",
            severity: "blocker",
            file,
            line: this.lineOf(content, m.index!),
            matched: m[0],
            message:
              "Header must not change appearance on scroll (AP-07/08). Remove scroll listeners and conditional classes; the header stays transparent glass always.",
          });
          break;
        }
      }
    }
  }

  private detectAccentColorMisuse(content: string, file: string, out: Violation[]) {
    // AP-04 (Accent Color Misuse) is retired in v2.0.1.
    // The Glassmorphism theme uses #4ecdc4 (Cyan) and #a8d8e8 (Sky Blue).
  }

  private async detectOffPaletteHex(content: string, file: string, out: Violation[]) {
    const re = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g;
    const seen = new Set();
    for (const m of content.matchAll(re)) {
      if (await this.isTokenHex(m[0])) continue;
      const key = `${m[0].toLowerCase()}@${this.lineOf(content, m.index!)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        rule: "COLOR-03",
        severity: "blocker",
        file,
        line: this.lineOf(content, m.index!),
        matched: m[0],
        message: `Color ${m[0]} is not in the Bufab token set (COLOR-03). Replace with a token from the live bufab-mcp UI export (e.g. #1f3c46, #4ecdc4, #325c6d, #a8d8e8, #FFFFFF).`,
      });
    }
  }

  private detectFontFamilyShape(content: string, file: string, out: Violation[]) {
    const re = /font-family\s*:\s*([^;{}]+)[;}\n]/gi;
    for (const m of content.matchAll(re)) {
      const value = m[1].toLowerCase();
      const looksApproved =
        value.includes("roboto") ||
        value.includes("arial") ||
        value.includes("sans-serif") ||
        value.includes("system-ui") ||
        value.includes("inherit") ||
        value.includes("var(") ||
        value.includes("initial") ||
        value.includes("unset");
      if (!looksApproved) {
        out.push({
          rule: "TYPE-01",
          severity: "warning",
          file,
          line: this.lineOf(content, m.index!),
          matched: m[0].trim(),
          message:
            "font-family does not include the approved stack (TYPE-01). Use: 'Roboto', 'Roboto Condensed', 'Roboto Mono', Arial, sans-serif.",
        });
      }
    }
  }

  private detectInfraRequiredTags(content: string, file: string, out: Violation[]) {
    if (!this.isIacFile(file)) return;
    if (file.toLowerCase().endsWith(".bicepparam")) return;
    const declaresBicepResource = /^\s*resource\s+\S+\s+'/m.test(content);
    const declaresTerraformResource = /^\s*resource\s+"[^"]+"\s+"/m.test(content);
    if (!declaresBicepResource && !declaresTerraformResource) return;

    const required = ["Owner", "CostCenter", "ProjectID"];
    const missing = required.filter((k) => !new RegExp(`\\b${k}\\b`).test(content));
    if (missing.length === 0) return;

    out.push({
      rule: "INFRA-01",
      severity: "blocker",
      file,
      line: 1,
      matched: "(file scan)",
      message:
        `Missing required Bufab tags: ${missing.join(", ")}. ` +
        `Every Azure resource must be tagged with Owner, CostCenter, and ProjectID. ` +
        `See rules_get(slug=${INFRA_RULE_SLUG}) for the full overlay.`,
    });
  }

  private detectInfraNaming(content: string, file: string, out: Violation[]) {
    if (!this.isIacFile(file)) return;

    if (file.toLowerCase().endsWith(".bicep") || file.toLowerCase().endsWith(".bicepparam")) {
      const re = /^[ \t]*name\s*:\s*'([^'$\n]+)'/gm;
      for (const m of content.matchAll(re)) {
        const value = m[1];
        if (!value.startsWith("bufab-")) {
          out.push({
            rule: "INFRA-02",
            severity: "warning",
            file,
            line: this.lineOf(content, m.index!),
            matched: m[0].trim(),
            message:
              `Resource name '${value}' should follow bufab-<env>-<region>-<app>-<resource>. ` +
              `See rules_get(slug=${INFRA_RULE_SLUG}).`,
          });
        }
      }
    }

    if (file.toLowerCase().endsWith(".tf") || file.toLowerCase().endsWith(".tf.json")) {
      const re = /^[ \t]*name\s*=\s*"([^"$\n]+)"/gm;
      for (const m of content.matchAll(re)) {
        const value = m[1];
        if (!value.startsWith("bufab-")) {
          out.push({
            rule: "INFRA-02",
            severity: "warning",
            file,
            line: this.lineOf(content, m.index!),
            matched: m[0].trim(),
            message:
              `Resource name '${value}' should follow bufab-<env>-<region>-<app>-<resource>. ` +
              `See rules_get(slug=${INFRA_RULE_SLUG}).`,
          });
        }
      }
    }
  }

  private detectHardcodedSecrets(content: string, file: string, out: Violation[]) {
    if (!this.isIacFile(file)) return;

    const patterns = [
      {
        re: /AccountKey=[A-Za-z0-9+/=]{20,}/g,
        label: "storage AccountKey",
        remediation: "use Key Vault references or Managed Identity",
      },
      {
        re: /SharedAccessSignature=[^"'\s]{20,}/g,
        label: "Shared Access Signature",
        remediation: "use Managed Identity",
      },
      {
        re: /\bsv=\d{4}-\d{2}-\d{2}&[^"'\s]*sig=/g,
        label: "SAS token",
        remediation: "use Managed Identity",
      },
      {
        re: /\w*(?:password|pwd|secret)\w*\s*[:=]\s*(['"])[^'"\n]{6,}\1/gi,
        label: "credential",
        remediation: "load from Key Vault or env, never as a literal",
      },
    ];

    for (const p of patterns) {
      for (const m of content.matchAll(p.re)) {
        out.push({
          rule: "INFRA-03",
          severity: "blocker",
          file,
          line: this.lineOf(content, m.index!),
          matched: m[0].slice(0, 40) + (m[0].length > 40 ? "..." : ""),
          message:
            `Hardcoded ${p.label} in IaC file — ${p.remediation}. ` +
            `See rules_get(slug=${INFRA_RULE_SLUG}).`,
        });
      }
    }
  }
}
