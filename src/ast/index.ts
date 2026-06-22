import type { ASTAnchor } from "../types.js";
import { languageForExtension } from "./languages.js";

let ParserModule: unknown;

async function loadParser(): Promise<unknown> {
  if (ParserModule) return ParserModule;
  const mod = await import("tree-sitter");
  ParserModule = (mod as Record<string, unknown>).default ?? mod;
  return ParserModule;
}

const languageCache = new Map<string, unknown>();

async function loadLanguage(langName: string): Promise<unknown> {
  if (languageCache.has(langName)) return languageCache.get(langName);
  const config = languageForExtension(`.${langName}`) ?? languageForExtension(`.${langName}x`);
  if (!config) throw new Error(`No language config for: ${langName}`);
  const lang = await config.moduleLoader();
  languageCache.set(langName, lang);
  return lang;
}

function extToLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return undefined;
  const ext = filePath.slice(dotIndex);
  const config = languageForExtension(ext);
  return config?.name;
}

export async function extractAnchors(filePath: string, sourceCode: string): Promise<ASTAnchor[]> {
  const language = extToLanguage(filePath);
  if (!language) return [];

  try {
    const ParserCls = (await loadParser()) as any;
    const lang = await loadLanguage(language);
    const parser = new ParserCls();
    parser.setLanguage(lang);

    const tree = parser.parse(sourceCode);
    const config = languageForExtension(`.${language}`) ?? languageForExtension(`.${language}x`);
    if (!config) return [];

    const tsMod = await import("tree-sitter");
    const QueryClass = (tsMod as Record<string, unknown>).Query ?? (tsMod as Record<string, unknown>).default;
    const query = new (QueryClass as any)(lang, config.symbolQuery);

    const matches = query.matches(tree.rootNode) as Array<{
      captures: Array<{
        name: string;
        node: {
          text: string;
          startPosition: { row: number };
          endPosition: { row: number };
          type: string;
        };
      }>;
    }>;

    const anchors: ASTAnchor[] = [];
    for (const match of matches) {
      const nameCapture = match.captures.find((c) => c.name === "name");
      const defCapture = match.captures.find((c) => c.name === "def");
      if (nameCapture && defCapture) {
        anchors.push({
          kind: defCapture.node.type,
          name: nameCapture.node.text,
          startLine: defCapture.node.startPosition.row,
          endLine: defCapture.node.endPosition.row,
          language,
        });
      }
    }
    return anchors;
  } catch {
    return [];
  }
}

export function supportsLanguage(filePath: string): boolean {
  return extToLanguage(filePath) !== undefined;
}
