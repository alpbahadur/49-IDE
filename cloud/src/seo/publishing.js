import { createHash, timingSafeEqual } from 'crypto';
import { mkdirSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import Database from 'better-sqlite3';

const MAX_BODY_BYTES = 5_000_000;
const MAX_BLOCKS = 100;
const MAX_BLOCKS_JSON_CHARS = 1_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTENT_TYPES = new Set([
  'introduction', 'paragraph', 'conclusion', 'context', 'list_paragraph',
  'numbered_list_paragraph', 'list_featured_snippet_block',
  'featured_snippet_block', 'table', 'faq', 'quote', 'checklist', 'statistic',
  'pros_and_cons', 'versus', 'timeline', 'bar_chart', 'code_cluster',
  'case_study', 'tool_recommendation', 'product_recommendations',
  'affiliate_recommendations', 'call_to_action', 'cta', 'image', 'glossary',
  'poll', 'quiz', 'interactive_calculator', 'form',
]);

const seoHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'https:', 'data:'],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
});

class PythonNumber {
  constructor(raw) {
    this.raw = raw;
    this.value = Number(raw);
  }

  valueOf() { return this.value; }
  toJSON() { return this.value; }
}

function parsePythonJson(source) {
  let at = 0;
  const whitespace = () => { while (at < source.length && /[ \t\r\n]/.test(source[at])) at++; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      const ch = source[at++];
      if (ch === '"') return JSON.parse(source.slice(start, at));
      if (ch === '\\') at++;
      else if (ch.charCodeAt(0) < 0x20) throw new SyntaxError('invalid JSON string');
    }
    throw new SyntaxError('unterminated JSON string');
  };
  const value = () => {
    whitespace();
    const ch = source[at];
    if (ch === '"') return string();
    if (ch === '{') {
      at++;
      const out = Object.create(null);
      whitespace();
      if (source[at] === '}') { at++; return out; }
      while (at < source.length) {
        whitespace();
        if (source[at] !== '"') throw new SyntaxError('object key must be a string');
        const key = string();
        whitespace();
        if (source[at++] !== ':') throw new SyntaxError('expected colon');
        out[key] = value();
        whitespace();
        if (source[at] === '}') { at++; return out; }
        if (source[at++] !== ',') throw new SyntaxError('expected comma');
      }
      throw new SyntaxError('unterminated object');
    }
    if (ch === '[') {
      at++;
      const out = [];
      whitespace();
      if (source[at] === ']') { at++; return out; }
      while (at < source.length) {
        out.push(value());
        whitespace();
        if (source[at] === ']') { at++; return out; }
        if (source[at++] !== ',') throw new SyntaxError('expected comma');
      }
      throw new SyntaxError('unterminated array');
    }
    const rest = source.slice(at);
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (rest.startsWith(literal)) { at += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) throw new SyntaxError('invalid JSON value');
    at += match[0].length;
    const number = new PythonNumber(match[0]);
    if (!Number.isFinite(number.value)) throw new SyntaxError('non-finite JSON number');
    return number;
  };

  const result = value();
  whitespace();
  if (at !== source.length) throw new SyntaxError('trailing JSON data');
  return result;
}

function toNative(value) {
  if (value instanceof PythonNumber) return value.value;
  if (Array.isArray(value)) return value.map(toNative);
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [key, child] of Object.entries(value)) out[key] = toNative(child);
    return out;
  }
  return value;
}

