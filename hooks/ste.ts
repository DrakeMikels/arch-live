// ASD-STE100-style distiller, ported from the STE Whiteboard (arch-live-test).
// Applied as a guideline (target ~75–80% compliance), not a strict checker:
// rewrites the common violations it can fix safely, flags the rest, and never
// mangles technical names (inline code, paths, URLs).

export type SteKind = 'step' | 'desc' | 'caution'
export const LIMITS: Record<SteKind, number> = { step: 20, desc: 25, caution: 25 };
export const TARGET = { min: 75, max: 80 };

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/gi, 'cannot'], [/\bwon't\b/gi, 'will not'], [/\bshan't\b/gi, 'shall not'],
  [/\b(\w+)n't\b/gi, '$1 not'],
  [/\bI'm\b/g, 'I am'], [/\blet's\b/gi, 'let us'],
  [/\b(it|that|there|here|what|this|he|she|who)'s\b/gi, '$1 is'],
  [/\b(\w+)'ll\b/gi, '$1 will'], [/\b(\w+)'ve\b/gi, '$1 have'],
  [/\b(\w+)'re\b/gi, '$1 are'], [/\b(I|you|we|they)'d\b/gi, '$1 would'],
];

const PHRASES: [RegExp, string][] = [
  [/\bin order to\b/gi, 'to'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bin the event that\b/gi, 'if'],
  [/\bat this point(?: in time)?\b/gi, 'now'],
  [/\bas well as\b/gi, 'and'],
  [/\ba number of\b/gi, 'some'],
  [/\ba lot of\b/gi, 'many'],
  [/\blots of\b/gi, 'many'],
  [/\bwill be able to\b/gi, 'can'],
  [/\b(?:is|are) able to\b/gi, 'can'],
  [/\b(?:take|have) a look at\b/gi, 'examine'],
  [/\blook into\b/gi, 'examine'],
  [/\bfigure out\b/gi, 'find'],
  [/\bmake use of\b/gi, 'use'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bin addition,?\b/gi, 'also'],
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/,?\s*etc\.?/gi, ' and more'],
  [/\bkind of\b|\bsort of\b/gi, ''],
  [/\bof course,?\s*/gi, ''],
  [/\bI (?:think|believe|guess|feel)(?: that)?,?\s*/gi, ''],
];

// "source forms => target forms" (base, 3rd person, past, -ing).
// A single target applies to every source form.
const WORDS = `
utilize utilizes utilized utilizing => use uses used using
utilise utilises utilised utilising => use uses used using
leverage leverages leveraged leveraging => use uses used using
implement implements implemented implementing => add adds added adding
modify modifies modified modifying => change changes changed changing
alter alters altered altering => change changes changed changing
ensure ensures ensured ensuring => make sure|makes sure|made sure|making sure
verify verifies verified verifying => make sure|makes sure|made sure|making sure
attempt attempts attempted attempting => try tries tried trying
commence commences commenced commencing => start starts started starting
initiate initiates initiated initiating => start starts started starting
terminate terminates terminated terminating => stop stops stopped stopping
obtain obtains obtained obtaining => get gets got getting
retrieve retrieves retrieved retrieving => get gets got getting
assist assists assisted assisting => help helps helped helping
facilitate facilitates facilitated facilitating => help helps helped helping
indicate indicates indicated indicating => show shows showed showing
demonstrate demonstrates demonstrated demonstrating => show shows showed showing
display displays displayed displaying => show shows showed showing
perform performs performed performing => do does did doing
provide provides provided providing => supply supplies supplied supplying
require requires required requiring => need needs needed needing
allow allows allowed allowing => let lets let letting
additional => more
additionally => also
approximately => about
numerous => many
currently => now
subsequently => then
initially => first
regarding => about
whilst => while
upon => on
amongst => among
purchase => buy
`;

const FILLERS = /\b(just|really|actually|basically|simply|quite|very|essentially|literally|definitely|obviously|totally|honestly)\b\s*/gi;
const INTERJECTION = /^(great|perfect|okay|ok|sure|alright|nice|excellent|awesome|done|got it|good)\b[!,.:—-]*\s*/i;
const CONNECTOR = /^(so|now|next|okay|ok|alright|well),?\s+/i;
const HEDGES = /\b(maybe|perhaps|probably|seems?|seemingly|somewhat|possibly|likely)\b/i;
const PASSIVE = /\b(is|are|was|were|be|been|being|gets|got)\s+(?:\w+ly\s+)?(\w+ed|built|done|made|shown|written|given|taken|seen|known|sent|kept|found|held|run|read|set|put)\b(?!\s+(?:to|on|up)\b)/i;
const PROGRESSIVE = /\b(am|is|are|was|were|be|been)\s+\w{2,}ing\b/i;
const LEADING_ING = /^[A-Z]\w{2,}ing\b(?!\s+(?:is|are|was|were)\b)/;
const CAUTION = /\b(warning|caution|careful|risk|danger|do not|never|must not|cannot|fails?|failed|error|breaks?|broken|unsafe)\b/i;
const IMPERATIVE_VERB = /^(use|run|add|build|make|show|keep|track|create|check|open|set|map|remove|delete|fix|start|stop|install|write|read|put|give|test|deploy|move|change|update|do|go|see|select|click|type|push|pull|commit|restart|refresh|send|edit|examine|find|try|apply|replace|connect)\b/i;
const SIGN_OFF = /^(let me know|know if|want me to|would you like|do you want|shall i|should i|happy to|feel free|if you (?:want|would like|need))\b/i;
const LEAD_IN = /^(here(?: is| are)?|below|the following|this is what|summary)\b[^.]*:$/i;

