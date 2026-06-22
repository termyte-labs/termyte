import type Database from "better-sqlite3";
import type { Memory, MemoryType } from "../types.js";
import { generateId, nowISO } from "../utils.js";
import { MemoryStore, type InsertMemoryInput } from "./schema.js";

export interface MemoryEngine {
  store: MemoryStore;
  createMemory(input: Omit<InsertMemoryInput, "id" | "createdAt" | "updatedAt">): Memory;
  getMemory(id: string): Memory | null;
  listMemories(options?: { type?: MemoryType; scope?: string; limit?: number }): Memory[];
  recordSuccess(id: string): void;
  recordFailure(id: string): void;
  deactivateMemory(id: string): void;
  countMemories(options?: { type?: MemoryType; scope?: string }): number;
}

export function createMemoryEngine(db: Database.Database): MemoryEngine {
  const store = new MemoryStore(db);

  function createMemory(input: Omit<InsertMemoryInput, "id" | "createdAt" | "updatedAt">): Memory {
    const now = nowISO();
    return store.insert({
      ...input,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    });
  }

  function getMemory(id: string): Memory | null {
    return store.getById(id);
  }

  function listMemories(options: { type?: MemoryType; scope?: string; limit?: number } = {}): Memory[] {
    return store.list({ ...options, activeOnly: true });
  }

  function recordSuccess(id: string): void {
    store.recordSuccess(id);
  }

  function recordFailure(id: string): void {
    store.recordFailure(id);
  }

  function deactivateMemory(id: string): void {
    store.deactivate(id);
  }

  function countMemories(options: { type?: MemoryType; scope?: string } = {}): number {
    return store.count(options);
  }

  return { store, createMemory, getMemory, listMemories, recordSuccess, recordFailure, deactivateMemory, countMemories };
}