function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function codePointCompare(left, right) {
  const a = Array.from(left, (x) => x.codePointAt(0));
  const b = Array.from(right, (x) => x.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function pythonFloat(value) {
  if (Object.is(value, -0)) return '-0.0';
  if (value === 0) return '0.0';
  const sign = value < 0 ? '-' : '';
  let repr = Math.abs(value).toString();
  const [mantissa, exponentText] = repr.toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const dot = mantissa.indexOf('.');
  let digits = mantissa.replace('.', '');
  const leadingZeroes = digits.match(/^0*/)[0].length;
  const point = (dot === -1 ? mantissa.length : dot) + exponent - leadingZeroes;
  digits = digits.slice(leadingZeroes);
  const scientificExponent = point - 1;
  if (scientificExponent >= 16 || scientificExponent < -4) {
    const tail = digits.slice(1).replace(/0+$/, '');
    const exp = `${scientificExponent < 0 ? '-' : '+'}${String(Math.abs(scientificExponent)).padStart(2, '0')}`;
    return `${sign}${digits[0]}${tail ? `.${tail}` : ''}e${exp}`;
  }
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function canonicalNumber(number) {
  const raw = number.raw;
  if (!/[.eE]/.test(raw)) {
    try { return BigInt(raw).toString(); }
    catch { throw new TypeError('invalid integer'); }
  }
  return pythonFloat(number.value);
}

function pythonCanonical(value) {
  if (value === null) return 'null';
  if (value instanceof PythonNumber) return canonicalNumber(value);
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new TypeError('unpaired surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(pythonCanonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort(codePointCompare);
    return `{${keys.map((key) => `${pythonCanonical(key)}:${pythonCanonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('unsupported canonical value');
}

function pythonDefaultJson(value) {
  if (value === null) return 'null';
  if (value instanceof PythonNumber) return canonicalNumber(value);
  if (typeof value === 'string' || typeof value === 'boolean') return pythonCanonical(value);
  if (Array.isArray(value)) return `[${value.map(pythonDefaultJson).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).map((key) => `${pythonCanonical(key)}: ${pythonDefaultJson(value[key])}`).join(', ')}}`;
  }
  throw new TypeError('unsupported JSON value');
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function str(value) {
  if (value instanceof PythonNumber) return /[.eE]/.test(value.raw) ? pythonFloat(value.value) : BigInt(value.raw).toString();
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value === null) return 'None';
  return String(value);
}

function esc(value) {
  return str(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;',
  })[ch]);
}

function required(content, key) {
  const value = content[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
}

function nonemptyStrings(content, key) {
  const values = content[key];
  if (!Array.isArray(values) || !values.length || values.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error(`${key} must be a nonempty list of strings`);
  }
}

function numeric(value) {
  return value instanceof PythonNumber ? value.value : value;
}

function safeUrl(value, { httpsOnly = false } = {}) {
  if (typeof value !== 'string' || /[\u0000-\u001f\\]/.test(value)) throw new Error('URL contains invalid characters');
  if (value.startsWith('/') && !value.startsWith('//') && !httpsOnly) return value;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('URL must be http(s) or a same-site relative path'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || (httpsOnly && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error(httpsOnly ? 'URL must be a safe HTTPS URL' : 'URL must be http(s) or a same-site relative path');
  }
  return value;
}

function allowedFormOrigins(env) {
  return new Set(String(env.SEO_FORM_ACTION_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    let url;
    try { url = new URL(item); } catch { return ''; }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin.toLowerCase();
  }).filter(Boolean));
}

function validateContent(kind, content, formOrigins) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('content must be an object');
  const textTypes = new Set(['introduction', 'paragraph', 'conclusion', 'context', 'featured_snippet_block']);
  if (textTypes.has(kind)) required(content, 'text');
  else if (['list_paragraph', 'numbered_list_paragraph', 'list_featured_snippet_block'].includes(kind)) nonemptyStrings(content, 'items');
  else if (kind === 'pros_and_cons') { nonemptyStrings(content, 'pros'); nonemptyStrings(content, 'cons'); }
  else if (kind === 'table') {
    nonemptyStrings(content, 'headers');
    if (!Array.isArray(content.rows) || !content.rows.length || content.rows.some((row) => !Array.isArray(row) || row.length !== content.headers.length || row.some((x) => typeof x !== 'string'))) throw new Error('rows must be nonempty and match header width');
  } else if (kind === 'faq') {
    if (!Array.isArray(content.items) || !content.items.length || content.items.some((x) => !x || typeof x !== 'object' || ['question', 'answer'].some((k) => typeof x[k] !== 'string' || !x[k].trim()))) throw new Error('items need question and answer');
  } else if (kind === 'quote') { required(content, 'text'); required(content, 'author'); if (content.source_url != null) safeUrl(content.source_url); }
  else if (kind === 'checklist') {
    if (!Array.isArray(content.items) || !content.items.length || content.items.some((x) => !x || typeof x !== 'object' || typeof x.action !== 'string' || !x.action)) throw new Error('items need action');
    if (content.items.some((x) => x.details != null && typeof x.details !== 'string')) throw new Error('details must be text');
  } else if (kind === 'statistic') { required(content, 'value'); required(content, 'label'); if (content.source_url != null) safeUrl(content.source_url); }
  else if (kind === 'versus') {
    if (!Array.isArray(content.competitors) || content.competitors.length !== 2 || content.competitors.some((x) => typeof x !== 'string' || !x)) throw new Error('competitors must have two names');
    if (!Array.isArray(content.criteria) || !content.criteria.length || content.criteria.some((x) => !x || typeof x !== 'object' || typeof x.name !== 'string' || !x.name.trim() || !Array.isArray(x.details) || x.details.length !== 2 || x.details.some((y) => typeof y !== 'string') || (x.winner != null && ![0, 1].includes(numeric(x.winner))))) throw new Error('criteria need names, two detail values and an optional winner');
  } else if (kind === 'timeline') {
    if (!Array.isArray(content.events) || !content.events.length || content.events.some((e) => !e || typeof e !== 'object' || ['date', 'title', 'description'].some((k) => typeof e[k] !== 'string' || !e[k]))) throw new Error('events need date, title and description');
  } else if (kind === 'bar_chart') {
    if (!Array.isArray(content.bars) || !content.bars.length || content.bars.some((bar) => !bar || typeof bar !== 'object' || typeof bar.label !== 'string' || !(bar.value instanceof PythonNumber) || !Number.isFinite(bar.value.value) || Math.abs(bar.value.value) > 1e9)) throw new Error('bars need finite numeric values within the supported range');
  } else if (kind === 'code_cluster') {
    if (!Array.isArray(content.examples) || !content.examples.length || content.examples.some((e) => !e || typeof e !== 'object' || typeof e.language !== 'string' || typeof e.code !== 'string')) throw new Error('examples need language and code');
  } else if (kind === 'case_study') {
    required(content, 'title'); required(content, 'summary');
    if (!Array.isArray(content.results) || !content.results.length || content.results.some((x) => !x || typeof x !== 'object' || ['metric', 'value'].some((k) => typeof x[k] !== 'string' || !x[k].trim()) || (x.description != null && typeof x.description !== 'string'))) throw new Error('results need at least one metric and value');
    if (content.company_name != null && typeof content.company_name !== 'string') throw new Error('company_name must be text');
    if (content.source_url != null) safeUrl(content.source_url);
  } else if (kind === 'tool_recommendation') {
    required(content, 'title'); required(content, 'description'); safeUrl(content.url); nonemptyStrings(content, 'features');
  } else if (['product_recommendations', 'affiliate_recommendations'].includes(kind)) {
    required(content, 'title');
    if (!Array.isArray(content.items) || !content.items.length || content.items.some((item) => !item || typeof item !== 'object')) throw new Error('items required');
    for (const item of content.items) { required(item, 'title'); required(item, 'description'); safeUrl(item.url); if (item.image != null) safeUrl(item.image); if (item.price != null && typeof item.price !== 'string') throw new Error('price must be text'); }
  } else if (['call_to_action', 'cta'].includes(kind)) { required(content, 'text'); required(content, 'label'); safeUrl(content.url); }
  else if (kind === 'image') { safeUrl(content.src); required(content, 'alt'); }
  else if (kind === 'glossary') {
    if (!Array.isArray(content.terms) || !content.terms.length || content.terms.some((term) => !term || typeof term !== 'object' || ['term', 'definition'].some((k) => typeof term[k] !== 'string' || !term[k]))) throw new Error('terms need term and definition');
  } else if (kind === 'poll') { required(content, 'question'); nonemptyStrings(content, 'options'); }
  else if (kind === 'quiz') {
    if (!Array.isArray(content.questions) || !content.questions.length || content.questions.some((q) => !q || typeof q !== 'object')) throw new Error('questions required');
    for (const question of content.questions) {
      required(question, 'question'); nonemptyStrings(question, 'options');
      const index = question.correct_index;
      if (!(index instanceof PythonNumber) || !/^-?(?:0|[1-9]\d*)$/.test(index.raw) || index.value < 0 || index.value >= question.options.length) throw new Error('correct_index outside options');
      if (question.explanation != null && typeof question.explanation !== 'string') throw new Error('explanation must be text');
    }
  } else if (kind === 'interactive_calculator') {
    required(content, 'title'); required(content, 'result_label');
    if (!['sum', 'difference', 'product', 'ratio'].includes(content.operation)) throw new Error('unsupported calculator operation');
    if (!Array.isArray(content.inputs) || content.inputs.length < 2 || content.inputs.length > 10 || content.inputs.some((item) => !item || typeof item !== 'object' || typeof item.label !== 'string' || !(item.value instanceof PythonNumber) || !Number.isFinite(item.value.value) || Math.abs(item.value.value) > 1e9)) throw new Error('inputs need labels and bounded finite numeric values');
    if (['difference', 'ratio'].includes(content.operation) && content.inputs.length !== 2) throw new Error('difference and ratio require exactly two inputs');
  } else if (kind === 'form') {
    required(content, 'title'); required(content, 'submit_label'); safeUrl(content.action_url, { httpsOnly: true });
    const action = new URL(content.action_url);
    if (!formOrigins.has(action.origin.toLowerCase())) throw new Error('form action origin must be explicitly configured in SEO_FORM_ACTION_ORIGINS');
    if (!Array.isArray(content.fields) || !content.fields.length || content.fields.some((field) => !field || typeof field !== 'object' || !['text', 'email', 'number'].includes(field.type) || ['name', 'label'].some((k) => typeof field[k] !== 'string' || !field[k]) || typeof field.required !== 'boolean')) throw new Error('invalid form fields');
  }
  if ('title' in content && typeof content.title !== 'string') throw new Error('title must be text');
}

function validateBlocks(blocks, formOrigins) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('article must contain at least one block');
  if (blocks.length > MAX_BLOCKS) throw new Error('article exceeds the 100 block limit');
  const ids = new Set();
  const validated = blocks.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block) || Object.keys(block).some((key) => !['id', 'type', 'content'].includes(key))) throw new Error('invalid block envelope');
    if (typeof block.id !== 'string' || !UUID_RE.test(block.id)) throw new Error('invalid block id');
    const id = block.id.toLowerCase();
    if (ids.has(id)) throw new Error('block ids must be unique');
    ids.add(id);
    if (typeof block.type !== 'string' || !CONTENT_TYPES.has(block.type)) throw new Error('unsupported block type');
    validateContent(block.type, block.content, formOrigins);
    return { id, type: block.type, content: block.content };
  });
  if (Array.from(pythonDefaultJson(validated)).length > MAX_BLOCKS_JSON_CHARS) throw new Error('article blocks exceed the 1 MB limit');
  return validated;
}