const WORD_MAP = buildWordMap(WORDS);

function buildWordMap(table: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of table.trim().split('\n')) {
    const [src = '', tgt = ''] = line.split('=>').map((s) => s.trim());
    const srcForms = src.split(/\s+/);
    const tgtForms = tgt.includes('|') ? tgt.split('|') : tgt.split(/\s+/);
    srcForms.forEach((form, i) => map.set(form, tgtForms[Math.min(i, tgtForms.length - 1)] ?? ''));
  }
  return map;
}

const WORD_RE = new RegExp(`\\b(${[...WORD_MAP.keys()].join('|')})\\b`, 'gi');

function matchCase(source: string, replacement: string | undefined): string {
  if (!replacement) return replacement ?? '';
  return /^[A-Z]/.test(source) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

function capitalize(s: string): string {
  const i = s.search(/[A-Za-z\uE000]/);
  if (i < 0 || s.charAt(i) === '\uE000') return s;
  return s.slice(0, i) + s.charAt(i).toUpperCase() + s.slice(i + 1);
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[\w\uE000]/.test(w)).length;
}

// --- markdown -> blocks --------------------------------------------------

type Block = { kind: SteKind; text: string; list?: boolean }

function toBlocks(raw: string): { blocks: Block[]; code: string[] } {
  const text = String(raw || '')
    .replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\r/g, '');
  const blocks: Block[] = [];
  const code: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'desc', text: para.join(' ') });
    para = [];
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.startsWith('```')) {
      flush();
      const body = [];
      for (i++; i < lines.length && !(lines[i] ?? '').trim().startsWith('```'); i++) body.push(lines[i] ?? '');
      if (body.length) code.push(body.slice(0, 4).join('\n'));
      continue;
    }
    if (!line || /^(#{1,6}\s|\||-{3,}$|>\s*$)/.test(line)) { flush(); continue; }
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    const step = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || step) {
      flush();
      blocks.push({ kind: step ? 'step' : 'desc', text: (bullet || step)?.[1] ?? '', list: true });
      continue;
    }
    para.push(line.replace(/^>\s*/, ''));
  }
  flush();
  return { blocks, code };
}

// --- protection of technical names --------------------------------------

function protect(text: string): { text: string; saved: string[] } {
  const saved: string[] = [];
  const keep = (m: string) => `\uE000${saved.push(m) - 1}\uE001`;
  const out = text
    .replace(/`[^`]+`/g, keep)
    .replace(/https?:\/\/\S+[^\s.,)]/g, keep)
    .replace(/(?:~|\.{1,2})?\/?\b[\w@-]+(?:[./][\w@-]+)+\b\/?/g, (m: string) => (/[/.]/.test(m) && !/^\d+\.\d*$/.test(m) ? keep(m) : m));
  return { text: out, saved };
}

function restore(text: string, saved: string[]): string {
  return text.replace(/\uE000(\d+)\uE001/g, (_, i: string) => {
    const s = saved[Number(i)] ?? '';
    return s.startsWith('`') ? s : '`' + s + '`';
  });
}

// --- rewriting -----------------------------------------------------------

type Stats = { replaced: number; dropped: number }

