import { describe, it, expect } from "vitest";
import { stem } from "../src/retrieval/stemmer.js";
import { getSynonyms } from "../src/retrieval/synonyms.js";
import { preprocessQuery } from "../src/retrieval/query-preprocessor.js";

describe("stemmer", () => {
  it("reduces inflected words to stems", () => {
    expect(stem("authentication")).toBe("authent");
    expect(stem("deploying")).toBe("deploi");
    expect(stem("optimization")).toBe("optim");
    expect(stem("databases")).toBe("databas");
    expect(stem("running")).toBe("run");
  });

  it("handles short words unchanged", () => {
    expect(stem("go")).toBe("go");
    expect(stem("a")).toBe("a");
  });
});

describe("synonyms", () => {
  it("finds synonyms for coding-domain terms", () => {
    const syns = getSynonyms(stem("k8s"));
    expect(syns).toContain(stem("kubernetes"));
    expect(syns).toContain(stem("kube"));

    const authSyns = getSynonyms(stem("auth"));
    expect(authSyns).toContain(stem("authentication"));
    expect(authSyns).toContain(stem("authn"));
  });

  it("returns empty for unknown terms", () => {
    expect(getSynonyms("xyzzy")).toEqual([]);
  });
});

describe("preprocessQuery", () => {
  it("stems and expands query terms with synonyms", () => {
    const { terms, ftsQuery } = preprocessQuery("k8s deployment");
    expect(terms.length).toBeGreaterThanOrEqual(2);

    const k8sTerm = terms.find((t) => t.original === "k8s");
    expect(k8sTerm).toBeDefined();
    expect(k8sTerm!.synonyms).toContain(stem("kubernetes"));

    expect(ftsQuery).toContain("*");
    expect(ftsQuery).toContain(" OR ");
  });

  it("finds synonyms for auth query", () => {
    const { terms } = preprocessQuery("authentication flow");
    const authTerm = terms.find((t) => t.original === "authentication");
    expect(authTerm).toBeDefined();
    expect(authTerm!.synonyms.length).toBeGreaterThan(0);
  });

  it("returns empty for empty query", () => {
    const { terms, ftsQuery } = preprocessQuery("");
    expect(terms).toEqual([]);
    expect(ftsQuery).toBe("");
  });

  it("handles CJK input without crashing", () => {
    const { terms, ftsQuery } = preprocessQuery("数据库 performance");
    expect(terms.length).toBeGreaterThan(0);
    expect(ftsQuery.length).toBeGreaterThan(0);
  });

  it("skips single-character tokens", () => {
    const { terms } = preprocessQuery("a database");
    expect(terms.find((t) => t.original === "a")).toBeUndefined();
    expect(terms.find((t) => t.original === "database")).toBeDefined();
  });
});