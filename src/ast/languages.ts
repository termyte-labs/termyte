export interface LanguageConfig {
  name: string;
  extensions: string[];
  moduleLoader: () => Promise<unknown>;
  symbolQuery: string;
}

const languageConfigs: LanguageConfig[] = [
  {
    name: "typescript",
    extensions: [".ts", ".tsx"],
    moduleLoader: async () => {
      const mod = await import("tree-sitter-typescript");
      return (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).typescript ?? mod;
    },
    symbolQuery: `
      (function_declaration name: (identifier) @name) @def
      (class_declaration name: (type_identifier) @name) @def
      (method_definition name: (property_identifier) @name) @def
      (interface_declaration name: (type_identifier) @name) @def
      (type_alias_declaration name: (type_identifier) @name) @def
      (enum_declaration name: (identifier) @name) @def
      (lexical_declaration (variable_declarator name: (identifier) value: (arrow_function))) @def
    `,
  },
  {
    name: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    moduleLoader: async () => {
      const mod = await import("tree-sitter-javascript");
      return (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).javascript ?? mod;
    },
    symbolQuery: `
      (function_declaration name: (identifier) @name) @def
      (class_declaration name: (identifier) @name) @def
      (method_definition name: (property_identifier) @name) @def
      (lexical_declaration (variable_declarator name: (identifier) value: (arrow_function))) @def
    `,
  },
  {
    name: "python",
    extensions: [".py"],
    moduleLoader: async () => {
      const mod = await import("tree-sitter-python");
      return (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).python ?? mod;
    },
    symbolQuery: `
      (function_definition name: (identifier) @name) @def
      (class_definition name: (identifier) @name) @def
    `,
  },
  {
    name: "go",
    extensions: [".go"],
    moduleLoader: async () => {
      const mod = await import("tree-sitter-go");
      return (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).go ?? mod;
    },
    symbolQuery: `
      (function_declaration name: (identifier) @name) @def
      (method_declaration name: (field_identifier) @name) @def
      (type_declaration (type_spec name: (type_identifier) @name)) @def
    `,
  },
  {
    name: "rust",
    extensions: [".rs"],
    moduleLoader: async () => {
      const mod = await import("tree-sitter-rust");
      return (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).rust ?? mod;
    },
    symbolQuery: `
      (function_item name: (identifier) @name) @def
      (struct_item name: (type_identifier) @name) @def
      (impl_item name: (type_identifier) @name) @def
      (trait_item name: (type_identifier) @name) @def
      (enum_item name: (type_identifier) @name) @def
    `,
  },
  {
    name: "java",
    extensions: [".java"],
    moduleLoader: async () => {
      const mod = await import("tree-sitter-java");
      return (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).java ?? mod;
    },
    symbolQuery: `
      (method_declaration name: (identifier) @name) @def
      (class_declaration name: (identifier) @name) @def
      (interface_declaration name: (identifier) @name) @def
    `,
  },
];

export function getLanguageConfigs(): LanguageConfig[] {
  return languageConfigs;
}

export function languageForExtension(ext: string): LanguageConfig | undefined {
  return languageConfigs.find((lang) => lang.extensions.includes(ext));
}
