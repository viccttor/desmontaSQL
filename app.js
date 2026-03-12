'use strict';


let allPairs = [];

/* ============================================================
   Tema
   ============================================================ */

function toggleTheme() {
  const html   = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  const next   = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  document.getElementById('theme-label').textContent = next === 'dark' ? 'escuro' : 'claro';
  document.getElementById('theme-btn').setAttribute('aria-pressed', String(next === 'dark'));
  try { localStorage.setItem('sql-inspector-theme', next); } catch (_) {}
}

function applySavedTheme() {
  try {
    const saved = localStorage.getItem('sql-inspector-theme');
    if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      document.getElementById('theme-label').textContent = 'claro';
      document.getElementById('theme-btn').setAttribute('aria-pressed', 'false');
    }
  } catch (_) {}
}

/* ============================================================
   Parser SQL
   ============================================================ */

/**
 * Extrai o conteúdo do primeiro VALUES(...) usando contagem de parênteses.
 * Strings delimitadas por aspas simples são ignoradas corretamente.
 */
function extractValuesList(sql) {
  const valIdx = sql.search(/\bVALUES\s*\(/i);
  if (valIdx < 0) return null;

  const start = sql.indexOf('(', valIdx);
  let depth = 0;
  let i = start;

  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") break;
        i++;
      }
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return sql.slice(start + 1, i);
    }
    i++;
  }
  return null;
}

/**
 * Extrai a lista de colunas do INSERT (entre a tabela e VALUES).
 */
function extractColumns(sql) {
  const m = sql.match(/INSERT\s+INTO\s+[\w.\`"\[\]]+\s*\(([^)]+)\)\s*VALUES/i);
  if (!m) return null;
  return m[1].split(',').map(c => c.trim().replace(/^[`"\[]|[`"\]]+$/g, ''));
}

/**
 * Extrai o nome da tabela do INSERT.
 */
function extractTableName(sql) {
  const m = sql.match(/INSERT\s+INTO\s+([\w.\`"\[\]]+)/i);
  return m ? m[1].replace(/^[`"\[]|[`"\]]+$/g, '') : null;
}

/**
 * Tokeniza a lista de valores SQL, respeitando strings com aspas simples.
 */
function tokenizeValues(raw) {
  if (!raw) return [];
  const tokens = [];
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === "'") {
      let j = i + 1, val = '';
      while (j < raw.length) {
        if (raw[j] === "'" && raw[j + 1] === "'") { val += "'"; j += 2; continue; }
        if (raw[j] === "'") break;
        val += raw[j];
        j++;
      }
      tokens.push({ type: 'str', val });
      i = j + 1;

    } else if (ch === ',' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;

    } else {
      let j = i, val = '';
      while (j < raw.length && raw[j] !== ',' && raw[j] !== ')' && raw[j] !== '(') {
        val += raw[j]; j++;
      }
      val = val.trim();
      if (val.length) tokens.push({ type: 'raw', val });
      i = (raw[j] === '(' || raw[j] === ')') ? j + 1 : j;
    }
  }

  return tokens;
}

function parseInsert(sql) {
  const tableName = extractTableName(sql);
  const columns   = extractColumns(sql);
  const rawValues = extractValuesList(sql);

  if (!tableName || !columns || !rawValues) return null;

  const values = tokenizeValues(rawValues);
  if (!values.length) return null;

  return {
    op: 'INSERT',
    table: tableName,
    pairs: columns.map((key, idx) => ({
      key,
      val:  values[idx] !== undefined ? values[idx].val  : null,
      type: values[idx] !== undefined ? values[idx].type : 'raw',
    })),
    where: null,
  };
}

function parseUpdate(sql) {
  const tableMatch = sql.match(/UPDATE\s+([\w.\`"\[\]]+)\s+SET\s+/i);
  if (!tableMatch) return null;

  const setMatch = sql.match(/\bSET\s+/i);
  if (!setMatch) return null;

  const setStart = sql.search(/\bSET\s+/i) + setMatch[0].length;
  const whereIdx = sql.search(/\bWHERE\b/i);
  const setPart  = whereIdx > 0 ? sql.slice(setStart, whereIdx) : sql.slice(setStart);

  const pairs   = [];
  const pattern = /(\w+)\s*=\s*('(?:[^']|'')*'|[^,]+)/g;
  let m;

  while ((m = pattern.exec(setPart)) !== null) {
    const raw = m[2].trim();
    if (raw.startsWith("'")) {
      pairs.push({ key: m[1], val: raw.slice(1, -1), type: 'str' });
    } else {
      pairs.push({ key: m[1], val: raw, type: 'raw' });
    }
  }

  if (!pairs.length) return null;

  return {
    op: 'UPDATE',
    table: tableMatch[1].replace(/^[`"\[]|[`"\]]+$/g, ''),
    pairs,
    where: whereIdx > 0 ? sql.slice(whereIdx + 6).trim() : null,
  };
}