function renderBlock(block) {
  const c = block.content; const t = block.type;
  const title = c.title ? `<h2>${esc(c.title)}</h2>` : '';
  let body = '';
  if (['introduction', 'paragraph', 'conclusion', 'context', 'featured_snippet_block'].includes(t)) body = `<p>${esc(c.text)}</p>`;
  else if (['list_paragraph', 'numbered_list_paragraph', 'list_featured_snippet_block'].includes(t)) body = `${t === 'numbered_list_paragraph' ? '<ol>' : '<ul>'}${c.items.map((x) => `<li>${esc(x)}</li>`).join('')}${t === 'numbered_list_paragraph' ? '</ol>' : '</ul>'}`;
  else if (t === 'table') body = `<table><thead><tr>${c.headers.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${c.rows.map((row) => `<tr>${row.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  else if (t === 'faq') body = c.items.map((item) => `<details><summary>${esc(item.question)}</summary><p>${esc(item.answer)}</p></details>`).join('');
  else if (t === 'quote') body = `<blockquote><p>${esc(c.text)}</p><cite>${esc(c.author)}${c.source_url ? ` <a href="${esc(c.source_url)}" rel="nofollow noopener">Source</a>` : ''}</cite></blockquote>`;
  else if (t === 'checklist') body = `<ul>${c.items.map((item) => `<li>${esc(item.action)}${item.details ? ` — ${esc(item.details)}` : ''}</li>`).join('')}</ul>`;
  else if (t === 'statistic') body = `<figure><strong>${esc(c.value)}</strong><figcaption>${esc(c.label)}${c.source_url ? ` <a href="${esc(c.source_url)}" rel="nofollow noopener">Source</a>` : ''}</figcaption></figure>`;
  else if (t === 'pros_and_cons') body = `<div class="pros-cons"><section><h3>Pros</h3><ul>${c.pros.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section><section><h3>Cons</h3><ul>${c.cons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section></div>`;
  else if (t === 'versus') body = `<p>${esc(c.competitors.join(' vs '))}</p><table><tbody>${c.criteria.map((item) => `<tr><th>${esc(item.name)}</th>${item.details.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  else if (t === 'timeline') body = `<ol class="timeline">${c.events.map((event) => `<li><time>${esc(event.date)}</time><strong>${esc(event.title)}</strong><p>${esc(event.description)}</p></li>`).join('')}</ol>`;
  else if (t === 'bar_chart') {
    const high = Math.max(...c.bars.map((item) => Math.abs(Number(item.value)))) || 1;
    body = `<ul class="bar-chart">${c.bars.map((item) => { const plotted = Math.max(0, Number(item.value)); return `<li><span>${esc(item.label)}</span><meter min="0" max="${esc(pythonFloat(high))}" value="${esc(plotted === 0 ? '0' : pythonFloat(plotted))}"></meter><span>${esc(item.value)}</span></li>`; }).join('')}</ul>`;
  } else if (t === 'code_cluster') body = c.examples.map((item) => `<figure><figcaption>${esc(item.language)}</figcaption><pre><code>${esc(item.code)}</code></pre></figure>`).join('');
  else if (t === 'case_study') body = `${c.company_name ? `<p><strong>${esc(c.company_name)}</strong></p>` : ''}<p>${esc(c.summary)}</p><dl>${c.results.map((item) => `<dt>${esc(item.metric || '')}</dt><dd>${esc(item.value || '')}${item.description ? ` — ${esc(item.description)}` : ''}</dd>`).join('')}</dl>${c.source_url ? `<p><a href="${esc(c.source_url)}" rel="nofollow noopener">Case study source</a></p>` : ''}`;
  else if (t === 'tool_recommendation') body = `<p><a href="${esc(c.url)}" rel="nofollow noopener">${esc(c.title)}</a>: ${esc(c.description)}</p><ul>${c.features.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  else if (['product_recommendations', 'affiliate_recommendations'].includes(t)) body = `<ul class="recommendations">${c.items.map((item) => `<li>${item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy"> ` : ''}<a href="${esc(item.url)}" rel="nofollow noopener">${esc(item.title)}</a>: ${esc(item.description)}${item.price ? ` — ${esc(item.price)}` : ''}</li>`).join('')}</ul>`;
  else if (['call_to_action', 'cta'].includes(t)) body = `<p><a class="cta" href="${esc(c.url)}">${esc(c.label)}</a> ${esc(c.text)}</p>`;
  else if (t === 'image') body = `<figure><img src="${esc(c.src)}" alt="${esc(c.alt)}">${c.caption ? `<figcaption>${esc(c.caption)}</figcaption>` : ''}</figure>`;
  else if (t === 'glossary') body = `<dl>${c.terms.map((item) => `<dt>${esc(item.term)}</dt><dd>${esc(item.definition)}</dd>`).join('')}</dl>`;
  else if (t === 'poll') body = `<section class="poll" data-poll><p>${esc(c.question)}</p><ul>${c.options.map((x) => `<li><button type="button" data-poll-option>${esc(x)}</button></li>`).join('')}</ul><p data-local-result aria-live="polite"></p><small>Selection stays in this browser; responses are not collected.</small></section>`;
  else if (t === 'quiz') body = c.questions.map((question) => `<section class="quiz" data-quiz data-correct-index="${esc(question.correct_index)}"><p>${esc(question.question)}</p><ol>${question.options.map((x) => `<li><button type="button" data-quiz-option>${esc(x)}</button></li>`).join('')}</ol><p data-local-result aria-live="polite"></p><p data-quiz-explanation hidden>${esc(question.explanation || '')}</p></section>`).join('');
  else if (t === 'interactive_calculator') body = `<section data-calculator data-operation="${esc(c.operation)}"><h3>${esc(c.title)}</h3>${c.inputs.map((item) => `<label>${esc(item.label)}<input type="number" data-calc-input value="${esc(item.value)}"></label>`).join('')}<p>${esc(c.result_label)}: <output data-local-result aria-live="polite"></output></p></section>`;
  else if (t === 'form') body = `<form action="${esc(c.action_url)}" method="post"><h3>${esc(c.title)}</h3>${c.fields.map((field) => `<label>${esc(field.label)}<input name="${esc(field.name)}" type="${esc(field.type)}"${field.required ? ' required' : ''}></label>`).join('')}<button type="submit">${esc(c.submit_label)}</button></form>`;
  return `<section data-block-id="${esc(block.id)}" data-block-type="${esc(t)}">${title}${body}</section>`;
}

function renderHtml(blocks) {
  return blocks.map(renderBlock).join('\n');
}

function normalizedPath(path) {
  const absolute = resolve(path);
  let current = absolute;
  const remainder = [];
  while (true) {
    try {
      const real = realpathSync(current);
      return resolve(real, ...remainder.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      remainder.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

function isEnabled(env, userDatabasePath) {
  const origin = env.SEO_PUBLIC_ORIGIN;
  const databasePath = env.SEO_DATABASE_PATH;
  const token = env.SEO_RECEIVER_TOKEN;
  if (token !== undefined && typeof token !== 'string') return null;
  if (!token || !origin || origin !== 'https://49agents.com' || !databasePath || !isAbsolute(databasePath)) return null;
  const seoDatabase = normalizedPath(databasePath);
  const appDatabase = normalizedPath(userDatabasePath);
  if (seoDatabase === appDatabase) return null;
  try {
    if (statSync(seoDatabase).isDirectory()) return null;
  } catch { /* New isolated database is created on its first authenticated operation. */ }
  try {
    const a = statSync(seoDatabase); const b = statSync(appDatabase);
    if (a.dev === b.dev && a.ino === b.ino) return null;
  } catch { /* The separate database or user database may not exist yet. */ }
  return { origin, databasePath: seoDatabase, token };
}

function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');
  db.exec(`CREATE TABLE IF NOT EXISTS articles (
    article_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision > 0),
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    blocks_json TEXT NOT NULL,
    images_json TEXT NOT NULL DEFAULT '[]',
    canonical_url TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  return db;
}

function errorResponse(res, status, error) {
  return res.status(status).json({ detail: { error } });
}

function hostMatches(req, origin) {
  const header = req.headers.host;
  if (typeof header !== 'string' || !header || /[\s/@\\]/.test(header)) return false;
  let parsed;
  try { parsed = new URL(`https://${header}`); } catch { return false; }
  return parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password && parsed.hostname.toLowerCase() === new URL(origin).hostname;
}

function hostGate(origin) {
  return (req, res, next) => hostMatches(req, origin) ? next() : errorResponse(res, 404, 'not_found');
}

function bearerGate(token) {
  const expected = createHash('sha256').update(token, 'utf8').digest();
  return (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const match = /^Bearer (.+)$/.exec(authorization);
    const supplied = createHash('sha256').update(match ? match[1] : '', 'utf8').digest();
    if (!match || !timingSafeEqual(expected, supplied)) return errorResponse(res, 401, 'unauthorized');
    next();
  };
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
}

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function receiverError(status, error) {
  const failure = new Error(error);
  failure.status = status;
  failure.code = error;
  return failure;
}

function unknownKeys(value, allowed, error = 'invalid_envelope') {
  return Object.keys(value).some((key) => !allowed.has(key)) ? receiverError(422, error) : null;
}

function validatePayload(parsed, idempotencyKey, options) {
  const body = toNative(parsed);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw receiverError(422, 'invalid_envelope');
  const envelopeError = unknownKeys(body, new Set(['event_id', 'event_type', 'schema_version', 'article_id', 'revision', 'payload_hash', 'sent_at', 'article']));
  if (envelopeError) throw envelopeError;
  if (body.event_type !== 'article.upsert' || body.schema_version !== 1 || !(parsed.schema_version instanceof PythonNumber) || !/^-?(?:0|[1-9]\d*)$/.test(parsed.schema_version.raw)) throw receiverError(422, 'invalid_envelope');
  const revision = parsed.revision;
  if (!UUID_RE.test(body.event_id || '') || body.event_id !== idempotencyKey || !UUID_RE.test(body.article_id || '') || !(revision instanceof PythonNumber) || !/^-?(?:0|[1-9]\d*)$/.test(revision.raw) || !Number.isSafeInteger(body.revision) || body.revision < 1 || !/^[a-f0-9]{64}$/.test(body.payload_hash || '') || !body.article || typeof body.article !== 'object' || Array.isArray(body.article)) throw receiverError(422, 'invalid_identity');
  if (body.sent_at !== undefined && !validTimestamp(body.sent_at)) throw receiverError(422, 'invalid_metadata');

  const article = body.article;
  const articleError = unknownKeys(article, new Set(['slug', 'title', 'description', 'blocks', 'rendered_html', 'images', 'canonical_url']), 'invalid_article');
  if (articleError) throw articleError;
  const { slug, title, description, canonical_url: canonicalUrl, rendered_html: suppliedHtml } = article;
  if (typeof slug !== 'string' || slug.length > 180 || !SLUG_RE.test(slug) || typeof title !== 'string' || !title.trim() || title.length > 500 || typeof description !== 'string' || !description.trim() || description.length > 3000 || typeof canonicalUrl !== 'string' || typeof suppliedHtml !== 'string' || (article.images !== undefined && !Array.isArray(article.images))) throw receiverError(422, 'invalid_article');
  const expectedUrl = `${options.origin}/articles/${slug}`;
  if (canonicalUrl !== expectedUrl) throw receiverError(422, 'canonical_mismatch');
  let canonical;
  try { canonical = new URL(canonicalUrl); } catch { throw receiverError(422, 'invalid_canonical'); }
  if (canonical.protocol !== 'https:' || canonical.origin !== options.origin || canonical.pathname !== `/articles/${slug}` || canonical.search || canonical.hash) throw receiverError(422, 'invalid_canonical');
  if ((article.images || []).some((image) => { try { safeUrl(image); return false; } catch { return true; } })) throw receiverError(422, 'invalid_article');

  let blocks;
  let rendered;
  try {
    const originalBlocks = parsed.article.blocks;
    blocks = validateBlocks(originalBlocks, allowedFormOrigins(options.env));
    rendered = renderHtml(blocks);
  } catch {
    throw receiverError(422, 'invalid_blocks');
  }
  if (rendered !== suppliedHtml) throw receiverError(422, 'rendered_html_mismatch');
  const hashArticle = {
    slug, title, description, blocks, rendered_html: rendered,
    images: parsed.article.images === undefined ? [] : parsed.article.images,
    canonical_url: canonicalUrl,
  };
  let calculated;
  try { calculated = digest(pythonCanonical({ article_id: body.article_id, revision: parsed.revision, article: hashArticle })); }
  catch { throw receiverError(422, 'invalid_metadata'); }
  if (calculated !== body.payload_hash) throw receiverError(409, 'payload_hash_mismatch');
  return { ...body, article: { ...article, blocks, rendered_html: rendered, images: article.images || [] } };
}

function htmlPage({ title, description = '', canonical = '', content, articleId, revision, stylesheet = true }) {
  const markers = articleId ? ` data-article-id="${esc(articleId)}" data-revision="${revision}"` : '';
  const descriptionTag = description ? `<meta name="description" content="${esc(description)}">` : '';
  const canonicalTag = canonical ? `<link rel="canonical" href="${esc(canonical)}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="index,follow"><title>${esc(title)}</title>${descriptionTag}${canonicalTag}${stylesheet ? '<link rel="stylesheet" href="/seo-articles.css">' : ''}<script src="/seo-interactions.js" defer></script></head><body><header class="site-header"><a class="brand" href="/" aria-label="49Agents home">49Agents</a><nav><a href="/">Main website</a><a href="/articles">Articles</a></nav></header><main${markers}>${content}</main><footer><a href="/">Visit 49Agents.com</a></footer></body></html>`;
}

function createEnabledRouter(options) {
  const router = express.Router();
  const gate = hostGate(options.origin);
  const auth = bearerGate(options.token);
  const rawJson = express.raw({ type: 'application/json', limit: MAX_BODY_BYTES });
  const withDb = (handler) => (req, res, next) => {
    let db;
    try {
      db = openDatabase(options.databasePath);
      return handler(db, req, res, next);
    } catch (error) { if (db) db.close(); return next(error); }
  };

  router.get('/articles', seoHelmet, gate, withDb((db, req, res) => {
    try {
      const rows = db.prepare('SELECT slug,title,description,updated_at FROM articles ORDER BY updated_at DESC,slug ASC').all();
      const items = rows.map((row) => `<li><article><h2><a href="/articles/${esc(row.slug)}">${esc(row.title)}</a></h2><p>${esc(row.description)}</p><time datetime="${esc(row.updated_at)}">Updated ${esc(row.updated_at.slice(0, 10))}</time></article></li>`).join('');
      const content = `<section class="intro"><p class="eyebrow">49Agents insights</p><h1>Articles</h1><p>Practical ideas for working across agents, terminals, and projects.</p><a class="home-link" href="/">Explore 49Agents</a></section><ul class="article-list">${items || '<li class="empty">New articles are on the way.</li>'}</ul>`;
      res.type('html').send(htmlPage({ title: 'Articles | 49Agents', description: 'Ideas and guides from 49Agents.', canonical: `${options.origin}/articles`, content }));
    } finally { db.close(); }
  }));

  router.get('/articles/:slug', seoHelmet, gate, withDb((db, req, res) => {
    try {
      const row = db.prepare('SELECT * FROM articles WHERE slug=?').get(req.params.slug);
      if (!row) return errorResponse(res, 404, 'not_found');
      const blocks = parsePythonJson(row.blocks_json);
      const body = renderHtml(blocks);
      res.type('html').send(htmlPage({ title: row.title, description: row.description, canonical: row.canonical_url, content: `<h1 class="article-title">${esc(row.title)}</h1>${body}`, articleId: row.article_id, revision: row.revision }));
    } finally { db.close(); }
  }));

  router.get('/sitemap-seo.xml', seoHelmet, gate, withDb((db, req, res) => {
    try {
      const rows = db.prepare('SELECT canonical_url,updated_at FROM articles ORDER BY slug ASC').all();
      const urls = rows.map((row) => `<url><loc>${xml(row.canonical_url)}</loc><lastmod>${xml(row.updated_at.slice(0, 10))}</lastmod></url>`).join('');
      res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    } finally { db.close(); }
  }));

  router.get('/seo-interactions.js', seoHelmet, gate, (req, res) => res.sendFile(resolve(options.moduleDir, 'seo-interactions.js'), { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }));
  router.get('/seo-articles.css', seoHelmet, gate, (req, res) => res.sendFile(resolve(options.moduleDir, 'seo-articles.css'), { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }));

  router.post('/api/seo/v1/articles', seoHelmet, gate, auth, rawJson, (req, res, next) => {
    let parsed;
    try {
      if (!Buffer.isBuffer(req.body)) throw receiverError(400, 'invalid_json');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(req.body);
      parsed = parsePythonJson(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw receiverError(400, 'invalid_json');
    } catch (error) {
      if (error.status) return errorResponse(res, error.status, error.code);
      return errorResponse(res, 400, 'invalid_json');
    }

    let payload;
    try { payload = validatePayload(parsed, req.get('Idempotency-Key'), options); }
    catch (error) { return errorResponse(res, error.status || 422, error.code || 'invalid_blocks'); }

    let db;
    try {
      db = openDatabase(options.databasePath);
      db.exec('BEGIN IMMEDIATE');
      const event = db.prepare('SELECT * FROM events WHERE event_id=?').get(payload.event_id);
      if (event) {
        if (event.payload_hash !== payload.payload_hash || event.revision !== payload.revision || event.article_id !== payload.article_id) {
          db.exec('ROLLBACK'); db.close();
          return errorResponse(res, 409, 'event_payload_conflict');
        }
        const receipt = JSON.parse(event.response_json);
        db.exec('COMMIT'); db.close();
        return res.json(receipt);
      }

      const previous = db.prepare('SELECT * FROM articles WHERE article_id=?').get(payload.article_id);
      if (previous && payload.revision < previous.revision) {
        db.exec('ROLLBACK'); db.close();
        return errorResponse(res, 409, 'stale_revision');
      }
      if (previous && payload.revision === previous.revision && previous.payload_hash !== payload.payload_hash) {
        db.exec('ROLLBACK'); db.close();
        return errorResponse(res, 409, 'revision_payload_conflict');
      }
      if (previous && previous.slug !== payload.article.slug) {
        db.exec('ROLLBACK'); db.close();
        return errorResponse(res, 409, 'slug_immutable');
      }

      const publicUrl = `${options.origin}/articles/${payload.article.slug}`;
      const receipt = { event_id: payload.event_id, remote_id: payload.article_id, public_url: publicUrl, revision: payload.revision, payload_hash: payload.payload_hash };
      const timestamp = new Date().toISOString();
      const articleSql = `INSERT INTO articles(article_id,revision,slug,title,description,blocks_json,images_json,canonical_url,payload_hash,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,description=excluded.description,blocks_json=excluded.blocks_json,images_json=excluded.images_json,canonical_url=excluded.canonical_url,payload_hash=excluded.payload_hash,updated_at=excluded.updated_at`;
      db.prepare(articleSql).run(payload.article_id, payload.revision, payload.article.slug, payload.article.title, payload.article.description, pythonCanonical(payload.article.blocks), pythonCanonical(payload.article.images), payload.article.canonical_url, payload.payload_hash, timestamp);
      db.prepare('INSERT INTO events(event_id,article_id,revision,payload_hash,response_json,created_at) VALUES(?,?,?,?,?,?)').run(payload.event_id, payload.article_id, payload.revision, payload.payload_hash, JSON.stringify(receipt), timestamp);
      db.exec('COMMIT'); db.close();
      return res.status(201).json(receipt);
    } catch (error) {
      if (db) {
        try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
        try { db.close(); } catch { /* connection already closed */ }
      }
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT_UNIQUE')) return errorResponse(res, 409, 'slug_conflict');
      return next(error);
    }
  });

  router.get('/api/seo/v1/events/:event_id', seoHelmet, gate, auth, withDb((db, req, res) => {
    try {
      if (!UUID_RE.test(req.params.event_id)) return errorResponse(res, 404, 'not_found');
      const row = db.prepare('SELECT response_json FROM events WHERE event_id=?').get(req.params.event_id);
      if (!row) return errorResponse(res, 404, 'not_found');
      return res.json(JSON.parse(row.response_json));
    } finally { db.close(); }
  }));

  router.use('/api/seo/v1', (req, res) => errorResponse(res, 404, 'not_found'));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return errorResponse(res, 413, 'request_too_large');
    if (error.status === 400) return errorResponse(res, 400, 'invalid_json');
    console.error('[seo-publishing] Request failed:', error.message);
    return errorResponse(res, 500, 'internal_error');
  });
  return router;
}

/** Create the isolated SEO publisher router; disabled routers never touch SQLite. */
export function createSeoPublishingRouter({ env = process.env, userDatabasePath = './data/tc.db', moduleDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  const router = express.Router();
  const options = isEnabled(env, userDatabasePath);
  if (!options) {
    router.use('/api/seo/v1', (req, res) => errorResponse(res, 404, 'not_found'));
    return router;
  }
  return createEnabledRouter({ ...options, env, moduleDir });
}
