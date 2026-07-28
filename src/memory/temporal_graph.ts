/**
 * memory/temporal_graph.ts — Temporal Memory Graph with Voiding Semantics (Production Grade)
 *
 * Stores facts as typed triples (subject, predicate, object) with turn indices and status
 * ('current' vs 'superseded'). When a new fact is asserted for an existing (subject, predicate),
 * prior triples are voided to prevent hallucination-via-stale-belief.
 *
 * Features natural language triple extraction, predicate synonym normalization, and disk persistence.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export interface TemporalFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  assertedTurn: number;
  supersededTurn?: number;
  status: 'current' | 'superseded';
}

export interface CandidateSignal {
  id: string;
  claim: string;
  firstSeenTurn: number;
  lastSeenTurn: number;
  sightings: number;
  promotionState: 'candidate' | 'promoted';
  freshnessState: 'fresh' | 'stale' | 'expired';
}

export class TemporalMemoryGraph {
  private facts: Map<string, TemporalFact> = new Map();
  private signals: Map<string, CandidateSignal> = new Map();

  private predicateSynonyms: Record<string, string> = {
    'lives in': 'location',
    'resides in': 'location',
    'located in': 'location',
    'moved to': 'location',
    'city is': 'location',
    'works at': 'organization',
    'employed by': 'organization',
    'joined company': 'organization',
    'uses model': 'preferred_model',
    'prefers model': 'preferred_model',
  };

  /**
   * Normalize predicate using synonym dictionary
   */
  normalizePredicate(predicate: string): string {
    const key = predicate.toLowerCase().trim();
    return this.predicateSynonyms[key] || key;
  }

  /**
   * Asserts a fact triple. Void (supersede) prior triples sharing subject and normalized predicate.
   */
  assertFact(subject: string, rawPredicate: string, object: string, currentTurn: number): TemporalFact {
    const predicate = this.normalizePredicate(rawPredicate);
    const subKey = subject.toLowerCase().trim();

    // Void prior facts matching (subject, normalized predicate)
    for (const fact of this.facts.values()) {
      if (
        fact.subject.toLowerCase().trim() === subKey &&
        this.normalizePredicate(fact.predicate) === predicate &&
        fact.status === 'current'
      ) {
        fact.status = 'superseded';
        fact.supersededTurn = currentTurn;
      }
    }

    const newFact: TemporalFact = {
      id: 'fact_' + crypto.randomUUID().slice(0, 8),
      subject: subKey,
      predicate,
      object: object.trim(),
      assertedTurn: currentTurn,
      status: 'current',
    };

    this.facts.set(newFact.id, newFact);
    return newFact;
  }

  /**
   * Extracts triples from natural language text using rule-based pattern matching.
   */
  extractTriplesFromText(text: string, currentTurn: number): TemporalFact[] {
    const extracted: TemporalFact[] = [];
    
    // Pattern 1: "I moved to [City]" / "I live in [City]"
    const locMatch = text.match(/\b(?:I\s+have\s+)?(?:moved\s+to|live\s+in|reside\s+in)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/);
    if (locMatch) {
      extracted.push(this.assertFact('user', 'location', locMatch[1], currentTurn));
    }

    // Pattern 2: "I work at [Company]" / "I joined [Company]"
    const orgMatch = text.match(/\b(?:I\s+work\s+at|I\s+am\s+employed\s+by|joined)\s+([A-Z][a-zA-Z0-9]+)\b/i);
    if (orgMatch) {
      extracted.push(this.assertFact('user', 'organization', orgMatch[1], currentTurn));
    }

    // Pattern 3: "Use model [Model]"
    const modelMatch = text.match(/\b(?:use|prefer|set)\s+model\s+([a-zA-Z0-9.\-_/]+)\b/i);
    if (modelMatch) {
      extracted.push(this.assertFact('user', 'preferred_model', modelMatch[1], currentTurn));
    }

    return extracted;
  }

  /**
   * Manually void a temporal fact
   */
  voidFact(factId: string, currentTurn: number): boolean {
    const fact = this.facts.get(factId);
    if (!fact || fact.status === 'superseded') return false;
    fact.status = 'superseded';
    fact.supersededTurn = currentTurn;
    return true;
  }

  /**
   * Returns active facts (status === 'current')
   */
  getCurrentFacts(): TemporalFact[] {
    return Array.from(this.facts.values()).filter(f => f.status === 'current');
  }

  /**
   * Register or update a candidate signal sighting
   */
  recordSignal(claim: string, currentTurn: number, sightingsThreshold: number = 3): CandidateSignal {
    const key = claim.toLowerCase().trim();
    let signal = Array.from(this.signals.values()).find(s => s.claim.toLowerCase().trim() === key);

    if (signal) {
      signal.sightings += 1;
      signal.lastSeenTurn = currentTurn;
      if (signal.sightings >= sightingsThreshold && signal.promotionState === 'candidate') {
        signal.promotionState = 'promoted';
      }
      signal.freshnessState = 'fresh';
    } else {
      signal = {
        id: 'sig_' + crypto.randomUUID().slice(0, 8),
        claim,
        firstSeenTurn: currentTurn,
        lastSeenTurn: currentTurn,
        sightings: 1,
        promotionState: 'candidate',
        freshnessState: 'fresh',
      };
      this.signals.set(signal.id, signal);
    }

    return signal;
  }

  /**
   * Refresh signal freshness state based on turn age and prune expired
   */
  updateFreshnessAndPrune(currentTurn: number, staleTurnDelta: number = 5, expireTurnDelta: number = 10): void {
    for (const [id, sig] of Array.from(this.signals.entries())) {
      const age = currentTurn - sig.lastSeenTurn;
      if (age >= expireTurnDelta) {
        sig.freshnessState = 'expired';
        this.signals.delete(id);
      } else if (age >= staleTurnDelta) {
        sig.freshnessState = 'stale';
      }
    }
  }

  /**
   * Get active candidate signals (not expired)
   */
  getActiveSignals(): CandidateSignal[] {
    return Array.from(this.signals.values()).filter(s => s.freshnessState !== 'expired');
  }

  /**
   * Save memory graph to disk
   */
  saveToDisk(filepath: string): void {
    try {
      const dir = dirname(filepath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = {
        facts: Array.from(this.facts.entries()),
        signals: Array.from(this.signals.entries()),
      };
      writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
  }

  /**
   * Load memory graph from disk
   */
  loadFromDisk(filepath: string): void {
    if (!existsSync(filepath)) return;
    try {
      const raw = readFileSync(filepath, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.facts)) this.facts = new Map(data.facts);
      if (Array.isArray(data.signals)) this.signals = new Map(data.signals);
    } catch (e) {}
  }
}