/* ============================================================
   Helpers de renderização
   ============================================================ */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatValue(val, type) {
  if (val === null || val === undefined) return '<span class="v-null">NULL</span>';
  if (val === '')                         return '<span class="v-null">&#39;&#39;&thinsp;(vazio)</span>';
  if (val.toUpperCase() === 'NULL')       return '<span class="v-null">NULL</span>';
  if (type === 'str')                     return '<span class="v-str">&#39;' + esc(val) + '&#39;</span>';
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(val)) return '<span class="v-num">' + esc(val) + '</span>';
  return '<span class="v-raw">' + esc(val) + '</span>';
}

function renderRows(pairs, filter) {
  const tbody   = document.getElementById('tbody');
  const countEl = document.getElementById('result-count');
  const q       = filter.toLowerCase().trim();

  const filtered = q
    ? pairs.filter(p =>
        p.key.toLowerCase().includes(q) ||
        String(p.val !== null && p.val !== undefined ? p.val : '').toLowerCase().includes(q)
      )
    : pairs;

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="empty-state">Nenhum resultado para "' + esc(filter) + '"</td></tr>';
    countEl.textContent = '0 / ' + pairs.length;
    return;
  }

  var html = '';
  for (var i = 0; i < filtered.length; i++) {
    var p = filtered[i];
    var isHl = q && (
      p.key.toLowerCase().includes(q) ||
      String(p.val !== null && p.val !== undefined ? p.val : '').toLowerCase().includes(q)
    );
    html += '<tr' + (isHl ? ' class="row--hl"' : '') + '>' +
      '<td><span class="col-idx">' + (i + 1) + '</span><span class="col-name">' + esc(p.key) + '</span></td>' +
      '<td>' + formatValue(p.val, p.type) + '</td>' +
      '</tr>';
  }
  tbody.innerHTML = html;

  countEl.textContent = filtered.length === pairs.length
    ? pairs.length + ' colunas'
    : filtered.length + ' / ' + pairs.length;
}

/* ============================================================
   Ações da UI
   ============================================================ */

function showError(msg) {
  var el = document.getElementById('error-msg');
  el.textContent = msg;
  el.hidden = false;
}

function hideError() {
  var el = document.getElementById('error-msg');
  el.hidden = true;
  el.textContent = '';
}

function parse() {
  hideError();

  var sql = document.getElementById('sql-input').value.trim();
  if (!sql) {
    showError('Cole um SQL válido no campo acima.');
    return;
  }

  var result = parseInsert(sql) || parseUpdate(sql);

  if (!result || !result.pairs.length) {
    showError('Não foi possível identificar um INSERT ou UPDATE válido. Verifique o formato.');
    return;
  }

  allPairs = result.pairs;

  document.getElementById('meta-bar').innerHTML =
    '<span class="badge badge--op">' + esc(result.op) + '</span> ' +
    '<span class="badge badge--meta">' + esc(result.table) + '</span> ' +
    '<span class="badge badge--meta">' + result.pairs.length + ' colunas</span>';

  var whereBlock = document.getElementById('where-block');
  if (result.where) {
    whereBlock.innerHTML = '<b>WHERE</b>&nbsp; ' + esc(result.where);
    whereBlock.hidden = false;
  } else {
    whereBlock.hidden = true;
  }

  document.getElementById('search-input').value = '';
  document.getElementById('btn-csv').hidden  = false;
  document.getElementById('output').hidden   = false;

  renderRows(allPairs, '');

  document.getElementById('output').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearAll() {
  document.getElementById('sql-input').value   = '';
  document.getElementById('output').hidden      = true;
  document.getElementById('btn-csv').hidden     = true;
  document.getElementById('where-block').hidden = true;
  hideError();
  allPairs = [];
}

function downloadCSV() {
  var header = 'Coluna,Valor';
  var rows = allPairs.map(function(p) {
    return '"' + p.key + '","' + String(p.val !== null && p.val !== undefined ? p.val : '').replace(/"/g, '""') + '"';
  });
  var csv = '\uFEFF' + [header].concat(rows).join('\n'); // BOM para Excel reconhecer UTF-8

  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var url  = URL.createObjectURL(blob);

  var a = document.createElement('a');
  a.href     = url;
  a.download = 'sql-inspector-' + Date.now() + '.csv';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  setTimeout(function() {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 1000);
}

/* ============================================================
   Inicialização
   ============================================================ */

document.addEventListener('DOMContentLoaded', function() {
  applySavedTheme();

  document.getElementById('theme-btn').addEventListener('click', toggleTheme);
  document.getElementById('btn-parse').addEventListener('click', parse);
  document.getElementById('btn-clear').addEventListener('click', clearAll);
  document.getElementById('btn-csv').addEventListener('click', downloadCSV);

  document.getElementById('search-input').addEventListener('input', function(e) {
    renderRows(allPairs, e.target.value);
  });

  document.getElementById('sql-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      parse();
    }
  });
});