function rewriteWords(text: string, stats: Stats): string {
  let s = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=[\s).,:;!?]|$)/g, '$1$2');
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  for (const [re, to] of PHRASES) s = s.replace(re, (m: string) => { stats.replaced++; return matchCase(m, to); });
  s = s.replace(WORD_RE, (m: string) => { stats.replaced++; return matchCase(m, WORD_MAP.get(m.toLowerCase())); });
  s = s.replace(FILLERS, () => { stats.replaced++; return ''; });
  // STE avoids dashes as sentence glue: a short label becomes "Label: text",
  // a longer aside becomes its own sentence.
  s = s.replace(/^([^.:]{1,40}?)\s+(?:[—–]|-{1,2})\s+/, (m: string, label: string) => (wordCount(label) <= 4 ? `${label}: ` : m));
  s = s.replace(/\s+(?:[—–]|-{1,2})\s+(\S)/g, (_, c: string) => '. ' + c.toUpperCase());
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<!\b(?:vs|approx|no|fig|mr|dr|ca)\.)(?<=[.!?])\s+(?=[A-Za-z\uE000"(\d])|;\s+/i)
    .map((s) => capitalize(s.trim()))
    .filter(Boolean);
}

export type SteMode = 'response' | 'request' | 'note' | 'log'

function rewriteSubject(sentence: string, mode: SteMode): { text: string; kind: SteKind | null } {
  let s = sentence.replace(INTERJECTION, '').replace(CONNECTOR, '');
  let kind: SteKind | null = null;

  const imperative = mode === 'request'
    ? /^(?:I|we)\s+(?:want|would like|need)\s+(?:you\s+)?to\s+|^(?:can|could|would)\s+you\s+(?:please\s+)?|^please\s+/i
    : /^(?:(?:first|next|then|now),?\s+)?(?:I will|I am going to|let me|let us|I need to|I want to)\s+/i;
  if (imperative.test(s)) {
    s = s.replace(imperative, '').replace(/\?$/, '.');
    kind = 'step';
  }

  if (mode === 'log') {
    s = s
      .replace(/^(?:I|We)\s+(?:have\s+|also\s+|then\s+)*(?=\w)/i, '')
      .replace(/^Claude\s+(?:has\s+)?(?=\w)/, '')
      .replace(/\bI\b/g, 'Claude')
      .replace(/\bmy\b/g, 'the');
  }
  if (mode === 'response') {
    s = s
      .replace(/\bI am\b/g, 'Claude is')
      .replace(/\bI have\b/g, 'Claude has')
      .replace(/\bI was\b/g, 'Claude was')
      .replace(/\bI\b/g, 'Claude')
      .replace(/\bmy\b/g, 'the')
      .replace(/\bme\b/g, 'Claude')
      .replace(/\bClaude (do|need|want|think|see|use|run|add|make|keep|get|set)\b/g, 'Claude $1s');
  }
  return { text: capitalize(s.trim()), kind };
}

function splitLong(sentence: string, limit: number): string[] {
  if (wordCount(sentence) <= limit) return [sentence];
  const cuts = [/,\s+which\s+/i, /,\s+(?:and|but|so)\s+/i, /\s+because\s+/i, /,\s+while\s+/i, /:\s+/];
  for (const re of cuts) {
    const m = sentence.match(re);
    if (!m) continue;
    const at = m.index ?? 0;
    const left = sentence.slice(0, at).trim();
    let right = sentence.slice(at + m[0].length).trim();
    if (wordCount(left) < 4 || wordCount(right) < 4) continue;
    if (/which/i.test(m[0])) right = 'This ' + right;
    else if (/because/i.test(m[0])) right = 'The reason: ' + right;
    return [...splitLong(left.replace(/[.,;:]$/, '') + '.', limit), ...splitLong(capitalize(right), limit)];
  }
  return [sentence];
}

function finish(s: string): string {
  let out = s.replace(/[,;:\s]+$/, '');
  if (!/[.!?]$/.test(out)) out += '.';
  return capitalize(out);
}

function check(text: string, kind: SteKind): { checks: Record<string, boolean>; score: number } {
  const plain = text.replace(/`[^`]*`/g, 'X');
  const checks = {
    length: wordCount(plain) <= LIMITS[kind],
    active: !PASSIVE.test(plain),
    simpleVerb: !PROGRESSIVE.test(plain) && !LEADING_ING.test(plain),
    clear: !HEDGES.test(plain),
  };
  const vals = Object.values(checks);
  return { checks, score: Math.round((vals.filter(Boolean).length / vals.length) * 100) };
}

export type SteStatement = { text: string; kind: SteKind; checks: Record<string, boolean>; score: number }
export type SteResult = { statements: SteStatement[]; more: number; code: string[]; score: number | null; stats: Stats }

/** Distill free text into STE-style statements. */
export function distill(raw: string, opts: { mode?: SteMode; max?: number } = {}): SteResult {
  const mode = opts.mode || 'response';
  const max = opts.max || 8;
  const stats = { replaced: 0, dropped: 0 };
  const { blocks, code } = toBlocks(raw);
  const statements: SteStatement[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const { text, saved } = protect(block.text);
    const rewritten = rewriteWords(text, stats);
    for (const sentence of splitSentences(rewritten)) {
      if (LEAD_IN.test(sentence) || wordCount(sentence) < 2) { stats.dropped++; continue; }
      if (mode === 'log' && (SIGN_OFF.test(sentence) || /\?$/.test(sentence))) { stats.dropped++; continue; }
      const subj = rewriteSubject(sentence, mode);
      if (!subj.text || wordCount(subj.text) < 2) { stats.dropped++; continue; }
      let kind: SteKind = subj.kind || (IMPERATIVE_VERB.test(subj.text) ? 'step' : block.kind);
      if (CAUTION.test(subj.text)) kind = 'caution';
      for (const part of splitLong(subj.text, LIMITS[kind])) {
        const final = restore(finish(part), saved);
        const key = final.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        statements.push({ text: final, kind, ...check(final, kind) });
      }
    }
  }

  const kept = statements.slice(0, max);
  return {
    statements: kept,
    more: Math.max(0, statements.length - kept.length),
    code,
    score: kept.length ? Math.round(kept.reduce((a, s) => a + s.score, 0) / kept.length) : null,
    stats,
  };
}

