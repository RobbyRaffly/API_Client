// ===== State =====
const state = {
  collections: [],
  history: [],
  environments: [],
  activeEnvId: null,
  currentRequest: {
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    bodyType: 'none',
    body: '',
    formData: [],
    timeout: 30,
    preScript: '',
    postScript: '',
  },
  lastResponse: null,
  editingCollectionId: null,
  editingEnvId: null,
  activeCollectionId: null,    // tracks which collection the current request belongs to
  activeFolderId: null,        // tracks which folder the current request belongs to
  activeRequest: null,         // { colId, reqId, name, snapshot } — set when loading a saved request
  isDirty: false,
  unsavedChanges: {},          // { reqKey: { colId, reqId, name, changes } } - tracks all unsaved requests
  responseView: 'pretty',
  scriptVars: {},        // request-scoped vars (cleared each request)
  relayEnabled: false,   // relay feature toggle
  relayUrl: '',          // relay proxy URL
  responseHistory: [],   // response history for current request
};

// ===== Init =====
async function init() {
  await Promise.all([loadCollections(), loadHistory(), loadEnvironments()]);
  renderCollections();
  renderHistory();
  renderEnvironments();
  initKVRows('params', state.currentRequest.params);
  initKVRows('headers', state.currentRequest.headers);
  setupEventListeners();
  // Initialize body line numbers
  if (window.updateBodyLineNumbers) window.updateBodyLineNumbers();
}

// ===== API Helpers =====
async function apiCall(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadCollections() { state.collections = await apiCall('/api/collections') || []; }
async function loadHistory()     { state.history     = await apiCall('/api/history')     || []; }
async function loadEnvironments(){ state.environments= await apiCall('/api/environments')|| []; }

// ===== UUID & Timestamp Helpers =====
function generateUUID() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function formatTimestamp(date, fmt) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  
  // Get timezone offset for Z placeholder
  const tzOffset = -date.getTimezoneOffset();
  const tzSign = tzOffset >= 0 ? '+' : '-';
  const tzHours = pad(Math.floor(Math.abs(tzOffset) / 60));
  const tzMins = pad(Math.abs(tzOffset) % 60);
  
  let result = fmt
    .replace(/YYYY/g, date.getFullYear())
    .replace(/YY/g,   String(date.getFullYear()).slice(2))
    .replace(/MM/g,   pad(date.getMonth() + 1))
    .replace(/DD/g,   pad(date.getDate()))
    .replace(/HH/g,   pad(date.getHours()))
    .replace(/mm/g,   pad(date.getMinutes()))
    .replace(/ss/g,   pad(date.getSeconds()))
    .replace(/SSS/g,  pad(date.getMilliseconds(), 3));
  
  // Handle timezone: ZZ -> +0700, Z (at end only) -> +07:00
  // But keep literal +07:00 or -05:00 unchanged
  result = result.replace(/ZZ/g, `${tzSign}${tzHours}${tzMins}`);
  // Only replace standalone Z at end if not already has timezone offset like +07:00
  if (result.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(result.slice(0, -1))) {
    result = result.slice(0, -1) + `${tzSign}${tzHours}:${tzMins}`;
  }
  
  return result;
}

// ===== Dynamic Variable Resolution =====
function resolveEnvVars(str) {
  if (!str) return str;
  const now = new Date();

  // Built-in dynamic vars
  str = str.replace(/\{\{\$timestamp\}\}/gi,    () => Math.floor(now.getTime() / 1000));
  str = str.replace(/\{\{\$epochMs\}\}/gi,       () => now.getTime());
  str = str.replace(/\{\{\$isoTimestamp\}\}/gi,  () => now.toISOString());
  str = str.replace(/\{\{\$uuid\}\}/gi,           generateUUID);
  str = str.replace(/\{\{\$randomUUID\}\}/gi,     generateUUID);
  str = str.replace(/\{\{\$randomInt\}\}/gi,      () => Math.floor(Math.random() * 1000));
  str = str.replace(/\{\{\$timestampFormat:([^}]+)\}\}/g, (_, fmt) => formatTimestamp(now, fmt));
  // Also support without $ prefix (for Postman compatibility)
  str = str.replace(/\{\{timestampFormat:([^}]+)\}\}/g, (_, fmt) => formatTimestamp(now, fmt));

  // Named vars: scriptVars > active env
  str = str.replace(/\{\{([^${}][^{}]*)\}\}/g, (match, key) => {
    key = key.trim();
    if (state.scriptVars[key] !== undefined) return state.scriptVars[key];
    if (state.activeEnvId) {
      const env = state.environments.find(e => e.id === state.activeEnvId);
      const v = (env?.variables || []).find(v => v.key === key);
      if (v) return v.value;
    }
    return match;
  });
  return str;
}

// Strip comments from JSON/text body (// single-line and /* */ multi-line comments)
function stripComments(str) {
  if (!str) return str;
  
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let escaped = false;
  
  while (i < str.length) {
    const ch = str[i];
    const next = str[i + 1];
    
    if (escaped) {
      result += ch;
      escaped = false;
      i++;
      continue;
    }
    
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      i++;
      continue;
    }
    
    // String handling
    if (!inString && (ch === '"' || ch === "'")) {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }
    
    if (inString && ch === stringChar) {
      inString = false;
      result += ch;
      i++;
      continue;
    }
    
    // Not in string - check for comments
    if (!inString) {
      // Single-line comment //
      if (ch === '/' && next === '/') {
        // Skip until end of line
        while (i < str.length && str[i] !== '\n') i++;
        continue;
      }
      
      // Multi-line comment /* */
      if (ch === '/' && next === '*') {
        i += 2; // Skip /*
        // Find closing */
        while (i < str.length) {
          if (str[i] === '*' && str[i + 1] === '/') {
            i += 2; // Skip */
            break;
          }
          i++;
        }
        continue;
      }
    }
    
    result += ch;
    i++;
  }
  
  // Remove empty lines and lines with only whitespace
  return result.split('\n').filter(line => line.trim() !== '').join('\n');
}

// Beautify JSON while preserving ALL comment lines and inline comments
function beautifyWithComments(str) {
  if (!str) return str;
  
  const lines = str.split('\n');
  
  // First, extract all comments with their line indices
  const commentLines = []; // { index, content, isFullLine }
  const jsonParts = [];    // Pure JSON without any comments
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Check if entire line is a comment (starts with //)
    if (trimmed.startsWith('//')) {
      commentLines.push({ index: i, content: line, isFullLine: true });
      continue;
    }
    
    // Check if line is empty
    if (trimmed === '') {
      commentLines.push({ index: i, content: '', isFullLine: true, isEmpty: true });
      continue;
    }
    
    // Check for inline comment
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let commentStart = -1;
    
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (!inString && (ch === '"' || ch === "'")) { inString = true; stringChar = ch; }
      else if (inString && ch === stringChar) { inString = false; }
      else if (!inString && ch === '/' && line[j + 1] === '/') {
        commentStart = j;
        break;
      }
    }
    
    if (commentStart >= 0) {
      // Line has inline comment
      const jsonPart = line.slice(0, commentStart).trimEnd();
      const commentPart = line.slice(commentStart);
      commentLines.push({ index: i, content: commentPart, isFullLine: false, jsonBefore: jsonPart });
      if (jsonPart.trim()) {
        jsonParts.push(jsonPart);
      }
    } else {
      // Pure JSON line
      jsonParts.push(line);
    }
  }
  
  // Try to beautify the JSON
  const jsonStr = jsonParts.join('\n');
  let beautifiedLines;
  try {
    const stripped = stripComments(jsonStr);
    const parsed = JSON.parse(stripped);
    beautifiedLines = JSON.stringify(parsed, null, 2).split('\n');
  } catch (e) {
    throw e; // Can't beautify invalid JSON
  }
  
  // Now we need to merge beautified JSON with comments
  // Strategy: 
  // 1. Full-line comments at the beginning go first
  // 2. Beautified JSON in the middle
  // 3. Full-line comments at the end go last
  // 4. Inline comments are placed after the first line of beautified JSON (best effort)
  
  const result = [];
  
  // Find first and last JSON line indices in original
  let firstJsonIndex = -1;
  let lastJsonIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && !trimmed.startsWith('//')) {
      if (firstJsonIndex === -1) firstJsonIndex = i;
      lastJsonIndex = i;
    }
  }
  
  // Add leading comments (before first JSON)
  for (const c of commentLines) {
    if (c.isFullLine && c.index < firstJsonIndex) {
      result.push(c.content);
    }
  }
  
  // Check if first JSON line had inline comment
  const firstLineComment = commentLines.find(c => !c.isFullLine && c.index === firstJsonIndex);
  if (firstLineComment && beautifiedLines.length > 0) {
    // Add inline comment to first line of beautified JSON
    result.push(beautifiedLines[0] + ' ' + firstLineComment.content);
    for (let i = 1; i < beautifiedLines.length; i++) {
      result.push(beautifiedLines[i]);
    }
  } else {
    result.push(...beautifiedLines);
  }
  
  // Add trailing comments (after last JSON)
  for (const c of commentLines) {
    if (c.isFullLine && c.index > lastJsonIndex) {
      result.push(c.content);
    }
  }
  
  return result.join('\n');
}

// ===== cURL Import / Export =====
function tokenizeCurl(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      let tok = '';
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && i + 1 < s.length) { i++; tok += s[i]; }
        else tok += s[i];
        i++;
      }
      if (i < s.length) i++;
      tokens.push(tok);
    } else {
      let tok = '';
      while (i < s.length && !/\s/.test(s[i])) tok += s[i++];
      if (tok) tokens.push(tok);
    }
  }
  return tokens;
}

function parseCurl(raw) {
  let s = raw
    .replace(/\r\n/g, '\n')
    .replace(/\\\n/g, ' ')
    .replace(/\n/g, ' ')
    .trim()
    .replace(/^curl\s*/i, '');

  const tokens = tokenizeCurl(s);
  let method = null, url = '', body = '', bodyType = 'none';
  const headers = [];
  let authUser = '', authPass = '';

  const skipFlags = new Set([
    '--compressed', '-L', '--location', '-k', '--insecure',
    '-v', '--verbose', '-s', '--silent', '-i', '--include',
    '-I', '--head', '-f', '--fail', '-g', '--globoff',
  ]);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (skipFlags.has(t)) continue;

    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || '').toUpperCase();
    } else if (t === '--url') {
      // --url flag used by Postman code snippet and some curl variants
      url = tokens[++i] || '';
    } else if (t === '-H' || t === '--header') {
      const hdr = tokens[++i] || '';
      const colon = hdr.indexOf(':');
      if (colon > 0) headers.push({ key: hdr.slice(0, colon).trim(), value: hdr.slice(colon + 1).trim() });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(t)) {
      body = tokens[++i] || '';
      if (!method) method = 'POST';
      const trim = body.trim();
      if      (trim.startsWith('{') || trim.startsWith('[')) bodyType = 'json';
      else if (trim.startsWith('<'))                          bodyType = 'xml';
      else                                                    bodyType = 'text';
    } else if (t === '-u' || t === '--user') {
      const creds = tokens[++i] || '';
      const ci = creds.indexOf(':');
      authUser = ci >= 0 ? creds.slice(0, ci) : creds;
      authPass = ci >= 0 ? creds.slice(ci + 1) : '';
    } else if (!t.startsWith('-') && !url) {
      url = t.replace(/^['"]|['"]$/g, '');
    } else if (t.startsWith('-')) {
      // Skip unknown option + its value if not a flag
      if (!skipFlags.has(t) && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
    }
  }

  if (!method) method = body ? 'POST' : 'GET';

  const result = { method, url, headers, body, bodyType };
  if (authUser) result.auth = { type: 'basic', username: authUser, password: authPass };
  return result;
}

function generateCurl() {
  const method   = document.getElementById('method-select').value;
  const rawUrl   = document.getElementById('url-input').value.trim();
  const resolvedUrl = resolveEnvVars(rawUrl);
  const headers  = getKVPairs('headers'); // Only enabled headers
  const params   = getKVPairs('params').filter(p => p.key); // Only enabled params
  const body     = window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || '');
  const bodyType = state.currentRequest.bodyType;
  const auth     = state.currentRequest.auth;

  const parts = ['curl'];
  if (method !== 'GET') parts.push(`-X ${method}`);

  // Remove query params from URL - we'll use only params from Params tab
  let baseUrl = resolvedUrl;
  const qIdx = baseUrl.indexOf('?');
  if (qIdx !== -1) {
    baseUrl = baseUrl.slice(0, qIdx);
  }
  
  // Build URL with enabled params only
  let fullUrl = baseUrl;
  if (params.length) {
    const qs = params.map(p => `${encodeURIComponent(resolveEnvVars(p.key))}=${encodeURIComponent(resolveEnvVars(p.value))}`).join('&');
    fullUrl += '?' + qs;
  }
  parts.push(`'${fullUrl}'`);

  // Resolve auth values
  if (auth.type === 'bearer' && auth.token)
    parts.push(`  -H 'Authorization: Bearer ${resolveEnvVars(auth.token)}'`);
  else if (auth.type === 'basic' && auth.username)
    parts.push(`  -u '${resolveEnvVars(auth.username)}:${resolveEnvVars(auth.password) || ''}'`);
  else if (auth.type === 'apikey' && auth.key && auth.value && auth.placement !== 'query')
    parts.push(`  -H '${resolveEnvVars(auth.key)}: ${resolveEnvVars(auth.value)}'`);

  // Resolve header values (only enabled headers)
  headers.filter(h => h.key).forEach(h =>
    parts.push(`  -H '${resolveEnvVars(h.key)}: ${resolveEnvVars(h.value)}'`));

  if (['POST', 'PUT', 'PATCH'].includes(method) && body && bodyType !== 'none') {
    if (bodyType === 'json' && !headers.find(h => h.key.toLowerCase() === 'content-type'))
      parts.push(`  -H 'Content-Type: application/json'`);
    // Resolve body variables and strip comments
    const resolvedBody = resolveEnvVars(stripComments(body));
    const escaped = resolvedBody.replace(/'/g, "'\\''");
    parts.push(`  -d '${escaped}'`);
  }

  return parts.join(' \\\n');
}

// ===== Collection Export / Import =====
function exportCollection(colId) {
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;
  const blob = new Blob([JSON.stringify(col, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${col.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`Exported: ${col.name}`);
}

// Convert Postman script to app-compatible script
function convertPostmanScript(script) {
  if (!script) return '';
  
  let s = script;
  
  // Remove require statements (moment, crypto-js are provided globally or via pm.utils)
  s = s.replace(/const\s+moment\s*=\s*require\s*\(\s*['"]moment['"]\s*\)\s*;?/g, '// moment is available via pm.utils');
  s = s.replace(/const\s+CryptoJS\s*=\s*require\s*\(\s*['"]crypto-js['"]\s*\)\s*;?/g, '// CryptoJS is available globally');
  s = s.replace(/const\s+\w+\s*=\s*require\s*\([^)]+\)\s*;?/g, '// require() removed - use pm.utils or global objects');
  
  // Convert moment().utcOffset(N).format("...") to pm.utils.formatTimestamp("...")
  s = s.replace(/moment\(\)\.utcOffset\s*\(\s*\d+\s*\)\.format\s*\(\s*["']([^"']+)["']\s*\)/g, 
    'pm.utils.formatTimestamp("$1")');
  
  // Convert moment().format("...") to pm.utils.formatTimestamp("...")
  s = s.replace(/moment\(\)\.format\s*\(\s*["']([^"']+)["']\s*\)/g, 
    'pm.utils.formatTimestamp("$1")');
  
  // Convert moment() to new Date()
  s = s.replace(/moment\(\)/g, 'new Date()');
  
  // Convert pm.test("name", function() {...}) - keep as is (already supported)
  // Convert pm.expect - keep as is (already supported)
  
  // Convert jsonData = pm.response.json() pattern
  s = s.replace(/pm\.response\.json\(\)/g, 'pm.response.json()');
  
  return s;
}

function convertPostmanCollection(pm) {
  // Convert a single request item
  const convertRequest = (item) => {
    const req = item.request;
    const rawUrl = typeof req.url === 'string' ? req.url : (req.url?.raw || '');
    const headers = (req.header || []).map(h => ({ key: h.key, value: h.value, enabled: h.disabled !== true }));
    const params  = (req.url?.query || []).map(q => ({ key: q.key, value: q.value, enabled: q.disabled !== true }));

    let body = '', bodyType = 'none';
    if (req.body?.mode === 'raw') {
      body = req.body.raw || '';
      const lang = req.body.options?.raw?.language || '';
      bodyType = lang === 'json' ? 'json' : lang === 'xml' ? 'xml' : 'text';
    } else if (req.body?.mode === 'urlencoded') {
      body = (req.body.urlencoded || []).map(f => `${f.key}=${f.value}`).join('&');
      bodyType = 'form';
    }

    let auth = { type: 'none' };
    if (req.auth?.type === 'bearer') {
      auth = { type: 'bearer', token: (req.auth.bearer || []).find(b => b.key === 'token')?.value || '' };
    } else if (req.auth?.type === 'basic') {
      const basic = req.auth.basic || [];
      auth = {
        type: 'basic',
        username: basic.find(b => b.key === 'username')?.value || '',
        password: basic.find(b => b.key === 'password')?.value || '',
      };
    }

    // Extract pre-request and test scripts from event array
    let preScript = '', testScript = '';
    (item.event || []).forEach(evt => {
      const scriptLines = evt.script?.exec || [];
      const scriptText = Array.isArray(scriptLines) ? scriptLines.join('\n') : scriptLines;
      if (evt.listen === 'prerequest') {
        preScript = convertPostmanScript(scriptText);
      } else if (evt.listen === 'test') {
        testScript = convertPostmanScript(scriptText);
      }
    });

    return {
      id: String(Date.now() + Math.random()),
      name: item.name || rawUrl,
      method: (req.method || 'GET').toUpperCase(),
      url: rawUrl, headers, params, body, bodyType, auth,
      preScript,
      postScript: testScript,
    };
  };

  // Process items - separate folders and requests
  const folders = [];
  const rootRequests = [];

  (pm.item || []).forEach(item => {
    if (item.item && !item.request) {
      // This is a folder
      const folderRequests = [];
      (item.item || []).forEach(subItem => {
        if (subItem.request) {
          folderRequests.push(convertRequest(subItem));
        } else if (subItem.item) {
          // Nested folder - flatten with prefix
          (subItem.item || []).forEach(nestedItem => {
            if (nestedItem.request) {
              const req = convertRequest(nestedItem);
              req.name = subItem.name + '/' + req.name;
              folderRequests.push(req);
            }
          });
        }
      });
      folders.push({
        id: String(Date.now() + Math.random()),
        name: item.name || 'Folder',
        requests: folderRequests,
      });
    } else if (item.request) {
      // Root level request
      rootRequests.push(convertRequest(item));
    }
  });

  return {
    name: pm.info?.name || 'Imported',
    description: pm.info?.description || '',
    folders: folders,
    requests: rootRequests,
  };
}

function convertInsomniaCollection(data) {
  // Insomnia export format has resources array with different _type values
  const resources = data.resources || [];
  
  // Build folder map for path prefixes
  const folders = {};
  resources.filter(r => r._type === 'request_group').forEach(f => {
    folders[f._id] = { name: f.name, parentId: f.parentId };
  });
  
  // Get workspace name
  const workspace = resources.find(r => r._type === 'workspace');
  const collectionName = workspace?.name || data.name || 'Imported from Insomnia';
  
  // Helper to build folder path
  const getFolderPath = (parentId) => {
    const parts = [];
    let current = parentId;
    while (current && folders[current]) {
      parts.unshift(folders[current].name);
      current = folders[current].parentId;
    }
    return parts.length ? parts.join('/') + '/' : '';
  };
  
  // Convert requests
  const requests = resources
    .filter(r => r._type === 'request')
    .map(req => {
      // Parse URL and query params
      let url = req.url || '';
      const params = (req.parameters || []).map(p => ({
        key: p.name || p.key || '',
        value: p.value || '',
        enabled: p.disabled !== true,
      }));
      
      // Headers
      const headers = (req.headers || []).map(h => ({
        key: h.name || h.key || '',
        value: h.value || '',
        enabled: h.disabled !== true,
      }));
      
      // Body
      let body = '', bodyType = 'none';
      if (req.body) {
        if (req.body.mimeType === 'application/json' || req.body.mimeType?.includes('json')) {
          body = req.body.text || '';
          bodyType = 'json';
        } else if (req.body.mimeType === 'application/xml' || req.body.mimeType?.includes('xml')) {
          body = req.body.text || '';
          bodyType = 'xml';
        } else if (req.body.mimeType === 'application/x-www-form-urlencoded') {
          body = (req.body.params || []).map(p => `${p.name || p.key}=${p.value}`).join('&');
          bodyType = 'form';
        } else if (req.body.text) {
          body = req.body.text;
          bodyType = 'text';
        }
      }
      
      // Authentication
      let auth = { type: 'none' };
      if (req.authentication) {
        if (req.authentication.type === 'bearer') {
          auth = { type: 'bearer', token: req.authentication.token || '' };
        } else if (req.authentication.type === 'basic') {
          auth = {
            type: 'basic',
            username: req.authentication.username || '',
            password: req.authentication.password || '',
          };
        }
      }
      
      const prefix = getFolderPath(req.parentId);
      
      return {
        id: String(Date.now() + Math.random()),
        name: prefix + (req.name || url),
        method: (req.method || 'GET').toUpperCase(),
        url, headers, params, body, bodyType, auth,
      };
    });
  
  return {
    name: collectionName,
    description: workspace?.description || '',
    requests,
  };
}

function convertPostmanEnvironment(data) {
  // Postman environment format: { id, name, values: [{key, value, enabled}] }
  return {
    name: data.name || 'Imported Environment',
    variables: (data.values || [])
      .filter(v => v.enabled !== false)
      .map(v => ({ key: v.key || '', value: v.value || '' })),
  };
}

async function doImportCollectionData(data) {
  let collections = [];
  let environments = [];

  if (Array.isArray(data)) {
    // This app's native format (array of collections)
    collections = data.map(({ id, createdAt, ...rest }) => rest);
  } else if (data.info && data.item) {
    // Postman v2.x Collection format
    const converted = convertPostmanCollection(data);
    console.log('[Import] Converted Postman collection:', converted.name);
    console.log('[Import] Folders:', converted.folders?.length || 0);
    // Debug: check all folders for preScripts
    for (const folder of (converted.folders || [])) {
      console.log(`[Import] Folder: ${folder.name}, requests: ${folder.requests?.length || 0}`);
      for (const req of (folder.requests || [])) {
        if (req.preScript) {
          console.log(`[Import]   Request "${req.name}" has preScript (${req.preScript.length} chars)`);
          console.log(`[Import]   preScript preview: ${req.preScript.substring(0, 100)}...`);
        }
        if (req.testScript) {
          console.log(`[Import]   Request "${req.name}" has testScript (${req.testScript.length} chars)`);
        }
      }
    }
    collections = [converted];
  } else if (data.values && Array.isArray(data.values) && data.values[0]?.key !== undefined) {
    // Postman Environment format (has values array with key/value pairs)
    environments = [convertPostmanEnvironment(data)];
  } else if (data._type === 'export' && data.resources) {
    // Insomnia v4 export format
    collections = [convertInsomniaCollection(data)];
  } else if (data.resources && Array.isArray(data.resources)) {
    // Insomnia format without _type (older versions)
    collections = [convertInsomniaCollection(data)];
  } else if (data.requests && Array.isArray(data.requests)) {
    // Single collection with requests array (this app's format)
    const { id, createdAt, ...rest } = data;
    if (!rest.name) rest.name = 'Imported Collection';
    collections = [rest];
  } else if (data.name && data.variables) {
    // Single environment (this app's format)
    const { id, createdAt, ...rest } = data;
    environments = [rest];
  } else if (data.name) {
    // Single collection by name (this app's format)
    const { id, createdAt, ...rest } = data;
    collections = [rest];
  } else {
    throw new Error('Unrecognized format. Supported: this app\'s JSON, Postman Collection/Environment v2.x, or Insomnia v4');
  }

  // Import collections
  for (const col of collections) {
    await apiCall('/api/collections', { method: 'POST', body: col });
  }
  
  // Import environments
  for (const env of environments) {
    await apiCall('/api/environments', { method: 'POST', body: env });
  }
  
  const total = collections.length + environments.length;
  if (environments.length > 0 && collections.length === 0) {
    return { count: environments.length, type: 'environment' };
  }
  return { count: collections.length, type: 'collection' };
}

// ===== Script Engine =====
function buildExpect(val) {
  const fail = (msg) => { throw new Error(msg); };
  const chain = {};

  const makeHave = () => ({
    status:     code   => { if (val !== code) fail(`Expected status ${val} to be ${code}`); return chain; },
    property:   prop   => { if (!val || !(prop in Object(val))) fail(`Expected object to have property "${prop}"`); return chain; },
    lengthOf:   len    => { if ((val?.length ?? -1) !== len) fail(`Expected length ${val?.length} to be ${len}`); return chain; },
  });

  const makeBe = () => ({
    a:          type   => { if (typeof val !== type) fail(`Expected ${typeof val} to be ${type}`); return chain; },
    ok:         ()     => { if (!val) fail(`Expected value to be truthy`); return chain; },
    null:       ()     => { if (val !== null) fail(`Expected value to be null`); return chain; },
    above:      n      => { if (!(val > n)) fail(`Expected ${val} to be above ${n}`); return chain; },
    below:      n      => { if (!(val < n)) fail(`Expected ${val} to be below ${n}`); return chain; },
  });

  chain.to = {
    equal:   expected => { if (val !== expected)   fail(`Expected ${JSON.stringify(val)} to equal ${JSON.stringify(expected)}`); return chain; },
    include: expected => { if (!String(val).includes(String(expected))) fail(`Expected "${val}" to include "${expected}"`); return chain; },
    have:    makeHave(),
    be:      makeBe(),
    not: {
      equal:   expected => { if (val === expected)  fail(`Expected not to equal ${JSON.stringify(expected)}`); return chain; },
      include: expected => { if (String(val).includes(String(expected))) fail(`Expected "${val}" not to include "${expected}"`); return chain; },
    },
  };
  return chain;
}

function buildPmContext(type, reqData, respData) {
  const logs = [];
  const tests = [];
  
  // Track pending sendRequest calls for callback-style usage
  const pendingRequests = [];

  const envGet = (key) => {
    if (!state.activeEnvId) return '';
    const env = state.environments.find(e => e.id === state.activeEnvId);
    return (env?.variables || []).find(v => v.key === key)?.value ?? '';
  };

  const envSet = (key, value) => {
    if (!state.activeEnvId) {
      console.warn('[pm.environment.set] No active environment selected');
      logs.push({ level: 'warn', msg: `[pm.environment.set] No active environment - cannot set "${key}"` });
      return;
    }
    const env = state.environments.find(e => e.id === state.activeEnvId);
    if (!env) {
      console.warn('[pm.environment.set] Environment not found:', state.activeEnvId);
      logs.push({ level: 'warn', msg: `[pm.environment.set] Environment not found` });
      return;
    }
    if (!env.variables) env.variables = [];
    const existing = env.variables.find(v => v.key === key);
    const oldValue = existing?.value;
    if (existing) existing.value = String(value);
    else env.variables.push({ key, value: String(value) });
    
    // Log the update
    const shortValue = String(value).length > 50 ? String(value).substring(0, 50) + '...' : String(value);
    logs.push({ level: 'info', msg: `[env] ${key} = ${shortValue}` });
    
    // Fire-and-forget save with error logging
    fetch(`/api/environments/${state.activeEnvId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: env.name, variables: env.variables }),
    }).then(res => {
      if (!res.ok) {
        console.error('[pm.environment.set] Save failed:', res.status);
      }
    }).catch(err => {
      console.error('[pm.environment.set] Save error:', err);
    });
  };

  const pm = {
    environment: { get: envGet, set: envSet },
    // Alias: pm.collectionVariables → pm.environment (Insomnia compatibility)
    collectionVariables: { get: envGet, set: envSet },
    variables: {
      get: k => state.scriptVars[k] ?? '',
      set: (k, v) => { state.scriptVars[k] = String(v); },
    },
    test: (name, fn) => {
      try { fn(); tests.push({ name, passed: true }); }
      catch (e) { tests.push({ name, passed: false, error: e.message }); }
    },
    expect: buildExpect,
    utils: {
      uuid:           generateUUID,
      timestamp:      () => Math.floor(Date.now() / 1000),
      isoTimestamp:   () => new Date().toISOString(),
      epochMs:        () => Date.now(),
      formatTimestamp:(fmt, d) => formatTimestamp(d || new Date(), fmt),
    },
    // pm.sendRequest — make HTTP calls from scripts (Postman/Insomnia compatible)
    // Supports both callback style: pm.sendRequest(config, callback)
    // and async style: await pm.sendRequest(config)
    sendRequest: (config, callback) => {
      const doRequest = async () => {
        const reqMethod = (config.method || 'GET').toUpperCase();
        const reqUrl = config.url;
        
        const headers = {};
        if (config.header) {
          if (Array.isArray(config.header)) {
            config.header.forEach(h => { if (h.key) headers[h.key] = h.value; });
          } else {
            Object.assign(headers, config.header);
          }
        }

        let body = '', bodyType = 'none';
        if (config.body) {
          if (config.body.mode === 'raw') {
            body = config.body.raw || '';
            const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
            bodyType = ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : body.trim() ? 'text' : 'none';
          } else if (config.body.mode === 'urlencoded') {
            body = (config.body.urlencoded || []).filter(p => p.key)
              .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
            bodyType = 'form';
          } else if (config.body.mode === 'json') {
            body = typeof config.body.json === 'string' ? config.body.json : JSON.stringify(config.body.json);
            bodyType = 'json';
          }
        }

        // Log the outgoing request
        const shortUrl = reqUrl.length > 60 ? reqUrl.substring(0, 60) + '...' : reqUrl;
        logs.push({ level: 'info', msg: `[→ ${reqMethod}] ${shortUrl}` });

        const res = await fetch('/api/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method:   reqMethod,
            url:      reqUrl,
            headers,  body,  bodyType,
            timeout:  config.timeout || 30,
          }),
        });

        const data = await res.json();
        
        if (data.error) {
          logs.push({ level: 'error', msg: `[← ERROR] ${data.error}` });
          throw new Error(data.error);
        }

        // Log the response with status and preview
        const statusClass = data.status >= 200 && data.status < 300 ? 'info' : 
                            data.status >= 400 ? 'error' : 'warn';
        let bodyPreview = '';
        if (data.body) {
          bodyPreview = data.body.length > 100 ? data.body.substring(0, 100) + '...' : data.body;
          // Try to parse and show key info from JSON
          try {
            const json = JSON.parse(data.body);
            if (json.access_token) bodyPreview = `token: ${json.access_token.substring(0, 20)}...`;
            else if (json.error) bodyPreview = `error: ${json.error}`;
            else if (json.message) bodyPreview = `message: ${json.message}`;
          } catch {}
        }
        logs.push({ level: statusClass, msg: `[← ${data.status}] ${bodyPreview || '(empty)'}` });

        return {
          code:       data.status,
          status:     data.status,
          statusText: data.statusText || '',
          headers:    data.headers || {},
          body:       data.body || '',
          json:  () => { try { return JSON.parse(data.body); } catch { return null; } },
          text:  () => data.body || '',
        };
      };

      // If callback is provided, use callback style (Postman compatible)
      if (typeof callback === 'function') {
        const requestPromise = doRequest()
          .then(response => {
            callback(null, response);
            return response;
          })
          .catch(err => {
            callback(err, null);
            throw err;
          });
        // Track this pending request so we can wait for it
        pendingRequests.push(requestPromise.catch(() => {})); // Catch to prevent unhandled rejection
        return; // Don't return a promise in callback mode
      }
      
      // Otherwise return a promise for async/await style
      return doRequest();
    },
  };

  if (type === 'pre') {
    pm.request = {
      url:    reqData.url || '',
      method: reqData.method || 'GET',
      headers: {
        // Case-insensitive get (handles X-Token-Key, x-token-key, etc.)
        get: k => {
          const kl = k.toLowerCase();
          const all = { ...reqData.headers, ...(reqData.extraHeaders || {}) };
          for (const [hk, hv] of Object.entries(all)) {
            if (hk.toLowerCase() === kl) return hv;
          }
          return '';
        },
        add: ({ key, value }) => {
          if (!reqData.extraHeaders) reqData.extraHeaders = {};
          reqData.extraHeaders[key] = value;
        },
        // Remove header (marks for removal, applied after script runs)
        remove: (name) => {
          if (!reqData.removedHeaders) reqData.removedHeaders = new Set();
          reqData.removedHeaders.add(name.toLowerCase());
        },
      },
      // Insomnia-style setHeader / removeHeader aliases
      setHeader:    (key, value) => pm.request.headers.add({ key, value }),
      removeHeader: (name) => pm.request.headers.remove(name),
      body: {
        raw:  reqData.rawBody || reqData.body || '',
        mode: reqData.bodyType || 'none',
        // For direct access as string (backward compatibility)
        toString: function() { return this.raw; },
      },
    };
  }

  if (type === 'post' && respData) {
    pm.response = {
      code:         respData.status,
      status:       respData.status,
      responseTime: respData.duration,
      text:         () => respData.body || '',
      json:         () => { try { return JSON.parse(respData.body || 'null'); } catch { return null; } },
      headers:      { get: k => (respData.headers || {})[k.toLowerCase()] ?? '' },
    };
  }

  const consoleMock = {
    log:   (...a) => logs.push({ level: 'log',   msg: a.map(x => typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x)).join(' ') }),
    error: (...a) => logs.push({ level: 'error', msg: a.map(x => String(x)).join(' ') }),
    warn:  (...a) => logs.push({ level: 'warn',  msg: a.map(x => String(x)).join(' ') }),
    info:  (...a) => logs.push({ level: 'info',  msg: a.map(x => String(x)).join(' ') }),
  };

  return { pm, console: consoleMock, logs, tests, pendingRequests };
}

function runScriptSafe(script, pm, consoleMock) {
  try {
    // Wrap in async IIFE so scripts can use await/Promise
    const fn = new Function('pm', 'console', `"use strict";\nreturn (async function() {\n${script}\n})();`);
    const result = fn(pm, consoleMock);
    // Return the promise — callers must await this
    return result instanceof Promise ? result.catch(e => e) : Promise.resolve(null);
  } catch (e) {
    return Promise.resolve(e);
  }
}

async function executePreScript(reqData, scriptOverride) {
  const script = (scriptOverride !== undefined && scriptOverride !== null)
    ? scriptOverride.trim()
    : (window.getScriptEditorValue ? window.getScriptEditorValue('prescript') : document.getElementById('prescript-input')?.value || '').trim();
  if (!script) return { logs: [], tests: [] };

  const ctx = buildPmContext('pre', reqData);
  const err = await runScriptSafe(script, ctx.pm, ctx.console);
  if (err) ctx.logs.push({ level: 'error', msg: 'Pre-script error: ' + (err.message || err) });

  // Wait for any pending sendRequest callbacks to complete
  if (ctx.pendingRequests && ctx.pendingRequests.length > 0) {
    ctx.logs.push({ level: 'info', msg: `[script] Waiting for ${ctx.pendingRequests.length} pending request(s)...` });
    await Promise.all(ctx.pendingRequests);
  }

  // Apply extra headers added by script
  if (reqData.extraHeaders) { Object.assign(reqData.headers, reqData.extraHeaders); delete reqData.extraHeaders; }
  // Apply removed headers
  if (reqData.removedHeaders) {
    Object.keys(reqData.headers).forEach(k => {
      if (reqData.removedHeaders.has(k.toLowerCase())) delete reqData.headers[k];
    });
    delete reqData.removedHeaders;
  }
  return { logs: ctx.logs, tests: ctx.tests };
}

async function executePostScript(reqData, respData) {
  const script = (window.getScriptEditorValue ? window.getScriptEditorValue('postscript') : document.getElementById('postscript-input')?.value || '').trim();
  if (!script) return { logs: [], tests: [] };

  const ctx = buildPmContext('post', reqData, respData);
  const err = await runScriptSafe(script, ctx.pm, ctx.console);
  if (err) ctx.logs.push({ level: 'error', msg: 'Post-script error: ' + (err.message || err) });
  return { logs: ctx.logs, tests: ctx.tests };
}

// ===== Console Rendering =====
function clearConsoleOutput() {
  const el = document.getElementById('console-output');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">No console output yet.<br/>Add <code>console.log()</code> or <code>pm.test()</code> to your scripts.</div>';
}

function renderConsole(colPreLogs, colPreTests, reqPreLogs, reqPreTests, postLogs, postTests, requestInfo = null) {
  const el = document.getElementById('console-output');
  if (!el) return;

  // Helper to render logs/tests content
  const renderItems = (logs, tests) => {
    let html = '';
    logs.forEach(l => {
      html += `<div class="console-log log-${l.level}">
        <span class="log-badge log-${l.level}">${l.level}</span>
        <pre class="log-msg">${escHtml(l.msg)}</pre>
      </div>`;
    });
    tests.forEach(t => {
      const cls = t.passed ? 'test-pass' : 'test-fail';
      const icon = t.passed ? '✓' : '✗';
      html += `<div class="console-test ${cls}">
        <span class="test-icon">${icon}</span>
        <span class="test-name">${escHtml(t.name)}</span>
        ${!t.passed && t.error ? `<span class="test-error">${escHtml(t.error)}</span>` : ''}
      </div>`;
    });
    return html;
  };

  // Helper to render request info
  const renderRequestInfo = (r) => {
    const safeHeaders = { ...r.headers };
    if (safeHeaders.Authorization) {
      safeHeaders.Authorization = safeHeaders.Authorization.substring(0, 20) + '...';
    }
    
    // Build full URL with params for display
    let displayUrl = r.url;
    if (r.params && Object.keys(r.params).length > 0) {
      const paramStr = Object.entries(r.params)
        .filter(([k]) => k)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      if (paramStr) {
        displayUrl += (displayUrl.includes('?') ? '&' : '?') + paramStr;
      }
    }
    
    let html = `<div class="console-request-info">`;
    html += `<div class="req-info-line"><span class="req-info-label">URL:</span> <span class="req-info-method method-${r.method}">${r.method}</span> <span class="req-info-url">${escHtml(displayUrl)}</span></div>`;
    
    const headerKeys = Object.keys(safeHeaders);
    if (headerKeys.length) {
      html += `<div class="req-info-line"><span class="req-info-label">Headers:</span></div>`;
      html += `<pre class="req-info-json">${escHtml(JSON.stringify(safeHeaders, null, 2))}</pre>`;
    }
    
    if (r.body && r.body.trim()) {
      html += `<div class="req-info-line"><span class="req-info-label">Body:</span></div>`;
      let bodyDisplay = r.body;
      try {
        const parsed = JSON.parse(r.body);
        bodyDisplay = JSON.stringify(parsed, null, 2);
      } catch {}
      html += `<pre class="req-info-json">${escHtml(bodyDisplay)}</pre>`;
    }
    
    html += `</div>`;
    return html;
  };

  // Build sections
  const sections = [];

  // Request Info section
  if (requestInfo) {
    sections.push({
      id: 'request',
      title: 'Request',
      content: renderRequestInfo(requestInfo),
      expanded: false // collapsed by default
    });
  }

  // Collection Pre-Script section
  if (colPreLogs.length || colPreTests.length) {
    sections.push({
      id: 'col-pre',
      title: 'Collection Pre-Script',
      content: renderItems(colPreLogs, colPreTests),
      expanded: false,
      count: colPreLogs.length + colPreTests.length
    });
  }

  // Request Pre-Script section
  if (reqPreLogs.length || reqPreTests.length) {
    sections.push({
      id: 'req-pre',
      title: 'Request Pre-Script',
      content: renderItems(reqPreLogs, reqPreTests),
      expanded: false,
      count: reqPreLogs.length + reqPreTests.length
    });
  }

  // Post-Response Script section
  if (postLogs.length || postTests.length) {
    sections.push({
      id: 'post',
      title: 'Post-Response Script',
      content: renderItems(postLogs, postTests),
      expanded: true, // expanded by default
      count: postLogs.length + postTests.length
    });
  }

  if (!sections.length) {
    el.innerHTML = '<div class="empty-state">No console output yet.<br/>Add <code>console.log()</code> or <code>pm.test()</code> to your scripts.</div>';
  } else {
    el.innerHTML = sections.map(sec => `
      <div class="console-section-wrap" data-section="${sec.id}">
        <div class="console-section-header ${sec.expanded ? 'expanded' : ''}" onclick="toggleConsoleSection('${sec.id}')">
          <span class="section-chevron">${sec.expanded ? '▼' : '▶'}</span>
          <span class="section-title">${sec.title}</span>
          ${sec.count ? `<span class="section-count">${sec.count}</span>` : ''}
        </div>
        <div class="console-section-body ${sec.expanded ? '' : 'collapsed'}">
          ${sec.content}
        </div>
      </div>
    `).join('');
  }

  // Update console tab badge
  const allTests = [...colPreTests, ...reqPreTests, ...postTests];
  const tabBtn = document.getElementById('res-tab-console');
  if (tabBtn) {
    if (allTests.length) {
      const failed = allTests.filter(t => !t.passed).length;
      const badge = failed > 0
        ? `<span class="tab-badge tab-fail">${failed} fail</span>`
        : `<span class="tab-badge tab-pass">${allTests.length} pass</span>`;
      tabBtn.innerHTML = `Console ${badge}`;
    } else {
      tabBtn.textContent = 'Console';
    }
  }
}

// Toggle console section expand/collapse
function toggleConsoleSection(sectionId) {
  const wrap = document.querySelector(`.console-section-wrap[data-section="${sectionId}"]`);
  if (!wrap) return;
  
  const header = wrap.querySelector('.console-section-header');
  const body = wrap.querySelector('.console-section-body');
  const chevron = wrap.querySelector('.section-chevron');
  
  const isExpanded = header.classList.contains('expanded');
  
  if (isExpanded) {
    header.classList.remove('expanded');
    body.classList.add('collapsed');
    chevron.textContent = '▶';
  } else {
    header.classList.add('expanded');
    body.classList.remove('collapsed');
    chevron.textContent = '▼';
  }
}

// Show loading state in Console
function setConsoleLoading(phase) {
  const el = document.getElementById('console-output');
  if (!el) return;
  
  const phases = {
    'pre-script': 'Running pre-scripts...',
    'request': 'Sending request...',
    'post-script': 'Running post-scripts...',
  };
  
  const message = phases[phase] || 'Processing...';
  
  el.innerHTML = `
    <div class="console-loading">
      <div class="console-loading-spinner"></div>
      <div class="console-loading-text">${message}</div>
    </div>
  `;
}

// Show loading state in Response body with custom message
function setResponseLoading(message) {
  // Hide all state elements
  const states = ['response-placeholder', 'response-content', 'response-loading', 'response-error'];
  states.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  
  // Show loading state
  const loadingEl = document.getElementById('response-loading');
  const phaseEl = document.getElementById('loading-phase');
  if (loadingEl) {
    loadingEl.classList.remove('hidden');
  }
  if (phaseEl) {
    phaseEl.textContent = message || 'Sending request...';
  }
  
  // Ensure res-body is visible
  const resBody = document.getElementById('res-body');
  if (resBody) resBody.classList.remove('hidden');
  
  // Activate Body tab
  document.querySelectorAll('.res-tab').forEach(t => t.classList.remove('active'));
  const bodyTab = document.querySelector('.res-tab[data-tab="res-body"]');
  if (bodyTab) bodyTab.classList.add('active');
  
  // Hide other response containers
  ['res-headers', 'res-console'].forEach(id => {
    const c = document.getElementById(id);
    if (c) c.classList.add('hidden');
  });
}

// ===== Send Request =====
async function sendRequest() {
  console.log('[sendRequest] START');
  // Outer guard: any unexpected throw shows an error instead of silent failure
  const btn = document.getElementById('btn-send');
  try {
    await _doSendRequest();
    console.log('[sendRequest] _doSendRequest completed');
  } catch (outerErr) {
    console.error('[sendRequest] outer catch:', outerErr);
    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    setResponseState('error', `Unexpected error: ${outerErr.message}`);
  }
}

async function _doSendRequest() {
  console.log('[_doSendRequest] START');
  const rawUrl = document.getElementById('url-input').value.trim();
  if (!rawUrl) { showToast('Please enter a URL', 'error'); return; }

  const method = document.getElementById('method-select').value;
  console.log('[_doSendRequest] method:', method, 'url:', rawUrl.substring(0, 50));


  // Collect params & headers
  // Only use params from Params tab - ignore any params in URL
  // This gives full control via the Params tab checkboxes
  const enabledParams = getKVPairs('params'); // Only enabled params
  
  // Build final params object from enabled params only - keep raw values for later resolution
  const params = {};
  const rawParams = {};
  enabledParams.forEach(({ key, value }) => {
    if (key) {
      rawParams[key] = value; // Store raw for re-resolution after pre-script
      params[resolveEnvVars(key)] = resolveEnvVars(value);
    }
  });

  // Keep raw header values for re-resolution after pre-script
  const headers = {};
  const rawHeaders = {};
  getKVPairs('headers').forEach(({ key, value }) => {
    if (key) {
      rawHeaders[key] = value; // Store raw for re-resolution after pre-script
      headers[resolveEnvVars(key)] = resolveEnvVars(value);
    }
  });

  // Auth
  const auth = { ...state.currentRequest.auth };
  if (auth.token)    auth.token    = resolveEnvVars(auth.token);
  if (auth.username) auth.username = resolveEnvVars(auth.username);
  if (auth.password) auth.password = resolveEnvVars(auth.password);
  if (auth.value)    auth.value    = resolveEnvVars(auth.value);

  // API key in query param
  if (auth.type === 'apikey' && auth.key && auth.value && auth.placement === 'query') {
    params[auth.key] = auth.value;
  }

  // Body
  const bodyType = state.currentRequest.bodyType;
  let body = '';
  let rawBody = '';
  if (bodyType === 'form') {
    body = getKVPairs('form').filter(p => p.key)
      .map(p => `${encodeURIComponent(resolveEnvVars(p.key))}=${encodeURIComponent(resolveEnvVars(p.value))}`).join('&');
    rawBody = body; // For form, raw is same as resolved at this point
  } else {
    // Strip comments before sending (// style comments)
    rawBody = window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || '');
    body = resolveEnvVars(stripComments(rawBody));
  }

  const timeout = parseInt(document.getElementById('timeout-input').value) || 30;
  
  // Remove query params from URL - we'll use params from Params tab instead
  // This ensures Params tab checkboxes fully control what gets sent
  let baseUrl = resolveEnvVars(rawUrl);
  const qIdx = baseUrl.indexOf('?');
  if (qIdx !== -1) {
    baseUrl = baseUrl.slice(0, qIdx);
  }
  const url = baseUrl;
  
  // Store the base URL (without query params) for re-resolution after pre-script
  const rawUrlBase = rawUrl.indexOf('?') !== -1 ? rawUrl.slice(0, rawUrl.indexOf('?')) : rawUrl;

  const reqData = { method, url, headers, params, body, bodyType, auth, timeout, rawUrl: rawUrlBase, rawHeaders, rawParams, rawBody };

  // ── Reset scriptVars once for this full request ──
  state.scriptVars = {};

  // Show loading state immediately in both Response and Console
  setResponseLoading('Running pre-scripts...');
  setConsoleLoading('pre-script');
  document.getElementById('btn-send').classList.add('loading');
  document.getElementById('btn-send').disabled = true;

  // ── Collection Pre-Script (runs before request pre-script) ──
  let colPreLogs = [], colPreTests = [];
  try {
    if (state.activeCollectionId) {
      const col = state.collections.find(c => c.id === state.activeCollectionId);
      if (col?.preScript?.trim()) {
        const colResult = await executePreScript(reqData, col.preScript);
        colPreLogs  = colResult.logs;
        colPreTests = colResult.tests;
      }
    }
  } catch (e) {
    colPreLogs = [{ level: 'error', msg: 'Collection pre-script crashed: ' + e.message }];
  }

  // ── Request Pre-Script ──
  let preLogs = [], preTests = [];
  try {
    const result = await executePreScript(reqData);
    preLogs  = result.logs;
    preTests = result.tests;
  } catch (e) {
    preLogs = [{ level: 'error', msg: 'Pre-script crashed: ' + e.message }];
  }

  // Re-resolve after pre-script (scriptVars and env vars may have been set)
  // Use raw values to re-resolve so new env values are picked up
  reqData.url = resolveEnvVars(reqData.rawUrl || rawUrl);
  
  // Re-resolve headers from raw values after pre-script
  reqData.headers = {};
  Object.entries(reqData.rawHeaders || rawHeaders).forEach(([key, value]) => {
    if (key) reqData.headers[resolveEnvVars(key)] = resolveEnvVars(value);
  });
  
  // Re-resolve params from raw values after pre-script
  reqData.params = {};
  Object.entries(reqData.rawParams || rawParams).forEach(([key, value]) => {
    if (key) reqData.params[resolveEnvVars(key)] = resolveEnvVars(value);
  });
  
  // Re-resolve body from raw value after pre-script
  if (reqData.rawBody || rawBody) {
    if (bodyType === 'form') {
      // Form body - re-encode from raw pairs
      reqData.body = getKVPairs('form').filter(p => p.key)
        .map(p => `${encodeURIComponent(resolveEnvVars(p.key))}=${encodeURIComponent(resolveEnvVars(p.value))}`).join('&');
    } else {
      reqData.body = resolveEnvVars(stripComments(reqData.rawBody || rawBody));
    }
  }
  
  // Re-resolve auth after pre-script (from state which has raw values)
  const authRaw = state.currentRequest.auth || {};
  if (reqData.auth) {
    if (authRaw.token) reqData.auth.token = resolveEnvVars(authRaw.token);
    if (authRaw.username) reqData.auth.username = resolveEnvVars(authRaw.username);
    if (authRaw.password) reqData.auth.password = resolveEnvVars(authRaw.password);
    if (authRaw.value) reqData.auth.value = resolveEnvVars(authRaw.value);
  }

  // Update loading phase to "Sending request..."
  setResponseLoading('Sending request...');
  setConsoleLoading('request');

  let respData = null;
  try {
    // ── Check if Relay is enabled ──
    let finalReqData = reqData;
    if (state.relayEnabled && state.relayUrl) {
      // Wrap the original request into relay format
      // Build headers object from reqData.headers
      const headersObj = {};
      if (reqData.headers) {
        Object.entries(reqData.headers).forEach(([k, v]) => {
          if (k) headersObj[k] = v;
        });
      }
      // Add auth header if applicable
      if (reqData.auth?.type === 'bearer' && reqData.auth?.token) {
        headersObj['Authorization'] = `Bearer ${reqData.auth.token}`;
      } else if (reqData.auth?.type === 'basic' && reqData.auth?.username) {
        const creds = btoa(`${reqData.auth.username}:${reqData.auth.password || ''}`);
        headersObj['Authorization'] = `Basic ${creds}`;
      } else if (reqData.auth?.type === 'apikey' && reqData.auth?.key && reqData.auth?.value && reqData.auth?.placement === 'header') {
        headersObj[reqData.auth.key] = reqData.auth.value;
      }
      
      // Parse body to object if JSON
      let bodyPayload = reqData.body || '';
      if (reqData.bodyType === 'json' && bodyPayload) {
        try {
          bodyPayload = JSON.parse(bodyPayload);
        } catch (e) {
          // Keep as string if not valid JSON
        }
      }
      
      // Build full URL with params (avoid duplicates with existing URL params)
      let fullUrl = reqData.url;
      if (reqData.params && Object.keys(reqData.params).length > 0) {
        // Parse existing params from URL
        let existingParams = {};
        try {
          const urlObj = new URL(fullUrl);
          urlObj.searchParams.forEach((v, k) => { existingParams[k] = v; });
        } catch (e) {
          // URL might be relative or invalid, try to extract params manually
          const qIdx = fullUrl.indexOf('?');
          if (qIdx !== -1) {
            const qs = fullUrl.slice(qIdx + 1);
            qs.split('&').forEach(pair => {
              const [k, v] = pair.split('=').map(decodeURIComponent);
              if (k) existingParams[k] = v || '';
            });
          }
        }
        
        // Only add params not already in URL
        const newParams = Object.entries(reqData.params).filter(([k]) => k && !(k in existingParams));
        if (newParams.length > 0) {
          const sep = fullUrl.includes('?') ? '&' : '?';
          fullUrl += sep + newParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        }
      }
      
      const relayPayload = {
        method: reqData.method,
        url: fullUrl,
        headers: headersObj,
        body: bodyPayload
      };
      
      // Update reqData to point to relay URL
      finalReqData = {
        method: 'POST',
        url: state.relayUrl,
        headers: { 'Content-Type': 'application/json' },
        params: {},
        body: JSON.stringify(relayPayload),
        bodyType: 'json',
        auth: { type: 'none' },
        timeout: reqData.timeout
      };
      
      setResponseLoading('Sending via relay...');
    }
    
    const res = await fetch('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalReqData),
    });
    respData = await res.json();

    if (respData.error) {
      setResponseState('error', respData.error);
      showResponseMeta(null, null, null);
    } else {
      state.lastResponse = respData;
      try {
        renderResponse(respData);
      } catch (renderErr) {
        // Fallback: show raw if tree rendering fails
        setResponseState('content');
        showResponseMeta(respData.status, respData.duration, respData.size);
        const pre = document.getElementById('response-body-pre');
        const tree = document.getElementById('response-body-tree');
        if (tree) tree.classList.add('hidden');
        if (pre) { pre.classList.remove('hidden'); pre.textContent = respData.body || ''; }
        console.error('renderResponse error:', renderErr);
      }
      
      // Save response to history if we have an active saved request
      if (state.activeRequest?.reqId) {
        // Include console logs data for history
        const consoleData = {
          colPreLogs, colPreTests, preLogs, preTests,
          postLogs: [], postTests: [], // Will be updated after post-script
          requestInfo: reqData
        };
        saveResponseToHistory(state.activeRequest.reqId, respData, consoleData);
      }
    }

    await loadHistory();
    renderHistory();
  } catch (err) {
    setResponseState('error', err.message);
  } finally {
    document.getElementById('btn-send').classList.remove('loading');
    document.getElementById('btn-send').disabled = false;
  }

  // ── Post-Script ──
  // Only show loading in Console (don't override response body)
  setConsoleLoading('post-script');
  const { logs: postLogs, tests: postTests } = respData && !respData.error
    ? await executePostScript(reqData, respData)
    : { logs: [], tests: [] };

  // Render console (even if empty — clears old output)
  renderConsole(colPreLogs, colPreTests, preLogs, preTests, postLogs, postTests, reqData);
  
  // Update the latest history entry with post-script logs
  if (state.latestHistoryEntry && state.responseHistory.length > 0) {
    const entry = state.responseHistory[0];
    if (entry.id === state.latestHistoryEntry.id && entry.consoleLogs) {
      entry.consoleLogs.postLogs = postLogs;
      entry.consoleLogs.postTests = postTests;
      // Also update on server (fire and forget)
      if (state.activeRequest?.reqId) {
        fetch(`/api/requests/${state.activeRequest.reqId}/responses/${entry.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consoleLogs: entry.consoleLogs }),
        }).catch(e => console.error('Failed to update console logs:', e));
      }
    }
  }
}

// ===== JSON Tree Builder =====
function buildJsonTree(data, key, depth, isLast) {
  const type = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
  const wrap = document.createElement('div');
  wrap.className = 'jtree-node';

  if (type === 'object' || type === 'array') {
    const isObj  = type === 'object';
    const entries = isObj ? Object.entries(data) : data.map((v, i) => [i, v]);
    const count  = entries.length;
    const openB  = isObj ? '{' : '[';
    const closeB = isObj ? '}' : ']';

    // ── Opening line ──────────────────────────────
    const headerLine = document.createElement('div');
    headerLine.className = 'jtree-line jtree-expandable';
    headerLine.dataset.expanded = 'true';

    appendIndent(headerLine, depth);

    const toggleBtn = document.createElement('span');
    toggleBtn.className = 'jtree-toggle' + (count > 0 ? ' has-children' : '');
    toggleBtn.textContent = count > 0 ? '▾' : ' ';
    headerLine.appendChild(toggleBtn);

    if (key !== null) {
      const keyEl = mkSpan('jtree-key', `"${key}"`);
      const colonEl = mkSpan('jtree-punct', ': ');
      headerLine.appendChild(keyEl);
      headerLine.appendChild(colonEl);
    }

    const openEl = mkSpan('jtree-bracket', openB);
    headerLine.appendChild(openEl);

    // Inline preview shown when collapsed
    const preview = document.createElement('span');
    preview.className = 'jtree-preview';
    preview.style.display = 'none';
    preview.textContent = isObj
      ? (count === 0 ? ' }' : ` ${Object.keys(data).slice(0,3).join(', ')}${count>3?'…':''} }`)
      : (count === 0 ? ' ]' : ` ${count} item${count!==1?'s':''} ]`);
    headerLine.appendChild(preview);

    wrap.appendChild(headerLine);

    // ── Children ──────────────────────────────────
    const childrenEl = document.createElement('div');
    childrenEl.className = 'jtree-children';

    entries.forEach(([k, v], idx) => {
      childrenEl.appendChild(buildJsonTree(v, isObj ? k : null, depth + 1, idx === count - 1));
    });

    wrap.appendChild(childrenEl);

    // ── Closing bracket ───────────────────────────
    const closingLine = document.createElement('div');
    closingLine.className = 'jtree-line';
    appendIndent(closingLine, depth);
    closingLine.appendChild(mkSpan('jtree-toggle', ' '));
    closingLine.appendChild(mkSpan('jtree-bracket', closeB));
    if (!isLast) closingLine.appendChild(mkSpan('jtree-punct', ','));
    wrap.appendChild(closingLine);

    // ── Toggle collapse / expand ───────────────────
    if (count > 0) {
      headerLine.style.cursor = 'pointer';
      headerLine.addEventListener('click', (e) => {
        if (e.target.classList.contains('jtree-val') || e.target.classList.contains('jtree-key')) return;
        const expanded = headerLine.dataset.expanded !== 'false';
        const nowExpanded = !expanded;
        headerLine.dataset.expanded = String(nowExpanded);
        toggleBtn.textContent = nowExpanded ? '▾' : '▸';
        childrenEl.style.display = nowExpanded ? '' : 'none';
        closingLine.style.display = nowExpanded ? '' : 'none';
        preview.style.display     = nowExpanded ? 'none' : '';
        openEl.textContent        = nowExpanded ? openB : openB;
      });
    }

  } else {
    // ── Leaf node ──────────────────────────────────
    const line = document.createElement('div');
    line.className = 'jtree-line jtree-leaf';
    appendIndent(line, depth);
    line.appendChild(mkSpan('jtree-toggle', ' '));

    if (key !== null) {
      line.appendChild(mkSpan('jtree-key', `"${key}"`));
      line.appendChild(mkSpan('jtree-punct', ': '));
    }

    const cls = type === 'string' ? 'jtree-str'
              : type === 'number' ? 'jtree-num'
              : type === 'boolean' ? 'jtree-bool'
              : 'jtree-null';

    const valEl = mkSpan(`jtree-val ${cls}`, type === 'string' ? `"${data}"` : data === null ? 'null' : String(data));
    valEl.title = 'Click to copy';
    const rawVal = type === 'string' ? data : String(data);
    valEl.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(rawVal)
        .then(() => showToast(`Copied: ${String(rawVal).substring(0, 50)}${String(rawVal).length > 50 ? '…' : ''}`));
    });
    line.appendChild(valEl);
    if (!isLast) line.appendChild(mkSpan('jtree-punct', ','));
    wrap.appendChild(line);
  }

  return wrap;
}

function mkSpan(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function appendIndent(parent, depth) {
  const sp = document.createElement('span');
  sp.className = 'jtree-indent';
  sp.style.width = `${depth * 16}px`;
  parent.appendChild(sp);
}

// ── Expand / Collapse All ──────────────────────────
function setAllTreeNodes(expanded) {
  const tree = document.getElementById('response-body-tree');
  tree.querySelectorAll('.jtree-expandable.has-children, .jtree-expandable[data-expanded]').forEach(headerLine => {
    const isExpanded = headerLine.dataset.expanded !== 'false';
    if (isExpanded !== expanded) headerLine.click();
  });
}

// ── Search in tree ─────────────────────────────────
function searchInTree(query) {
  const tree = document.getElementById('response-body-tree');
  const countEl = document.getElementById('res-search-count');

  // Clear previous marks
  tree.querySelectorAll('mark.jtree-match').forEach(mark => {
    mark.replaceWith(document.createTextNode(mark.textContent));
  });

  if (!query || query.length < 1) {
    tree.querySelectorAll('.jtree-line').forEach(l => l.classList.remove('jtree-dim'));
    if (countEl) countEl.classList.add('hidden');
    return;
  }

  const qLower = query.toLowerCase();
  let matchCount = 0;

  tree.querySelectorAll('.jtree-key, .jtree-val').forEach(el => {
    const text = el.textContent;
    const idx  = text.toLowerCase().indexOf(qLower);
    if (idx === -1) return;

    matchCount++;

    // Wrap match in <mark>
    const before = text.slice(0, idx);
    const match  = text.slice(idx, idx + query.length);
    const after  = text.slice(idx + query.length);
    el.textContent = '';
    if (before) el.appendChild(document.createTextNode(before));
    const mark = document.createElement('mark');
    mark.className = 'jtree-match';
    mark.textContent = match;
    el.appendChild(mark);
    if (after) el.appendChild(document.createTextNode(after));

    // Auto-expand parent nodes
    let node = el.closest('.jtree-node');
    while (node) {
      const hdr = node.parentElement?.closest('.jtree-node')?.querySelector(':scope > .jtree-expandable');
      if (hdr && hdr.dataset.expanded === 'false') hdr.click();
      node = node.parentElement?.closest('.jtree-node');
    }
  });

  if (countEl) {
    countEl.textContent = matchCount > 0 ? `${matchCount} match${matchCount !== 1 ? 'es' : ''}` : 'No matches';
    countEl.className = `res-search-count ${matchCount > 0 ? 'match-found' : 'no-match'}`;
  }
}

// ===== Render Response =====
function renderResponse(data) {
  console.log('[renderResponse] START, data keys:', Object.keys(data || {}));
  setResponseState('content');
  showResponseMeta(data.status, data.duration, data.size);

  const tree = document.getElementById('response-body-tree');
  const pre  = document.getElementById('response-body-pre');
  const preWrap = document.querySelector('.response-pre-wrap');
  const ct   = (data.headers['content-type'] || '').toLowerCase();

  // Clear search
  const searchInput = document.getElementById('res-search-input');
  if (searchInput) searchInput.value = '';
  const countEl = document.getElementById('res-search-count');
  if (countEl) countEl.classList.add('hidden');
  
  // Clear filter
  const filterInput = document.getElementById('res-filter-input');
  const filterClear = document.getElementById('btn-filter-clear');
  if (filterInput) {
    filterInput.value = '';
    filterInput.classList.remove('has-filter');
  }
  if (filterClear) filterClear.classList.add('hidden');

  // Helper to update response line numbers
  function updateResponseLineNumbers(text) {
    const lineNumbers = document.getElementById('response-line-numbers');
    if (!lineNumbers) return;
    const lines = (text || '').split('\n').length || 1;
    let html = '';
    for (let i = 1; i <= lines; i++) {
      html += `<div>${i}</div>`;
    }
    lineNumbers.innerHTML = html;
  }

  // Sync scroll between pre and line numbers
  function syncResponseScroll() {
    const lineNumbers = document.getElementById('response-line-numbers');
    if (lineNumbers && pre) {
      lineNumbers.scrollTop = pre.scrollTop;
    }
  }
  pre.onscroll = syncResponseScroll;

  // Helper to show pre with line numbers
  function showPreWithLines(text, useHighlight = false) {
    tree.classList.add('hidden');
    tree.style.display = 'none';
    if (preWrap) preWrap.classList.add('visible');
    pre.classList.remove('hidden');
    pre.style.display = 'block';
    if (useHighlight) {
      pre.innerHTML = syntaxHighlight(text);
    } else {
      pre.textContent = text;
    }
    updateResponseLineNumbers(text);
  }

  // Helper to show tree (no line numbers)
  function showTree() {
    if (preWrap) preWrap.classList.remove('visible');
    pre.classList.add('hidden');
    pre.style.display = 'none';
    tree.classList.remove('hidden');
    tree.style.display = '';
    updateResponseLineNumbers('');
  }

  if (data.isBase64) {
    showPreWithLines('[Binary response — click Download to save]');
  } else if (state.responseView === 'raw') {
    // Raw view: show as-is with line numbers
    const isJson = ct.includes('json') || tryParseJson(data.body);
    if (isJson) {
      try {
        const parsed = JSON.parse(data.body);
        // Store parsed JSON for filter feature
        state.lastResponse.parsedJson = parsed;
        const formatted = JSON.stringify(parsed, null, 2);
        showPreWithLines(formatted, true);
      } catch {
        showPreWithLines(data.body);
      }
    } else {
      showPreWithLines(data.body);
    }
  } else {
    // Tree / Pretty mode
    const isJson = ct.includes('json') || tryParseJson(data.body);
    console.log('[renderResponse] isJson:', isJson, 'ct:', ct);
    if (isJson) {
      try {
        const parsed = JSON.parse(data.body);
        // Store parsed JSON for filter feature
        state.lastResponse.parsedJson = parsed;
        console.log('[renderResponse] JSON parsed OK, showing tree');
        showTree();
        tree.innerHTML = '';
        tree.appendChild(buildJsonTree(parsed, null, 0, true));
      } catch (e) {
        console.log('[renderResponse] JSON parse failed, showing pre:', e.message);
        showPreWithLines(data.body);
      }
    } else {
      // Non-JSON: plain or XML/HTML
      console.log('[renderResponse] not JSON, showing pre');
      if (ct.includes('xml') || ct.includes('html')) {
        tree.classList.add('hidden');
        tree.style.display = 'none';
        if (preWrap) preWrap.classList.add('visible');
        pre.classList.remove('hidden');
        pre.style.display = 'block';
        pre.innerHTML = escHtml(data.body);
        updateResponseLineNumbers(data.body);
      } else {
        showPreWithLines(data.body);
      }
    }
  }

  // Response headers table
  const entries = Object.entries(data.headers || {});
  document.getElementById('response-headers-table').innerHTML = `<div class="res-headers-table">
    ${entries.map(([k, v]) => `
      <div class="res-header-row">
        <span class="res-header-name">${escHtml(k)}</span>
        <span class="res-header-value">${escHtml(String(v))}</span>
      </div>`).join('')}
    ${!entries.length ? '<div class="empty-state">No headers</div>' : ''}
  </div>`;
}

function tryParseJson(s) { try { JSON.parse(s); return true; } catch { return false; } }

function setResponseState(st, msg) {
  console.log('[setResponseState] st:', st, 'msg:', msg);
  
  // Hide all state elements inside res-body
  const states = ['response-placeholder', 'response-content', 'response-loading', 'response-error'];
  states.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
    }
  });

  // Show the requested state
  const map = { loading: 'response-loading', content: 'response-content', error: 'response-error', idle: 'response-placeholder' };
  const targetId = map[st] || 'response-placeholder';
  const el = document.getElementById(targetId);
  console.log('[setResponseState] showing', targetId, !!el);
  if (el) {
    el.classList.remove('hidden');
    if (st === 'error' && msg) el.innerHTML = `<div class="error-icon">⚠️</div><div class="error-msg">${escHtml(msg)}</div>`;
  }
  
  // IMPORTANT: Ensure res-body container is visible and Body tab is active
  const resBody = document.getElementById('res-body');
  if (resBody) {
    resBody.classList.remove('hidden');
  }
  // Activate Body tab
  document.querySelectorAll('.res-tab').forEach(t => t.classList.remove('active'));
  const bodyTab = document.querySelector('.res-tab[data-tab="res-body"]');
  if (bodyTab) bodyTab.classList.add('active');
  // Hide other response containers
  ['res-headers', 'res-console'].forEach(id => {
    const c = document.getElementById(id);
    if (c) c.classList.add('hidden');
  });
}

// Show response metadata (status, time, size)
function showResponseMeta(status, duration, size) {
  console.log('[showResponseMeta]', { status, duration, size });
  const statusEl   = document.getElementById('response-status');
  const durationEl = document.getElementById('response-duration');
  const sizeEl     = document.getElementById('response-size');
  const metaRow    = document.getElementById('response-meta');

  if (!status && !duration && !size) {
    if (metaRow) metaRow.classList.add('hidden');
    return;
  }

  if (metaRow) metaRow.classList.remove('hidden');

  if (statusEl) {
    statusEl.textContent = status ? `${status}` : '';
    statusEl.className = 'res-status ' + (status >= 200 && status < 300 ? 'status-ok' : status >= 400 ? 'status-err' : 'status-warn');
  }
  if (durationEl) durationEl.textContent = duration != null ? `${duration} ms` : '';
  if (sizeEl)     sizeEl.textContent     = size != null ? formatBytes(size) : '';
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Syntax highlighting
function syntaxHighlight(json) {
  return json
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, m => {
      let cls = 'json-number';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-string';
      else if (/true|false/.test(m)) cls = 'json-bool';
      else if (/null/.test(m)) cls = 'json-null';
      return `<span class="${cls}">${m}</span>`;
    });
}

// ===== JSON Path Filter =====
// Extract value from JSON using dot notation path like: data.items[0].name
function getValueByPath(obj, path) {
  if (!path || !obj) return obj;
  
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(p => p);
  let current = obj;
  
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  
  return current;
}

// Get all possible paths from JSON object for autocomplete
function getAllPaths(obj, prefix = '', maxDepth = 5) {
  const paths = [];
  if (maxDepth <= 0) return paths;
  
  const type = obj === null ? 'null' : Array.isArray(obj) ? 'array' : typeof obj;
  
  if (type === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const valType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      paths.push({ path, type: valType });
      
      if (valType === 'object' || valType === 'array') {
        paths.push(...getAllPaths(value, path, maxDepth - 1));
      }
    }
  } else if (type === 'array' && obj.length > 0) {
    // Show first few array indices
    const limit = Math.min(obj.length, 3);
    for (let i = 0; i < limit; i++) {
      const path = `${prefix}[${i}]`;
      const valType = obj[i] === null ? 'null' : Array.isArray(obj[i]) ? 'array' : typeof obj[i];
      paths.push({ path, type: valType });
      
      if (valType === 'object' || valType === 'array') {
        paths.push(...getAllPaths(obj[i], path, maxDepth - 1));
      }
    }
    // Also suggest [*] for all items
    if (obj.length > 0) {
      const firstItem = obj[0];
      const firstType = firstItem === null ? 'null' : Array.isArray(firstItem) ? 'array' : typeof firstItem;
      paths.push({ path: `${prefix}[*]`, type: `${firstType}[]` });
    }
  }
  
  return paths;
}

// Apply filter to get all matching values for [*] syntax
function applyFilterWithWildcard(obj, path) {
  if (!path.includes('[*]')) {
    return getValueByPath(obj, path);
  }
  
  // Handle [*] - get all array items
  const parts = path.split('[*]');
  let current = getValueByPath(obj, parts[0].replace(/\.$/, ''));
  
  if (!Array.isArray(current)) return undefined;
  
  const restPath = parts[1]?.replace(/^\./, '');
  if (!restPath) return current;
  
  // Map over array items and get nested values
  return current.map(item => getValueByPath(item, restPath)).filter(v => v !== undefined);
}

// Setup JSON Path filter event listeners
function setupJsonPathFilter() {
  const filterInput = document.getElementById('res-filter-input');
  const filterClear = document.getElementById('btn-filter-clear');
  const suggestBox = document.getElementById('res-filter-suggest');
  
  if (!filterInput) return;
  
  let selectedSuggestIndex = -1;
  let currentPaths = [];
  
  // Store original response for filtering
  let originalTree = null;
  
  filterInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    // Show/hide clear button
    filterClear.classList.toggle('hidden', !query);
    filterInput.classList.toggle('has-filter', !!query);
    
    // Show suggestions
    if (state.lastResponse?.parsedJson) {
      currentPaths = getAllPaths(state.lastResponse.parsedJson);
      const filtered = query 
        ? currentPaths.filter(p => p.path.toLowerCase().includes(query.toLowerCase()))
        : currentPaths.slice(0, 20);
      
      showSuggestions(filtered.slice(0, 15));
    }
    
    // Apply filter with debounce
    clearTimeout(filterInput._debounce);
    filterInput._debounce = setTimeout(() => applyFilter(query), 300);
  });
  
  filterInput.addEventListener('focus', () => {
    if (state.lastResponse?.parsedJson && !filterInput.value) {
      currentPaths = getAllPaths(state.lastResponse.parsedJson);
      showSuggestions(currentPaths.slice(0, 15));
    }
  });
  
  filterInput.addEventListener('blur', () => {
    // Delay hiding to allow click on suggestion
    setTimeout(() => suggestBox.classList.add('hidden'), 150);
  });
  
  filterInput.addEventListener('keydown', (e) => {
    const items = suggestBox.querySelectorAll('.res-filter-suggest-item');
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedSuggestIndex = Math.min(selectedSuggestIndex + 1, items.length - 1);
      updateSuggestSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedSuggestIndex = Math.max(selectedSuggestIndex - 1, -1);
      updateSuggestSelection(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedSuggestIndex >= 0 && items[selectedSuggestIndex]) {
        selectSuggestion(items[selectedSuggestIndex].dataset.path);
      } else {
        applyFilter(filterInput.value.trim());
        suggestBox.classList.add('hidden');
      }
    } else if (e.key === 'Escape') {
      suggestBox.classList.add('hidden');
      selectedSuggestIndex = -1;
    }
  });
  
  filterClear.addEventListener('click', () => {
    filterInput.value = '';
    filterInput.classList.remove('has-filter');
    filterClear.classList.add('hidden');
    applyFilter('');
  });
  
  function showSuggestions(paths) {
    if (!paths.length) {
      suggestBox.classList.add('hidden');
      return;
    }
    
    suggestBox.innerHTML = paths.map(p => `
      <div class="res-filter-suggest-item" data-path="${escHtml(p.path)}">
        <span class="path">${escHtml(p.path)}</span>
        <span class="type">${p.type}</span>
      </div>
    `).join('');
    
    suggestBox.querySelectorAll('.res-filter-suggest-item').forEach(item => {
      item.addEventListener('click', () => selectSuggestion(item.dataset.path));
    });
    
    suggestBox.classList.remove('hidden');
    selectedSuggestIndex = -1;
  }
  
  function updateSuggestSelection(items) {
    items.forEach((item, i) => {
      item.classList.toggle('selected', i === selectedSuggestIndex);
    });
  }
  
  function selectSuggestion(path) {
    filterInput.value = path;
    filterInput.classList.add('has-filter');
    filterClear.classList.remove('hidden');
    suggestBox.classList.add('hidden');
    applyFilter(path);
    filterInput.focus();
  }
  
  function applyFilter(path) {
    if (!state.lastResponse?.parsedJson) return;
    
    const treeContainer = document.getElementById('response-body-tree');
    const preEl = document.getElementById('response-body-pre');
    
    if (!path) {
      // Show full response
      treeContainer.innerHTML = '';
      treeContainer.appendChild(buildJsonTree(state.lastResponse.parsedJson, null, 0, true));
      if (preEl) preEl.innerHTML = syntaxHighlight(JSON.stringify(state.lastResponse.parsedJson, null, 2));
      return;
    }
    
    try {
      const filtered = applyFilterWithWildcard(state.lastResponse.parsedJson, path);
      
      if (filtered === undefined) {
        treeContainer.innerHTML = '<div class="empty-state">No match for path: ' + escHtml(path) + '</div>';
        if (preEl) preEl.textContent = '';
        return;
      }
      
      treeContainer.innerHTML = '';
      treeContainer.appendChild(buildJsonTree(filtered, null, 0, true));
      if (preEl) preEl.innerHTML = syntaxHighlight(JSON.stringify(filtered, null, 2));
    } catch (e) {
      treeContainer.innerHTML = '<div class="empty-state">Invalid path: ' + escHtml(e.message) + '</div>';
    }
  }
}

// ===== KV Rows =====
function createKVRow(containerId, key = '', value = '', enabled = true) {
  const container = document.getElementById(`${containerId}-list`);
  if (!container) return;
  
  // Form and env-vars don't need checkboxes
  const noCheckbox = containerId === 'form' || containerId === 'env-vars';
  // env-vars doesn't need variable highlighting (it stores actual values, not templates)
  const skipVarHighlight = containerId === 'env-vars';
  
  const row = document.createElement('div');
  row.className = 'kv-row' + (noCheckbox ? '' : (enabled ? '' : ' disabled'));
  if (noCheckbox) row.classList.add('no-checkbox');
  
  if (skipVarHighlight) {
    // Simple row without variable highlighting overlay
    row.innerHTML = `
      <input class="kv-input" type="text" placeholder="Key"   value="${escHtml(key)}"   />
      <input class="kv-input" type="text" placeholder="Value" value="${escHtml(value)}" />
      <button class="kv-delete" title="Remove">×</button>`;
  } else if (noCheckbox) {
    row.innerHTML = `
      <input class="kv-input" type="text" placeholder="Key"   value="${escHtml(key)}"   />
      <div class="kv-value-wrap">
        <input class="kv-input kv-value-input" type="text" placeholder="Value" value="${escHtml(value)}" />
        <div class="kv-value-overlay"></div>
        <button class="kv-expand-btn" title="Expand value">⤢</button>
      </div>
      <button class="kv-delete" title="Remove">×</button>`;
  } else {
    row.innerHTML = `
      <input class="kv-checkbox" type="checkbox" ${enabled ? 'checked' : ''} title="Enable/Disable" />
      <input class="kv-input" type="text" placeholder="Key"   value="${escHtml(key)}"   />
      <div class="kv-value-wrap">
        <input class="kv-input kv-value-input" type="text" placeholder="Value" value="${escHtml(value)}" />
        <div class="kv-value-overlay"></div>
        <button class="kv-expand-btn" title="Expand value">⤢</button>
      </div>
      <button class="kv-delete" title="Remove">×</button>`;
    row.querySelector('.kv-checkbox').addEventListener('change', (e) => {
      row.classList.toggle('disabled', !e.target.checked);
      // Sync URL if this is a params row
      if (containerId === 'params') syncParamsToUrl();
    });
  }
  
  // Setup variable highlighting for value input (skip for env-vars)
  if (!skipVarHighlight) {
    const valueInput = row.querySelector('.kv-value-input');
    const overlay = row.querySelector('.kv-value-overlay');
    if (valueInput && overlay) {
      setupVariableHighlight(valueInput, overlay);
    }
    
    // Setup expand button
    const expandBtn = row.querySelector('.kv-expand-btn');
    if (expandBtn && valueInput) {
      expandBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openValueExpandModal(valueInput);
      });
    }
  }
  
  row.querySelector('.kv-delete').addEventListener('click', () => {
    row.remove();
    // Sync URL if this is a params row
    if (containerId === 'params') syncParamsToUrl();
  });
  
  // Add input listeners for params to sync URL
  if (containerId === 'params') {
    row.querySelectorAll('.kv-input').forEach(input => {
      input.addEventListener('input', () => syncParamsToUrl());
    });
    // Checkbox change should also sync
    const checkbox = row.querySelector('.kv-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', () => syncParamsToUrl());
    }
  }
  
  container.appendChild(row);
}

// Sync params tab to URL input
function syncParamsToUrl() {
  const urlInput = document.getElementById('url-input');
  if (!urlInput) return;
  
  const currentUrl = urlInput.value;
  
  // Get base URL (without query string)
  let baseUrl = currentUrl;
  const qIdx = currentUrl.indexOf('?');
  if (qIdx !== -1) {
    baseUrl = currentUrl.slice(0, qIdx);
  }
  
  // Get enabled params from params tab
  const params = getKVPairs('params').filter(p => p.key);
  
  // Build new URL
  if (params.length > 0) {
    const queryString = params.map(p => {
      // Don't encode if contains variables like {{var}}
      const key = p.key.includes('{{') ? p.key : encodeURIComponent(p.key);
      const val = p.value.includes('{{') ? p.value : encodeURIComponent(p.value);
      return `${key}=${val}`;
    }).join('&');
    urlInput.value = `${baseUrl}?${queryString}`;
  } else {
    urlInput.value = baseUrl;
  }
}

// Open modal to expand/edit long value
function openValueExpandModal(input) {
  let modal = document.getElementById('modal-value-expand');
  if (!modal) {
    // Create modal if not exists
    modal = document.createElement('div');
    modal.id = 'modal-value-expand';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-box modal-medium">
        <div class="modal-header">
          <h3>Edit Value</h3>
          <button class="modal-close" data-modal="modal-value-expand">×</button>
        </div>
        <div class="modal-body">
          <textarea id="value-expand-textarea" class="code-editor value-expand-editor" rows="10" placeholder="Enter value..."></textarea>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" data-modal="modal-value-expand">Cancel</button>
          <button class="btn-primary" id="btn-value-expand-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    
    // Close button handlers
    modal.querySelectorAll('[data-modal]').forEach(btn => {
      btn.addEventListener('click', () => closeModal('modal-value-expand'));
    });
    
    // Click outside to close
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal('modal-value-expand');
    });
  }
  
  const textarea = document.getElementById('value-expand-textarea');
  textarea.value = input.value;
  
  // Remove old save handler and add new one
  const saveBtn = document.getElementById('btn-value-expand-save');
  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  
  newSaveBtn.addEventListener('click', () => {
    input.value = textarea.value;
    // Trigger input event to update overlay
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeModal('modal-value-expand');
  });
  
  openModal('modal-value-expand');
  setTimeout(() => textarea.focus(), 100);
}

// Highlight {{variables}} in input and show tooltip with resolved value
function setupVariableHighlight(input, overlay) {
  // Create tooltip element (shared)
  let tooltip = document.getElementById('var-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'var-tooltip';
    tooltip.className = 'var-tooltip';
    document.body.appendChild(tooltip);
  }
  
  function updateOverlay() {
    const value = input.value;
    if (!value) {
      overlay.innerHTML = '';
      return;
    }
    
    // Find all {{...}} patterns and highlight them
    let html = escHtml(value).replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
      const resolved = resolveVariable(varName.trim());
      // Check if resolved value exists (not undefined, not null, not empty string)
      const hasValue = resolved !== undefined && resolved !== null && String(resolved) !== '';
      const cls = hasValue ? 'var-resolved' : 'var-unresolved';
      const tooltipText = hasValue ? String(resolved) : '(undefined)';
      return `<span class="kv-var ${cls}" data-var-tooltip="${escHtml(tooltipText)}">${match}</span>`;
    });
    
    overlay.innerHTML = html;
    
    // Attach hover handlers to variable spans
    overlay.querySelectorAll('.kv-var').forEach(span => {
      span.addEventListener('mouseenter', (e) => {
        const text = span.getAttribute('data-var-tooltip');
        tooltip.textContent = text;
        tooltip.classList.add('visible');
        const rect = span.getBoundingClientRect();
        tooltip.style.left = rect.left + rect.width / 2 + 'px';
        tooltip.style.top = rect.top - 4 + 'px';
      });
      span.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
      });
    });
  }
  
  // Store the update function on the input for external refresh
  input._updateVarOverlay = updateOverlay;
  
  input.addEventListener('input', updateOverlay);
  input.addEventListener('focus', updateOverlay);
  // Initial update
  setTimeout(updateOverlay, 0);
}

// Refresh all variable overlays (call when environment changes)
function refreshAllVariableOverlays() {
  document.querySelectorAll('.kv-value-input').forEach(input => {
    if (input._updateVarOverlay) {
      input._updateVarOverlay();
    }
  });
}

// Resolve a variable name to its value (for highlighting only)
function resolveVariable(varName) {
  // Check built-in dynamic vars first (case-insensitive)
  if (varName.startsWith('$')) {
    const lowerName = varName.toLowerCase();
    switch (lowerName) {
      case '$timestamp': return String(Math.floor(Date.now() / 1000));
      case '$epochms': return String(Date.now());
      case '$isotimestamp': return new Date().toISOString();
      case '$uuid':
      case '$randomuuid': return '(UUID)';
      case '$randomint': return '(0-999)';
    }
    if (lowerName.startsWith('$timestampformat:')) {
      return '(formatted)';
    }
    // Unknown $ variable - still treat as unresolved
    return undefined;
  }
  
  // For non-$ variables: ONLY resolve if env is active
  // Check script vars first (from pre-request scripts)
  if (state.scriptVars && Object.prototype.hasOwnProperty.call(state.scriptVars, varName)) {
    const val = state.scriptVars[varName];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  
  // Check active environment - ONLY if an environment is actually selected
  if (state.activeEnvId && state.environments) {
    const env = state.environments.find(e => e.id === state.activeEnvId);
    if (env && env.variables) {
      const found = env.variables.find(v => v.key === varName);
      if (found && found.value !== undefined && found.value !== null && found.value !== '') {
        return found.value;
      }
    }
  }
  
  // Not found - return undefined (will show as unresolved/yellow)
  return undefined;
}

function initKVRows(containerId, pairs = []) {
  const container = document.getElementById(`${containerId}-list`);
  if (!container) return;
  container.innerHTML = '';
  // Ensure pairs is an array
  const pairsArray = Array.isArray(pairs) ? pairs : [];
  pairsArray.forEach(p => createKVRow(containerId, p.key, p.value, p.enabled !== false));
}

function getKVPairs(containerId, includeDisabled = false) {
  const container = document.getElementById(`${containerId}-list`);
  if (!container) return [];
  return Array.from(container.querySelectorAll('.kv-row'))
    .map(row => {
      const checkbox = row.querySelector('.kv-checkbox');
      const [k, v] = row.querySelectorAll('.kv-input');
      const enabled = checkbox ? checkbox.checked : true;
      return { key: k.value, value: v.value, enabled };
    })
    .filter(p => includeDisabled || p.enabled);
}

// ===== Active Request Dirty Tracking =====
function captureFormState() {
  try {
    return {
      method:     document.getElementById('method-select')?.value || '',
      url:        document.getElementById('url-input')?.value || '',
      headers:    getKVPairs('headers', true),
      params:     getKVPairs('params', true),
      bodyType:   state.currentRequest?.bodyType || 'none',
      body:       window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || ''),
      auth:       JSON.parse(JSON.stringify(state.currentRequest?.auth || {})),
      preScript:  window.getScriptEditorValue ? window.getScriptEditorValue('prescript') : (document.getElementById('prescript-input')?.value || ''),
      postScript: window.getScriptEditorValue ? window.getScriptEditorValue('postscript') : (document.getElementById('postscript-input')?.value || ''),
    };
  } catch { return null; }
}

function checkDirty() {
  try {
    if (!state.activeRequest) { state.isDirty = false; updateDirtyIndicator(); return; }
    const snap = captureFormState();
    if (!snap) return;
    state.isDirty = JSON.stringify(snap) !== JSON.stringify(state.activeRequest.snapshot);
    updateDirtyIndicator();
  } catch { /* silent */ }
}

function updateDirtyIndicator() {
  try {
    const bar     = document.getElementById('request-context-bar');
    const dotEl   = document.getElementById('req-dirty-dot');
    const pathEl  = document.getElementById('req-context-path');
    const saveBtn = document.getElementById('btn-quick-save');
    const hintEl  = document.getElementById('req-context-hint');
    if (!bar) return;

    if (!state.activeRequest) { bar.classList.add('hidden'); return; }

    bar.classList.remove('hidden');
    if (pathEl) {
      const col = state.collections.find(c => c.id === state.activeRequest.colId);
      pathEl.innerHTML = '<span class="ctx-col">' + escHtml(col?.name || '?') + '</span> › <span class="ctx-req">' + escHtml(state.activeRequest.name) + '</span>';
    }
    if (dotEl)   dotEl.classList.toggle('hidden',  !state.isDirty);
    if (saveBtn) saveBtn.classList.toggle('hidden', !state.isDirty);
    if (hintEl)  hintEl.style.display = state.isDirty ? '' : 'none';
  } catch { /* silent */ }
}

async function quickSave() {
  if (!state.activeRequest || !state.isDirty) return;
  const { colId, reqId, name } = state.activeRequest;

  await apiCall(`/api/collections/${colId}/requests/${reqId}`, {
    method: 'PUT',
    body: {
      name,
      method:     document.getElementById('method-select').value,
      url:        document.getElementById('url-input').value,
      headers:    getKVPairs('headers', true),
      params:     getKVPairs('params', true),
      bodyType:   state.currentRequest.bodyType,
      body:       window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || ''),
      auth:       state.currentRequest.auth,
      preScript:  window.getScriptEditorValue ? window.getScriptEditorValue('prescript') : (document.getElementById('prescript-input')?.value || ''),
      postScript: window.getScriptEditorValue ? window.getScriptEditorValue('postscript') : (document.getElementById('postscript-input')?.value || ''),
    },
  });

  // Update snapshot → clean state
  state.activeRequest.snapshot = captureFormState();
  state.isDirty = false;
  // Remove from unsavedChanges map
  const reqKey = `${colId}:${reqId}`;
  delete state.unsavedChanges[reqKey];
  updateDirtyIndicator();
  await loadCollections();
  renderCollections();
  showToast(`✓ Saved: ${name}`);
}

// ===== Unsaved Changes Management =====
function getUnsavedKey(colId, reqId) {
  return `${colId}:${reqId}`;
}

function storeCurrentChangesIfDirty() {
  // Store current request changes to unsavedChanges map if dirty
  if (state.activeRequest && state.isDirty) {
    const { colId, reqId, name } = state.activeRequest;
    const key = getUnsavedKey(colId, reqId);
    const changes = captureFormState();
    if (changes) {
      state.unsavedChanges[key] = {
        colId,
        reqId,
        name,
        changes,
        snapshot: state.activeRequest.snapshot
      };
    }
  }
}

function restoreChangesIfExists(colId, reqId) {
  // Check if there are pending changes for this request
  const key = getUnsavedKey(colId, reqId);
  return state.unsavedChanges[key] || null;
}

function clearUnsavedChange(colId, reqId) {
  const key = getUnsavedKey(colId, reqId);
  delete state.unsavedChanges[key];
}

function getAllUnsavedChanges() {
  // Combine unsavedChanges map with current dirty request
  const result = { ...state.unsavedChanges };
  
  // Add current request if dirty and not already in map
  if (state.activeRequest && state.isDirty) {
    const { colId, reqId, name } = state.activeRequest;
    const key = getUnsavedKey(colId, reqId);
    if (!result[key]) {
      const changes = captureFormState();
      if (changes) {
        result[key] = { colId, reqId, name, changes, snapshot: state.activeRequest.snapshot };
      }
    }
  }
  
  return result;
}

function hasAnyUnsavedChanges() {
  const all = getAllUnsavedChanges();
  return Object.keys(all).length > 0;
}

function renderUnsavedList() {
  const container = document.getElementById('unsaved-list');
  const unsaved = getAllUnsavedChanges();
  const entries = Object.entries(unsaved);
  
  if (!entries.length) {
    container.innerHTML = '<div class="unsaved-empty">No unsaved changes</div>';
    return;
  }
  
  container.innerHTML = entries.map(([key, data]) => {
    const col = state.collections.find(c => c.id === data.colId);
    const colName = col?.name || 'Unknown Collection';
    const method = data.changes?.method || 'GET';
    
    return `
      <div class="unsaved-item" data-key="${key}">
        <input type="checkbox" class="unsaved-item-checkbox" checked />
        <div class="unsaved-item-info">
          <div class="unsaved-item-name">
            <span class="req-method-badge method-${method} bg-${method}" style="font-size:9px;width:32px">${method}</span>
            ${escHtml(data.name)}
          </div>
          <div class="unsaved-item-path">${escHtml(colName)}</div>
        </div>
        <div class="unsaved-item-actions">
          <button class="unsaved-save-btn" onclick="saveUnsavedItem('${key}')">Save</button>
          <button class="unsaved-ignore-btn" onclick="ignoreUnsavedItem('${key}')">Ignore</button>
        </div>
      </div>
    `;
  }).join('');
}

async function saveUnsavedItem(key) {
  const data = state.unsavedChanges[key];
  if (!data) {
    // Check if it's the current request
    if (state.activeRequest && state.isDirty) {
      const currentKey = getUnsavedKey(state.activeRequest.colId, state.activeRequest.reqId);
      if (currentKey === key) {
        await quickSave();
        renderUnsavedList();
        return;
      }
    }
    return;
  }
  
  const { colId, reqId, name, changes } = data;
  
  try {
    await apiCall(`/api/collections/${colId}/requests/${reqId}`, {
      method: 'PUT',
      body: {
        name,
        method:     changes.method,
        url:        changes.url,
        headers:    changes.headers,
        params:     changes.params,
        bodyType:   changes.bodyType,
        body:       changes.body,
        auth:       changes.auth,
        preScript:  changes.preScript,
        postScript: changes.postScript,
      },
    });
    
    delete state.unsavedChanges[key];
    showToast(`✓ Saved: ${name}`);
    renderUnsavedList();
    
    // Check if modal should close
    if (!hasAnyUnsavedChanges()) {
      closeModal('modal-unsaved');
    }
  } catch (err) {
    showToast(`Failed to save ${name}: ${err.message}`, true);
  }
}

function ignoreUnsavedItem(key) {
  delete state.unsavedChanges[key];
  
  // If ignoring current request
  if (state.activeRequest) {
    const currentKey = getUnsavedKey(state.activeRequest.colId, state.activeRequest.reqId);
    if (currentKey === key) {
      state.activeRequest.snapshot = captureFormState();
      state.isDirty = false;
      updateDirtyIndicator();
    }
  }
  
  renderUnsavedList();
  
  if (!hasAnyUnsavedChanges()) {
    closeModal('modal-unsaved');
  }
}

async function saveAllUnsaved() {
  const unsaved = getAllUnsavedChanges();
  const entries = Object.entries(unsaved);
  
  // Get only checked items
  const checkboxes = document.querySelectorAll('#unsaved-list .unsaved-item-checkbox');
  const keysToSave = [];
  checkboxes.forEach((cb, i) => {
    if (cb.checked && entries[i]) {
      keysToSave.push(entries[i][0]);
    }
  });
  
  for (const key of keysToSave) {
    await saveUnsavedItem(key);
  }
  
  return !hasAnyUnsavedChanges();
}

function showUnsavedModal(onComplete) {
  renderUnsavedList();
  openModal('modal-unsaved');
  
  // Store callback for reload action
  window._unsavedModalCallback = onComplete;
}

function setupUnsavedModalHandlers() {
  // Ignore & Reload button
  document.getElementById('btn-unsaved-ignore').addEventListener('click', () => {
    // Clear all unsaved changes
    state.unsavedChanges = {};
    if (state.activeRequest) {
      state.activeRequest.snapshot = captureFormState();
      state.isDirty = false;
    }
    closeModal('modal-unsaved');
    
    if (window._unsavedModalCallback) {
      window._unsavedModalCallback();
      window._unsavedModalCallback = null;
    } else {
      location.reload();
    }
  });
  
  // Save All & Reload button
  document.getElementById('btn-unsaved-save-all').addEventListener('click', async () => {
    const allSaved = await saveAllUnsaved();
    if (allSaved) {
      closeModal('modal-unsaved');
      if (window._unsavedModalCallback) {
        window._unsavedModalCallback();
        window._unsavedModalCallback = null;
      } else {
        location.reload();
      }
    }
  });
}

// ===== Collections =====
function openNewCollectionModal() {
  state.editingCollectionId = null;
  document.getElementById('modal-collection-title').textContent = 'New Collection';
  document.getElementById('collection-name-input').value = '';
  document.getElementById('collection-desc-input').value = '';
  document.getElementById('collection-prescript-input').value = '';
  if (window.updateCollectionPrescriptHighlights) window.updateCollectionPrescriptHighlights();
  document.getElementById('btn-confirm-collection').textContent = 'Create';
  document.getElementById('col-prescript-badge').classList.add('hidden');
  // Reset to Info tab
  document.querySelectorAll('.col-mtab').forEach(b => b.classList.toggle('active', b.dataset.ctab === 'cmtab-info'));
  document.querySelectorAll('.col-tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== 'cmtab-info'));
  openModal('modal-collection');
}

function openEditCollectionModal(colId) {
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;
  state.editingCollectionId = colId;
  document.getElementById('modal-collection-title').textContent = `Edit: ${col.name}`;
  document.getElementById('collection-name-input').value = col.name || '';
  document.getElementById('collection-desc-input').value = col.description || '';
  document.getElementById('collection-prescript-input').value = col.preScript || '';
  if (window.updateCollectionPrescriptHighlights) window.updateCollectionPrescriptHighlights();
  document.getElementById('btn-confirm-collection').textContent = 'Save';
  // Show pre-script badge if has script
  const hasPre = !!(col.preScript?.trim());
  document.getElementById('col-prescript-badge').classList.toggle('hidden', !hasPre);
  // If has pre-script, open on that tab
  const defaultTab = hasPre ? 'cmtab-prescript' : 'cmtab-info';
  document.querySelectorAll('.col-mtab').forEach(b => b.classList.toggle('active', b.dataset.ctab === defaultTab));
  document.querySelectorAll('.col-tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== defaultTab));
  openModal('modal-collection');
}

// ── Collection search helpers ────────────────────────────────────────────────
function hlMatch(text, query) {
  if (!query || !text) return escHtml(String(text || ''));
  const tl = text.toLowerCase();
  const ql = query.toLowerCase();
  let   out = '', i = 0;
  while (i < text.length) {
    const idx = tl.indexOf(ql, i);
    if (idx === -1) { out += escHtml(text.slice(i)); break; }
    out += escHtml(text.slice(i, idx));
    out += `<mark class="search-hl">${escHtml(text.slice(idx, idx + query.length))}</mark>`;
    i = idx + query.length;
  }
  return out;
}

function searchCollections(query) {
  const list   = document.getElementById('collections-list');
  const clearBtn = document.getElementById('btn-col-search-clear');
  clearBtn?.classList.toggle('hidden', !query);

  if (!query.trim()) { renderCollections(); return; }

  const q = query.toLowerCase();

  // Helper function to search requests in folders recursively
  function searchInFolder(folder, q) {
    const folderHit = (folder.name || '').toLowerCase().includes(q);
    const matchReqs = (folder.requests || []).filter(req =>
      (req.name || '').toLowerCase().includes(q) ||
      (req.url  || '').toLowerCase().includes(q) ||
      (req.method || '').toLowerCase().includes(q)
    );
    
    // Search in subfolders recursively
    const matchSubfolders = (folder.folders || []).map(sub => searchInFolder(sub, q)).filter(Boolean);
    
    if (!folderHit && !matchReqs.length && !matchSubfolders.length) return null;
    
    return {
      folder,
      folderHit,
      showReqs: folderHit ? (folder.requests || []) : matchReqs,
      showSubfolders: folderHit ? (folder.folders || []) : matchSubfolders.map(m => m.folder)
    };
  }

  const results = state.collections.map(col => {
    const colHit = col.name.toLowerCase().includes(q);
    
    // Search in direct requests
    const matchReqs = (col.requests || []).filter(req =>
      (req.name || '').toLowerCase().includes(q) ||
      (req.url  || '').toLowerCase().includes(q) ||
      (req.method || '').toLowerCase().includes(q)
    );
    
    // Search in folders recursively
    const matchFolders = (col.folders || []).map(folder => searchInFolder(folder, q)).filter(Boolean);
    
    if (!colHit && !matchReqs.length && !matchFolders.length) return null;
    
    return { 
      col, 
      colHit, 
      showReqs: colHit ? (col.requests || []) : matchReqs,
      showFolders: colHit ? (col.folders || []) : matchFolders.map(m => m.folder)
    };
  }).filter(Boolean);

  if (!results.length) {
    list.innerHTML = `<div class="empty-state">No results for "<b>${escHtml(query)}</b>"</div>`;
    return;
  }

  // Helper to render folder tree with search results
  function renderFolderForSearch(folder, colId, q, depth = 0) {
    const indent = depth * 16;
    const matchReqs = (folder.requests || []).filter(req =>
      (req.name || '').toLowerCase().includes(q) ||
      (req.url  || '').toLowerCase().includes(q) ||
      (req.method || '').toLowerCase().includes(q)
    );
    const matchSubfolders = (folder.folders || []).filter(sub => {
      // Check if subfolder or its contents match
      const subMatch = (sub.name || '').toLowerCase().includes(q);
      const subReqs = (sub.requests || []).some(req =>
        (req.name || '').toLowerCase().includes(q) ||
        (req.url  || '').toLowerCase().includes(q)
      );
      const subFolders = (sub.folders || []).length > 0; // has nested folders to check
      return subMatch || subReqs || subFolders;
    });
    
    const showReqs = folder.name.toLowerCase().includes(q) ? (folder.requests || []) : matchReqs;
    const showFolders = folder.name.toLowerCase().includes(q) ? (folder.folders || []) : matchSubfolders;
    
    if (!showReqs.length && !showFolders.length && !folder.name.toLowerCase().includes(q)) {
      // Check deeper
      const deepMatch = (folder.folders || []).some(sub => hasDeepMatch(sub, q));
      if (!deepMatch) return '';
    }
    
    return `
      <div class="folder-item" data-folder-id="${folder.id}" style="margin-left: ${indent}px">
        <div class="folder-header open">
          <span class="folder-arrow">▾</span>
          <span class="folder-icon">📂</span>
          <span class="folder-name">${hlMatch(folder.name, q)}</span>
        </div>
        <div class="folder-contents open">
          ${showFolders.map(sub => renderFolderForSearch(sub, colId, q, depth + 1)).join('')}
          ${showReqs.map(req => `
            <div class="request-item" style="margin-left: ${(depth + 1) * 16}px" onclick="loadSavedRequest('${colId}','${req.id}','${folder.id}')">
              <span class="req-method-badge method-${req.method} bg-${req.method}">${req.method}</span>
              <span class="req-name">${hlMatch(req.name || req.url, q)}</span>
              ${req.preScript || req.postScript ? '<span class="script-dot">📜</span>' : ''}
            </div>`).join('')}
        </div>
      </div>`;
  }
  
  // Helper to check deep match in nested folders
  function hasDeepMatch(folder, q) {
    if ((folder.name || '').toLowerCase().includes(q)) return true;
    if ((folder.requests || []).some(req => 
      (req.name || '').toLowerCase().includes(q) ||
      (req.url || '').toLowerCase().includes(q)
    )) return true;
    return (folder.folders || []).some(sub => hasDeepMatch(sub, q));
  }

  list.innerHTML = results.map(({ col, colHit, showReqs, showFolders }) => {
    const hasPre = !!(col.preScript?.trim());
    
    // Get all folders that have matches (including nested)
    const foldersToShow = colHit ? (col.folders || []) : (showFolders || []);
    
    return `
    <div class="collection-item" data-col-id="${col.id}">
      <div class="collection-header open" onclick="toggleCollection('${col.id}')">
        <span class="col-arrow">▾</span>
        <span class="col-icon">📁</span>
        <span class="col-name">${hlMatch(col.name, colHit ? query : '')}</span>
        ${hasPre ? '<span class="col-pre-badge" title="Has collection pre-script">📜</span>' : ''}
        <div class="col-actions">
          <button class="small-btn" onclick="event.stopPropagation();addRequestToCollection('${col.id}')" title="Add request">+</button>
          <button class="small-btn" onclick="event.stopPropagation();openEditCollectionModal('${col.id}')" title="Edit">✏</button>
          <button class="small-btn danger" onclick="event.stopPropagation();deleteCollection('${col.id}')" title="Delete">🗑</button>
        </div>
      </div>
      <div class="col-requests open" id="col-req-${col.id}">
        ${foldersToShow.map(folder => renderFolderForSearch(folder, col.id, q)).join('')}
        ${!showReqs.length && !foldersToShow.length
          ? '<div class="empty-state" style="font-size:11px;padding:8px">No requests</div>'
          : showReqs.map(req => `
            <div class="request-item" onclick="loadSavedRequest('${col.id}','${req.id}')">
              <span class="req-method-badge method-${req.method} bg-${req.method}">${req.method}</span>
              <span class="req-name">${hlMatch(req.name || req.url, query)}</span>
              ${req.preScript || req.postScript ? '<span class="script-dot">📜</span>' : ''}
              <div class="req-item-actions">
                <button class="small-btn danger" onclick="event.stopPropagation();deleteRequest('${col.id}','${req.id}')" title="Delete">×</button>
              </div>
            </div>`).join('')}
      </div>
    </div>`;
  }).join('');

  // Ensure search-visible nodes are properly expanded
  list.querySelectorAll('.col-requests').forEach(el => el.classList.add('open'));
  list.querySelectorAll('.collection-header').forEach(el => el.classList.add('open'));
  list.querySelectorAll('.folder-contents').forEach(el => el.classList.add('open'));
  list.querySelectorAll('.folder-header').forEach(el => el.classList.add('open'));
}

function renderCollections() {
  const list = document.getElementById('collections-list');
  
  // Save open state of collections and folders before re-rendering
  const openCollections = new Set();
  const openFolders = new Set();
  document.querySelectorAll('.collection-header.open').forEach(header => {
    const colId = header.closest('.collection-item')?.dataset.colId;
    if (colId) openCollections.add(colId);
  });
  document.querySelectorAll('.folder-header.open').forEach(header => {
    const folderId = header.closest('.folder-item')?.dataset.folderId;
    if (folderId) openFolders.add(folderId);
  });
  
  if (!state.collections.length) {
    list.innerHTML = '<div class="empty-state">No collections yet.<br/>Click + to create one.</div>';
    return;
  }
  
  list.innerHTML = state.collections.map(col => {
    const hasPreScript = !!(col.preScript?.trim());
    const isOpen = openCollections.has(col.id);
    const folders = col.folders || [];
    const rootRequests = col.requests || [];
    
    // Render folders
    const foldersHtml = folders.map(folder => {
      const isFolderOpen = openFolders.has(folder.id);
      const folderReqs = folder.requests || [];
      return `
        <div class="folder-item" data-folder-id="${folder.id}">
          <div class="folder-header ${isFolderOpen ? 'open' : ''}" onclick="toggleFolder('${col.id}','${folder.id}')">
            <span class="folder-arrow">▶</span>
            <span class="folder-icon">📂</span>
            <span class="folder-name" title="${escHtml(folder.name)}">${escHtml(folder.name)}</span>
            <div class="folder-actions">
              <button class="small-btn" onclick="event.stopPropagation();addRequestToFolder('${col.id}','${folder.id}')" title="Add request">+</button>
              <button class="small-btn" onclick="event.stopPropagation();renameFolder('${col.id}','${folder.id}')" title="Rename">✏</button>
              <button class="small-btn danger" onclick="event.stopPropagation();deleteFolder('${col.id}','${folder.id}')" title="Delete">×</button>
            </div>
          </div>
          <div class="folder-requests ${isFolderOpen ? 'open' : ''}" id="folder-req-${folder.id}">
            ${!folderReqs.length
              ? '<div class="empty-state" style="font-size:11px;padding:6px 12px">No requests</div>'
              : folderReqs.map((req, idx) => renderRequestItem(col.id, req, idx, folder.id)).join('')}
          </div>
        </div>`;
    }).join('');
    
    // Render root requests (not in folders)
    const rootRequestsHtml = rootRequests.map((req, idx) => renderRequestItem(col.id, req, idx, null)).join('');
    
    return `
    <div class="collection-item" data-col-id="${col.id}">
      <div class="collection-header ${isOpen ? 'open' : ''}" onclick="toggleCollection('${col.id}')">
        <span class="col-arrow">▶</span>
        <span class="col-icon">📁</span>
        <span class="col-name" title="${escHtml(col.name)}">${escHtml(col.name)}</span>
        ${hasPreScript ? '<span class="col-pre-badge" title="Has collection pre-script">📜</span>' : ''}
        <div class="col-actions">
          <button class="small-btn" onclick="event.stopPropagation();addFolderToCollection('${col.id}')" title="Add folder">📁+</button>
          <button class="small-btn" onclick="event.stopPropagation();addRequestToCollection('${col.id}')" title="Add request">+</button>
          <button class="small-btn" onclick="event.stopPropagation();openEditCollectionModal('${col.id}')" title="Edit collection / Pre-Script">✏</button>
          <button class="small-btn" onclick="event.stopPropagation();exportCollection('${col.id}')" title="Export JSON">📤</button>
          <button class="small-btn danger" onclick="event.stopPropagation();deleteCollection('${col.id}')" title="Delete">🗑</button>
        </div>
      </div>
      <div class="col-requests ${isOpen ? 'open' : ''}" id="col-req-${col.id}">
        ${foldersHtml}
        ${!rootRequests.length && !folders.length
          ? '<div class="empty-state" style="font-size:11px;padding:8px">No requests</div>'
          : rootRequestsHtml}
      </div>
    </div>`;
  }).join('');
  
  // Setup drag & drop for requests
  setupRequestDragDrop();
}

// Helper to render a single request item
function renderRequestItem(colId, req, idx, folderId) {
  const folderAttr = folderId ? `data-folder-id="${folderId}"` : '';
  return `
    <div class="request-item ${state.activeCollectionId === colId ? 'active-col' : ''}"
         data-col-id="${colId}" data-req-id="${req.id}" data-req-idx="${idx}" ${folderAttr}
         draggable="true"
         onclick="loadSavedRequest('${colId}','${req.id}','${folderId || ''}')">
      <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
      <span class="req-method-badge method-${req.method} bg-${req.method}">${req.method}</span>
      <span class="req-name" title="${escHtml(req.name || req.url)}">${escHtml(req.name || req.url)}</span>
      ${req.preScript || req.postScript ? '<span class="script-dot" title="Has request scripts">📜</span>' : ''}
      <div class="req-item-actions">
        <button class="small-btn" onclick="event.stopPropagation();renameRequest('${colId}','${req.id}','${folderId || ''}')" title="Rename">✏</button>
        <button class="small-btn danger" onclick="event.stopPropagation();deleteRequest('${colId}','${req.id}')" title="Delete">×</button>
      </div>
    </div>`;
}

function toggleCollection(colId) {
  document.querySelector(`[data-col-id="${colId}"] .collection-header`).classList.toggle('open');
  document.getElementById(`col-req-${colId}`).classList.toggle('open');
}

function toggleFolder(colId, folderId) {
  const folderItem = document.querySelector(`[data-folder-id="${folderId}"]`);
  if (folderItem) {
    folderItem.querySelector('.folder-header').classList.toggle('open');
    document.getElementById(`folder-req-${folderId}`).classList.toggle('open');
  }
}

async function addFolderToCollection(colId) {
  const name = prompt('Folder name:');
  if (!name) return;
  await apiCall(`/api/collections/${colId}/folders`, {
    method: 'POST',
    body: { name }
  });
  await loadCollections();
  renderCollections();
  showToast('Folder created');
}

async function renameFolder(colId, folderId) {
  const col = state.collections.find(c => c.id === colId);
  const folder = (col?.folders || []).find(f => f.id === folderId);
  if (!folder) return;
  
  const newName = prompt('Rename folder:', folder.name);
  if (!newName || newName === folder.name) return;
  
  await apiCall(`/api/collections/${colId}/folders/${folderId}`, {
    method: 'PUT',
    body: { name: newName }
  });
  await loadCollections();
  renderCollections();
  showToast('Folder renamed');
}

async function deleteFolder(colId, folderId) {
  if (!confirm('Delete this folder and all its requests?')) return;
  await apiCall(`/api/collections/${colId}/folders/${folderId}`, { method: 'DELETE' });
  await loadCollections();
  renderCollections();
  showToast('Folder deleted');
}

async function addRequestToFolder(colId, folderId) {
  const name = prompt('Request name:');
  if (!name) return;
  await apiCall(`/api/collections/${colId}/folders/${folderId}/requests`, {
    method: 'POST',
    body: {
      name,
      method: document.getElementById('method-select').value,
      url: document.getElementById('url-input').value || '',
      headers: getKVPairs('headers', true),
      params:  getKVPairs('params', true),
      bodyType: state.currentRequest.bodyType,
      body: window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || ''),
      auth: state.currentRequest.auth,
      preScript:  window.getScriptEditorValue ? window.getScriptEditorValue('prescript') : (document.getElementById('prescript-input')?.value || ''),
      postScript: window.getScriptEditorValue ? window.getScriptEditorValue('postscript') : (document.getElementById('postscript-input')?.value || ''),
    },
  });
  await loadCollections();
  renderCollections();
  showToast('Saved to folder');
}

async function deleteCollection(colId) {
  if (!confirm('Delete this collection?')) return;
  await apiCall(`/api/collections/${colId}`, { method: 'DELETE' });
  await loadCollections(); renderCollections();
  showToast('Collection deleted');
}

async function addRequestToCollection(colId) {
  const name = prompt('Request name:');
  if (!name) return;
  await apiCall(`/api/collections/${colId}/requests`, {
    method: 'POST',
    body: {
      name,
      method: document.getElementById('method-select').value,
      url: document.getElementById('url-input').value || '',
      headers: getKVPairs('headers', true),
      params:  getKVPairs('params', true),
      bodyType: state.currentRequest.bodyType,
      body: window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || ''),
      auth: state.currentRequest.auth,
      preScript:  window.getScriptEditorValue ? window.getScriptEditorValue('prescript') : (document.getElementById('prescript-input')?.value || ''),
      postScript: window.getScriptEditorValue ? window.getScriptEditorValue('postscript') : (document.getElementById('postscript-input')?.value || ''),
    },
  });
  await loadCollections(); renderCollections();
  showToast(`Saved to collection`);
}

async function deleteRequest(colId, reqId) {
  if (!confirm('Delete this request?')) return;
  await apiCall(`/api/collections/${colId}/requests/${reqId}`, { method: 'DELETE' });
  await loadCollections(); renderCollections();
  showToast('Request deleted');
}

// Rename request
async function renameRequest(colId, reqId) {
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;
  const req = (col.requests || []).find(r => r.id === reqId);
  if (!req) return;
  
  const newName = prompt('Rename request:', req.name || req.url);
  if (!newName || newName === req.name) return;
  
  // Update request name via API
  await apiCall(`/api/collections/${colId}/requests/${reqId}`, {
    method: 'PUT',
    body: { ...req, name: newName }
  });
  await loadCollections();
  renderCollections();
  showToast('Request renamed');
}

// Drag & drop for reordering requests and moving to/from folders
function setupRequestDragDrop() {
  let draggedEl = null;
  let draggedColId = null;
  let draggedReqId = null;
  let draggedFolderId = null;
  
  // Setup draggable request items
  document.querySelectorAll('.request-item[draggable="true"]').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      draggedEl = item;
      draggedColId = item.dataset.colId;
      draggedReqId = item.dataset.reqId;
      draggedFolderId = item.dataset.folderId || null;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedReqId);
    });
    
    item.addEventListener('dragend', () => {
      draggedEl?.classList.remove('dragging');
      document.querySelectorAll('.request-item.drag-over, .folder-item.drag-over, .col-requests.drag-over-root').forEach(el => {
        el.classList.remove('drag-over', 'drag-over-root');
      });
      draggedEl = null;
      draggedColId = null;
      draggedReqId = null;
      draggedFolderId = null;
    });
    
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedEl || draggedEl === item) return;
      // Only allow drop in same collection
      if (item.dataset.colId !== draggedColId) return;
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');
      
      if (!draggedEl || draggedEl === item) return;
      if (item.dataset.colId !== draggedColId) return;
      
      const colId = draggedColId;
      const fromReqId = draggedReqId;
      const fromFolderId = draggedFolderId;
      const toReqId = item.dataset.reqId;
      const toFolderId = item.dataset.folderId || null;
      
      await moveRequest(colId, fromReqId, fromFolderId, toFolderId, toReqId);
    });
  });
  
  // Setup folder drop zones (drop INTO folder)
  document.querySelectorAll('.folder-header').forEach(folderHeader => {
    folderHeader.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedEl) return;
      const folderItem = folderHeader.closest('.folder-item');
      const colItem = folderItem.closest('.collection-item');
      if (colItem.dataset.colId !== draggedColId) return;
      
      e.dataTransfer.dropEffect = 'move';
      folderItem.classList.add('drag-over');
    });
    
    folderHeader.addEventListener('dragleave', (e) => {
      const folderItem = folderHeader.closest('.folder-item');
      // Only remove if leaving to outside folder-item
      if (!folderItem.contains(e.relatedTarget)) {
        folderItem.classList.remove('drag-over');
      }
    });
    
    folderHeader.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const folderItem = folderHeader.closest('.folder-item');
      folderItem.classList.remove('drag-over');
      
      if (!draggedEl) return;
      const colItem = folderItem.closest('.collection-item');
      if (colItem.dataset.colId !== draggedColId) return;
      
      const colId = draggedColId;
      const fromReqId = draggedReqId;
      const fromFolderId = draggedFolderId;
      const toFolderId = folderItem.dataset.folderId;
      
      // Don't move if already in this folder
      if (fromFolderId === toFolderId) return;
      
      await moveRequest(colId, fromReqId, fromFolderId, toFolderId, null);
    });
  });
  
  // Setup root drop zone (drop OUT of folder to root)
  document.querySelectorAll('.col-requests').forEach(colReqs => {
    colReqs.addEventListener('dragover', (e) => {
      // Only activate if dropping directly on col-requests (not on folder or request)
      if (e.target !== colReqs) return;
      e.preventDefault();
      if (!draggedEl) return;
      
      const colItem = colReqs.closest('.collection-item');
      if (colItem.dataset.colId !== draggedColId) return;
      
      e.dataTransfer.dropEffect = 'move';
      colReqs.classList.add('drag-over-root');
    });
    
    colReqs.addEventListener('dragleave', (e) => {
      if (e.target === colReqs) {
        colReqs.classList.remove('drag-over-root');
      }
    });
    
    colReqs.addEventListener('drop', async (e) => {
      // Only handle if dropping directly on col-requests
      if (e.target !== colReqs) return;
      e.preventDefault();
      colReqs.classList.remove('drag-over-root');
      
      if (!draggedEl) return;
      const colItem = colReqs.closest('.collection-item');
      if (colItem.dataset.colId !== draggedColId) return;
      
      const colId = draggedColId;
      const fromReqId = draggedReqId;
      const fromFolderId = draggedFolderId;
      
      // Moving to root (no folder)
      if (fromFolderId) {
        await moveRequest(colId, fromReqId, fromFolderId, null, null);
      }
    });
  });
}

// Move a request between folders or to/from root
async function moveRequest(colId, reqId, fromFolderId, toFolderId, beforeReqId) {
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;
  
  // Find and remove request from source
  let request = null;
  if (fromFolderId) {
    const fromFolder = (col.folders || []).find(f => f.id === fromFolderId);
    if (fromFolder && fromFolder.requests) {
      const idx = fromFolder.requests.findIndex(r => r.id === reqId);
      if (idx !== -1) {
        [request] = fromFolder.requests.splice(idx, 1);
      }
    }
  } else {
    const idx = (col.requests || []).findIndex(r => r.id === reqId);
    if (idx !== -1) {
      [request] = col.requests.splice(idx, 1);
    }
  }
  
  if (!request) return;
  
  // Add request to destination
  if (toFolderId) {
    const toFolder = (col.folders || []).find(f => f.id === toFolderId);
    if (toFolder) {
      toFolder.requests = toFolder.requests || [];
      if (beforeReqId) {
        const beforeIdx = toFolder.requests.findIndex(r => r.id === beforeReqId);
        if (beforeIdx !== -1) {
          toFolder.requests.splice(beforeIdx, 0, request);
        } else {
          toFolder.requests.push(request);
        }
      } else {
        toFolder.requests.push(request);
      }
    }
  } else {
    col.requests = col.requests || [];
    if (beforeReqId) {
      const beforeIdx = col.requests.findIndex(r => r.id === beforeReqId);
      if (beforeIdx !== -1) {
        col.requests.splice(beforeIdx, 0, request);
      } else {
        col.requests.push(request);
      }
    } else {
      col.requests.push(request);
    }
  }
  
  // Save to server
  await apiCall(`/api/collections/${colId}`, {
    method: 'PUT',
    body: col
  });
  
  await loadCollections();
  renderCollections();
  
  const action = toFolderId ? 'moved to folder' : (fromFolderId ? 'moved to root' : 'reordered');
  showToast(`Request ${action}`);
}

function loadSavedRequest(colId, reqId, folderId) {
  // Store current changes if dirty before switching
  storeCurrentChangesIfDirty();
  
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;
  
  // Auto-switch environment if collection name matches an environment name
  autoSwitchEnvironmentForCollection(col.name);
  
  // Find request - check folders first if folderId provided, then root requests
  let req = null;
  if (folderId) {
    const folder = (col.folders || []).find(f => f.id === folderId);
    req = folder ? (folder.requests || []).find(r => r.id === reqId) : null;
  }
  if (!req) {
    // Check root requests
    req = (col.requests || []).find(r => r.id === reqId);
  }
  if (!req) {
    // Search all folders
    for (const folder of (col.folders || [])) {
      req = (folder.requests || []).find(r => r.id === reqId);
      if (req) {
        folderId = folder.id;
        break;
      }
    }
  }
  if (!req) return;

  // Track active collection for collection-level pre-script
  state.activeCollectionId = colId;
  state.activeFolderId = folderId || null;

  document.getElementById('url-input').value    = req.url || '';
  document.getElementById('method-select').value = req.method || 'GET';
  document.getElementById('method-select').className = `method-select method-${req.method || 'GET'}`;
  initKVRows('params',  req.params  || []);
  initKVRows('headers', req.headers || []);
  
  // Set script values via CodeMirror helpers
  if (window.setScriptEditorValue) {
    window.setScriptEditorValue('prescript', req.preScript || '');
    window.setScriptEditorValue('postscript', req.postScript || '');
  } else {
    document.getElementById('prescript-input').value  = req.preScript  || '';
    document.getElementById('postscript-input').value = req.postScript || '';
  }
  // Update script syntax highlighting
  if (window.updateScriptHighlights) window.updateScriptHighlights();

  state.currentRequest.auth     = req.auth     || { type: 'none' };
  state.currentRequest.bodyType = req.bodyType || 'none';
  document.getElementById('auth-type').value = req.auth?.type || 'none';
  renderAuthFields(req.auth?.type || 'none', req.auth || {});

  setBodyType(req.bodyType || 'none');
  // Set body value via CodeMirror helper
  if (window.setBodyEditorValue) {
    window.setBodyEditorValue(req.body || '');
  } else {
    document.getElementById('body-input').value = req.body || '';
  }
  // Reset body history with loaded content
  if (window.bodyHistory) window.bodyHistory.reset(req.body || '');
  // Update syntax highlighting and line numbers
  if (window.updateBodyHighlight) window.updateBodyHighlight();
  if (window.updateBodyLineNumbers) window.updateBodyLineNumbers();

  // Check if there are pending unsaved changes for this request
  const pendingChanges = restoreChangesIfExists(colId, reqId);
  
  // Set active request for dirty tracking
  state.activeRequest = {
    colId, reqId,
    name: req.name || req.url || 'Request',
    snapshot: null,  // set after form is fully populated
  };
  
  // If there are pending changes, restore them
  if (pendingChanges) {
    const c = pendingChanges.changes;
    document.getElementById('url-input').value = c.url || '';
    document.getElementById('method-select').value = c.method || 'GET';
    document.getElementById('method-select').className = `method-select method-${c.method || 'GET'}`;
    initKVRows('params', c.params || []);
    initKVRows('headers', c.headers || []);
    // Restore scripts via CodeMirror helpers
    if (window.setScriptEditorValue) {
      window.setScriptEditorValue('prescript', c.preScript || '');
      window.setScriptEditorValue('postscript', c.postScript || '');
    } else {
      document.getElementById('prescript-input').value = c.preScript || '';
      document.getElementById('postscript-input').value = c.postScript || '';
    }
    if (window.updateScriptHighlights) window.updateScriptHighlights();
    state.currentRequest.bodyType = c.bodyType || 'none';
    setBodyType(c.bodyType || 'none');
    // Restore body via CodeMirror helper
    if (window.setBodyEditorValue) {
      window.setBodyEditorValue(c.body || '');
    } else {
      document.getElementById('body-input').value = c.body || '';
    }
    // Reset body history with restored content
    if (window.bodyHistory) window.bodyHistory.reset(c.body || '');
    state.currentRequest.auth = c.auth || { type: 'none' };
    document.getElementById('auth-type').value = c.auth?.type || 'none';
    renderAuthFields(c.auth?.type || 'none', c.auth || {});
    if (window.updateBodyHighlight) window.updateBodyHighlight();
    if (window.updateBodyLineNumbers) window.updateBodyLineNumbers();
    
    // Use original snapshot for comparison
    state.activeRequest.snapshot = pendingChanges.snapshot;
    state.isDirty = true;
  } else {
    // Snapshot must be taken AFTER all fields are set
    state.activeRequest.snapshot = captureFormState();
    state.isDirty = false;
  }
  
  updateDirtyIndicator();

  // Load response history for this request
  loadResponseHistory(reqId);

  showToast(`Loaded: ${req.name}`);
}

// ===== History =====
function renderHistory() {
  const list = document.getElementById('history-list');
  if (!state.history.length) {
    list.innerHTML = '<div class="empty-state">No request history yet.</div>';
    return;
  }
  list.innerHTML = state.history.map(item => {
    const cls  = item.status >= 500 ? 'status-5xx' : item.status >= 400 ? 'status-4xx' : item.status >= 300 ? 'status-3xx' : 'status-2xx';
    const time = new Date(item.timestamp).toLocaleTimeString();
    return `
      <div class="history-item" onclick="loadHistoryItem('${item.id}')">
        <span class="req-method-badge method-${item.method} bg-${item.method}" style="font-size:9px;width:38px">${item.method}</span>
        <div class="history-info">
          <div class="history-url">${escHtml(item.url)}</div>
          <div class="history-time">${time}</div>
        </div>
        ${item.status ? `<span class="status-badge ${cls}">${item.status}</span>` : ''}
      </div>`;
  }).join('');
}

function loadHistoryItem(id) {
  const item = state.history.find(h => h.id === id);
  if (!item?.request) return;
  const req = item.request;
  document.getElementById('url-input').value     = req.url    || '';
  document.getElementById('method-select').value = req.method || 'GET';
  document.getElementById('method-select').className = `method-select method-${req.method || 'GET'}`;
  if (req.headers) initKVRows('headers', Object.entries(req.headers).map(([k, v]) => ({ key: k, value: v })));
  if (req.params)  initKVRows('params',  Object.entries(req.params).map(([k, v]) => ({ key: k, value: v })));
  showToast('Loaded from history');
}

// ===== Response History (per request) =====
async function loadResponseHistory(reqId) {
  if (!reqId) {
    state.responseHistory = [];
    renderResponseHistoryDropdown();
    return;
  }
  try {
    const res = await fetch(`/api/requests/${reqId}/responses`);
    state.responseHistory = await res.json();
  } catch (e) {
    state.responseHistory = [];
  }
  renderResponseHistoryDropdown();
  
  // Auto-load latest response if available
  if (state.responseHistory.length > 0) {
    displayResponseFromHistory(state.responseHistory[0]);
    // Also display console logs from history if available
    const latest = state.responseHistory[0];
    if (latest.consoleLogs) {
      const cl = latest.consoleLogs;
      renderConsole(
        cl.colPreLogs || [], cl.colPreTests || [],
        cl.preLogs || [], cl.preTests || [],
        cl.postLogs || [], cl.postTests || [],
        cl.requestInfo || null
      );
    } else {
      // Clear console if no logs saved
      clearConsoleOutput();
    }
  } else {
    // Clear response area
    setResponseState('idle');
    showResponseMeta(null, null, null);
    // Clear console
    clearConsoleOutput();
  }
}

async function saveResponseToHistory(reqId, responseData, consoleData = null) {
  if (!reqId) return;
  try {
    const historyEntry = {
      status: responseData.status,
      statusText: responseData.statusText,
      duration: responseData.duration,
      size: responseData.size,
      headers: responseData.headers,
      body: responseData.body,
    };
    
    // Include console logs if provided
    if (consoleData) {
      historyEntry.consoleLogs = consoleData;
    }
    
    const res = await fetch(`/api/requests/${reqId}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(historyEntry),
    });
    const saved = await res.json();
    // Prepend to local history
    state.responseHistory.unshift(saved);
    state.responseHistory = state.responseHistory.slice(0, 10);
    
    // Store latest history entry reference for updating post-script logs later
    state.latestHistoryEntry = saved;
    
    renderResponseHistoryDropdown();
  } catch (e) {
    console.error('Failed to save response history:', e);
  }
}

async function clearResponseHistory(reqId) {
  if (!reqId) return;
  try {
    await fetch(`/api/requests/${reqId}/responses`, { method: 'DELETE' });
    state.responseHistory = [];
    renderResponseHistoryDropdown();
    setResponseState('idle');
    showResponseMeta(null, null, null);
    showToast('Response history cleared');
  } catch (e) {
    console.error('Failed to clear response history:', e);
  }
}

function renderResponseHistoryDropdown() {
  const wrap = document.getElementById('res-history-wrap');
  const select = document.getElementById('res-history-select');
  
  // Show/hide based on whether we have an active saved request
  if (!state.activeRequest?.reqId) {
    wrap.classList.remove('visible');
    return;
  }
  
  wrap.classList.add('visible');
  
  if (!state.responseHistory.length) {
    select.innerHTML = '<option value="">No history</option>';
    return;
  }
  
  select.innerHTML = state.responseHistory.map((resp, idx) => {
    const time = new Date(resp.timestamp).toLocaleString();
    const statusCls = resp.status >= 500 ? '5xx' : resp.status >= 400 ? '4xx' : resp.status >= 300 ? '3xx' : '2xx';
    const label = `${resp.status || '?'} • ${resp.duration || '?'}ms • ${time}`;
    const selected = idx === 0 ? 'selected' : '';
    return `<option value="${resp.id}" ${selected}>${label}</option>`;
  }).join('');
}

function displayResponseFromHistory(respData) {
  if (!respData) return;
  
  // Build a response object compatible with renderResponse
  const displayData = {
    status: respData.status,
    statusText: respData.statusText || '',
    duration: respData.duration,
    size: respData.size,
    headers: respData.headers || {},
    body: respData.body || '',
  };
  
  state.lastResponse = displayData;
  try {
    renderResponse(displayData);
  } catch (e) {
    setResponseState('content');
    showResponseMeta(displayData.status, displayData.duration, displayData.size);
    const pre = document.getElementById('response-body-pre');
    const tree = document.getElementById('response-body-tree');
    if (tree) tree.classList.add('hidden');
    if (pre) { pre.classList.remove('hidden'); pre.textContent = displayData.body || ''; }
  }
}

// ===== Environments =====

// Auto-switch environment based on collection name
function autoSwitchEnvironmentForCollection(collectionName) {
  if (!collectionName || !state.environments.length) return;
  
  const colNameLower = collectionName.toLowerCase().trim();
  
  // Try exact match first
  let matchedEnv = state.environments.find(env => 
    env.name.toLowerCase().trim() === colNameLower
  );
  
  // If no exact match, try partial match (collection name contains env name or vice versa)
  if (!matchedEnv) {
    matchedEnv = state.environments.find(env => {
      const envNameLower = env.name.toLowerCase().trim();
      return colNameLower.includes(envNameLower) || envNameLower.includes(colNameLower);
    });
  }
  
  // If found and different from current, switch to it
  if (matchedEnv && matchedEnv.id !== state.activeEnvId) {
    state.activeEnvId = matchedEnv.id;
    document.getElementById('active-env-select').value = matchedEnv.id;
    renderEnvironments();
    showToast(`Environment switched to: ${matchedEnv.name}`, 'info');
  }
}

function updateActiveEnvIndicator() {
  const indicatorName = document.getElementById('env-indicator-name');
  if (!indicatorName) return;
  
  if (state.activeEnvId && state.environments.length) {
    const env = state.environments.find(e => e.id === state.activeEnvId);
    if (env) {
      indicatorName.textContent = env.name;
      indicatorName.className = 'env-indicator-name active';
    } else {
      indicatorName.textContent = 'None';
      indicatorName.className = 'env-indicator-name none';
    }
  } else {
    indicatorName.textContent = 'None';
    indicatorName.className = 'env-indicator-name none';
  }
}

function renderEnvironments() {
  const list   = document.getElementById('env-list');
  const select = document.getElementById('active-env-select');

  if (!state.environments.length) {
    list.innerHTML = '<div class="empty-state">No environments yet.</div>';
  } else {
    list.innerHTML = state.environments.map(env => `
      <div class="env-item">
        ${state.activeEnvId === env.id ? '<span class="env-active-dot"></span>' : '<span style="width:6px"></span>'}
        <span class="env-name">${escHtml(env.name)}</span>
        <div class="env-actions">
          <button class="small-btn" onclick="editEnv('${env.id}')">Edit</button>
          <button class="small-btn danger" onclick="deleteEnv('${env.id}')">Delete</button>
        </div>
      </div>`).join('');
  }

  select.innerHTML = '<option value="">None</option>' +
    state.environments.map(e => `<option value="${e.id}" ${state.activeEnvId === e.id ? 'selected' : ''}>${escHtml(e.name)}</option>`).join('');
  
  // Update the active environment indicator
  updateActiveEnvIndicator();
}

function editEnv(envId) {
  const env = state.environments.find(e => e.id === envId);
  if (!env) return;
  state.editingEnvId = envId;
  document.getElementById('modal-env-title').textContent = 'Edit Environment';
  document.getElementById('env-name-input').value = env.name;
  initKVRows('env-vars', (env.variables || []).map(v => ({ key: v.key, value: v.value })));
  resetEnvModalView('table');
  openModal('modal-env');
}

async function deleteEnv(envId) {
  if (!confirm('Delete this environment?')) return;
  await apiCall(`/api/environments/${envId}`, { method: 'DELETE' });
  if (state.activeEnvId === envId) state.activeEnvId = null;
  await loadEnvironments(); renderEnvironments();
  showToast('Environment deleted');
}

// ===== Auth =====
function renderAuthFields(type, data = {}) {
  const container = document.getElementById('auth-fields');
  container.innerHTML = '';
  if (type === 'none') return;

  if (type === 'bearer') {
    container.innerHTML = `<div class="auth-fields"><div class="auth-field-row">
      <label>Token</label>
      <input class="auth-field-input" id="auth-token" type="text" placeholder="Bearer token..." value="${escHtml(data.token || '')}" />
    </div></div>`;
    document.getElementById('auth-token').addEventListener('input', e => state.currentRequest.auth.token = e.target.value);
  } else if (type === 'basic') {
    container.innerHTML = `<div class="auth-fields">
      <div class="auth-field-row"><label>Username</label><input class="auth-field-input" id="auth-username" type="text" placeholder="Username" value="${escHtml(data.username || '')}" /></div>
      <div class="auth-field-row"><label>Password</label><input class="auth-field-input" id="auth-password" type="password" placeholder="Password" value="${escHtml(data.password || '')}" /></div>
    </div>`;
    document.getElementById('auth-username').addEventListener('input', e => state.currentRequest.auth.username = e.target.value);
    document.getElementById('auth-password').addEventListener('input', e => state.currentRequest.auth.password = e.target.value);
  } else if (type === 'apikey') {
    container.innerHTML = `<div class="auth-fields">
      <div class="auth-field-row"><label>Key Name</label><input class="auth-field-input" id="auth-api-key" type="text" placeholder="e.g. X-API-Key" value="${escHtml(data.key || '')}" /></div>
      <div class="auth-field-row"><label>Value</label><input class="auth-field-input" id="auth-api-value" type="text" placeholder="API key value" value="${escHtml(data.value || '')}" /></div>
      <div class="auth-field-row"><label>Add to</label>
        <select id="auth-api-placement" style="background:var(--bg-input);border:1px solid var(--border-light);border-radius:4px;padding:5px 8px;color:var(--text-primary);font-size:12px;">
          <option value="header" ${data.placement === 'header' ? 'selected' : ''}>Header</option>
          <option value="query"  ${data.placement === 'query'  ? 'selected' : ''}>Query Param</option>
        </select>
      </div>
    </div>`;
    document.getElementById('auth-api-key').addEventListener('input', e => state.currentRequest.auth.key = e.target.value);
    document.getElementById('auth-api-value').addEventListener('input', e => state.currentRequest.auth.value = e.target.value);
    document.getElementById('auth-api-placement').addEventListener('change', e => state.currentRequest.auth.placement = e.target.value);
  }
}

// ===== Body Type =====
function setBodyType(type) {
  state.currentRequest.bodyType = type;
  document.querySelectorAll('.body-type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === type));
  document.getElementById('body-editor').classList.add('hidden');
  document.getElementById('form-editor').classList.add('hidden');
  if (['json','xml','text'].includes(type)) {
    document.getElementById('body-editor').classList.remove('hidden');
    const ph = { json: '{\n  "key": "value"\n}', xml: '<?xml version="1.0"?>\n<root></root>', text: 'Plain text body...' };
    document.getElementById('body-input').placeholder = ph[type] || '';
  } else if (type === 'form') {
    document.getElementById('form-editor').classList.remove('hidden');
  }
}

// ===== Insert at Cursor =====
function insertAtCursor(textarea, text) {
  if (!textarea) return;
  const s = textarea.selectionStart, e = textarea.selectionEnd;
  textarea.value = textarea.value.slice(0, s) + text + textarea.value.slice(e);
  textarea.selectionStart = textarea.selectionEnd = s + text.length;
  textarea.focus();
}

// ===== Modals =====
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

// ===== Toast =====
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

// ===== Utilities =====
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function updateSaveCollectionSelect() {
  const sel = document.getElementById('save-req-collection');
  sel.innerHTML = '<option value="_new">+ Create New Collection</option>' +
    state.collections.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  document.getElementById('new-collection-form').style.display = state.collections.length === 0 ? 'flex' : 'none';
}

// ===== Save Request =====
async function saveRequest() {
  const name   = document.getElementById('save-req-name').value.trim();
  const colSel = document.getElementById('save-req-collection').value;
  if (!name) { showToast('Please enter a name', 'error'); return; }

  let colId = colSel;
  if (colSel === '_new') {
    const colName = document.getElementById('save-col-name').value.trim() || 'New Collection';
    const col = await apiCall('/api/collections', { method: 'POST', body: { name: colName, requests: [] } });
    colId = col.id;
    await loadCollections();
  }
  if (!colId || colId === '_new') { showToast('Select or create a collection', 'error'); return; }

  await apiCall(`/api/collections/${colId}/requests`, {
    method: 'POST',
    body: {
      name,
      method:     document.getElementById('method-select').value,
      url:        document.getElementById('url-input').value,
      params:     getKVPairs('params', true),
      headers:    getKVPairs('headers', true),
      auth:       state.currentRequest.auth,
      bodyType:   state.currentRequest.bodyType,
      body:       window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || ''),
      preScript:  window.getScriptEditorValue ? window.getScriptEditorValue('prescript') : (document.getElementById('prescript-input')?.value || ''),
      postScript: window.getScriptEditorValue ? window.getScriptEditorValue('postscript') : (document.getElementById('postscript-input')?.value || ''),
    },
  });
  await loadCollections(); renderCollections();
  closeModal('modal-save');
  showToast(`Saved: ${name}`);
}

async function saveCollection() {
  const name   = document.getElementById('collection-name-input').value.trim();
  const desc   = document.getElementById('collection-desc-input').value.trim();
  const preScript = document.getElementById('collection-prescript-input').value;
  if (!name) { showToast('Please enter a name', 'error'); return; }

  if (state.editingCollectionId) {
    await apiCall(`/api/collections/${state.editingCollectionId}`, { method: 'PUT', body: { name, description: desc, preScript } });
  } else {
    await apiCall('/api/collections', { method: 'POST', body: { name, description: desc, preScript, requests: [] } });
  }
  await loadCollections(); renderCollections();
  closeModal('modal-collection');
  showToast(state.editingCollectionId ? 'Collection updated' : 'Collection created');
  state.editingCollectionId = null;
}

async function saveEnvironment() {
  const name = document.getElementById('env-name-input').value.trim();
  if (!name) { showToast('Please enter a name', 'error'); return; }

  // Sync JSON view → Table before reading
  if (!document.getElementById('env-json-view').classList.contains('hidden')) {
    if (!envJsonToTable()) return; // returns false on parse error
  }

  const variables = getKVPairs('env-vars').filter(p => p.key);

  if (state.editingEnvId) {
    await apiCall(`/api/environments/${state.editingEnvId}`, { method: 'PUT', body: { name, variables } });
  } else {
    await apiCall('/api/environments', { method: 'POST', body: { name, variables } });
  }
  await loadEnvironments(); renderEnvironments();
  closeModal('modal-env');
  showToast(state.editingEnvId ? 'Environment updated' : 'Environment created');
  state.editingEnvId = null;
}

// ===== Environment JSON ↔ Table helpers =====
function resetEnvModalView(mode) {
  const isTable = mode === 'table';
  document.getElementById('env-table-view').classList.toggle('hidden', !isTable);
  document.getElementById('env-json-view').classList.toggle('hidden',   isTable);
  document.getElementById('btn-env-table').classList.toggle('active',   isTable);
  document.getElementById('btn-env-json').classList.toggle('active',   !isTable);
  document.getElementById('env-json-status').textContent = '';
}

function envTableToJson() {
  const pairs = getKVPairs('env-vars').filter(p => p.key);
  const obj   = {};
  pairs.forEach(p => { obj[p.key] = p.value; });
  document.getElementById('env-json-input').value = JSON.stringify(obj, null, 2);
}

function envJsonToTable() {
  const text = document.getElementById('env-json-input').value.trim();
  if (!text) { initKVRows('env-vars', []); return true; }
  try {
    const data  = JSON.parse(text);
    let   pairs = [];

    if (Array.isArray(data)) {
      // [{key, value}] format
      pairs = data.filter(item => item.key)
        .map(item => ({ key: String(item.key), value: String(item.value ?? '') }));
    } else if (data.values && Array.isArray(data.values)) {
      // Postman environment: { values: [{key, value, enabled}] }
      pairs = data.values.filter(v => v.key && v.enabled !== false)
        .map(v => ({ key: String(v.key), value: String(v.value ?? '') }));
    } else if (typeof data === 'object') {
      // Simple flat: { "key": "value" }
      pairs = Object.entries(data).map(([key, value]) => ({ key, value: String(value) }));
    }

    initKVRows('env-vars', pairs);
    document.getElementById('env-json-status').innerHTML = `<span class="json-ok">✓ ${pairs.length} variables</span>`;
    return true;
  } catch (e) {
    document.getElementById('env-json-status').innerHTML = `<span class="json-err">✗ ${e.message}</span>`;
    showToast('Invalid JSON: ' + e.message, 'error');
    return false;
  }
}

// ===== Event Listeners =====
function setupEventListeners() {
  // Guard against old cached HTML — if key elements missing, bail early
  if (!document.getElementById('btn-quick-save') || !document.getElementById('request-context-bar')) {
    console.error('[setupEventListeners] HTML is outdated. Please hard-refresh: Cmd+Shift+R');
    return;
  }
  // Send
  document.getElementById('btn-send').addEventListener('click', sendRequest);
  const urlInput = document.getElementById('url-input');
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRequest(); } });
  
  // Auto-resize URL textarea
  function autoResizeUrlInput() {
    urlInput.style.height = 'auto';
    urlInput.style.height = Math.min(urlInput.scrollHeight, 200) + 'px';
  }
  
  urlInput.addEventListener('input', autoResizeUrlInput);
  // Also resize when value is set programmatically
  const urlInputDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(urlInput, 'value', {
    get: function() { return urlInputDescriptor.get.call(this); },
    set: function(v) { urlInputDescriptor.set.call(this, v); setTimeout(autoResizeUrlInput, 0); }
  });

  // ── Script Editors - No syntax highlighting for hitbox precision ──
  window.updateScriptHighlights = function() {
    // No-op: syntax highlighting disabled for precision
  };

  // ── Response History ──
  document.getElementById('res-history-select')?.addEventListener('change', (e) => {
    const respId = e.target.value;
    if (!respId) return;
    const resp = state.responseHistory.find(r => r.id === respId);
    if (resp) {
      displayResponseFromHistory(resp);
      // Also display console logs from history if available
      if (resp.consoleLogs) {
        const cl = resp.consoleLogs;
        renderConsole(
          cl.colPreLogs || [], cl.colPreTests || [],
          cl.preLogs || [], cl.preTests || [],
          cl.postLogs || [], cl.postTests || [],
          cl.requestInfo || null
        );
      }
    }
  });
  
  document.getElementById('btn-clear-res-history')?.addEventListener('click', () => {
    if (state.activeRequest?.reqId) {
      if (confirm('Clear all response history for this request?')) {
        clearResponseHistory(state.activeRequest.reqId);
      }
    }
  });

  // ── Dirty tracking: watch any form change in the request area ──
  const mainEl = document.querySelector('.main');
  if (mainEl) {
    mainEl.addEventListener('input',  () => setTimeout(checkDirty, 0));
    mainEl.addEventListener('change', () => setTimeout(checkDirty, 0));
    // KV row add/delete
    mainEl.addEventListener('click', e => {
      if (e.target.matches('.kv-delete, .add-row-btn, .body-type-btn, .col-mtab')) {
        setTimeout(checkDirty, 50);
      }
    });
  }

  // Quick save button + Cmd/Ctrl+S shortcut
  document.getElementById('btn-quick-save').addEventListener('click', quickSave);
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      quickSave();
    }
  });

  // ── Warn before refresh/close if there are unsaved changes ──
  window.addEventListener('beforeunload', e => {
    if (hasAnyUnsavedChanges()) {
      e.preventDefault();
      e.returnValue = ''; // required for Chrome; triggers the browser's default warning dialog
    }
  });

  // ── Intercept F5 / Ctrl+R / Cmd+R to show custom unsaved modal ──
  document.addEventListener('keydown', e => {
    const isRefresh = e.key === 'F5' || 
                      ((e.ctrlKey || e.metaKey) && e.key === 'r');
    if (isRefresh && hasAnyUnsavedChanges()) {
      e.preventDefault();
      showUnsavedModal(() => location.reload());
    }
  });
  
  // Setup unsaved modal button handlers
  setupUnsavedModalHandlers();
  
  // Reload App button - shows unsaved modal if there are changes
  document.getElementById('btn-reload-app').addEventListener('click', () => {
    if (hasAnyUnsavedChanges()) {
      showUnsavedModal(() => location.reload());
    } else {
      location.reload();
    }
  });

  // Method select color
  const methodSel = document.getElementById('method-select');
  methodSel.addEventListener('change', () => {
    methodSel.className = `method-select method-${methodSel.value}`;
    state.currentRequest.method = methodSel.value;
  });

  // Active environment indicator - click to open Env tab
  document.getElementById('env-indicator-name')?.addEventListener('click', () => {
    // Switch to environments tab in sidebar
    document.querySelectorAll('.sidebar .tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector('.sidebar .tab-btn[data-tab="environments"]')?.classList.add('active');
    document.querySelectorAll('.sidebar .sidebar-content').forEach(el => el.classList.add('hidden'));
    document.getElementById('tab-environments')?.classList.remove('hidden');
  });

  // Save button
  document.getElementById('btn-save').addEventListener('click', () => {
    document.getElementById('save-req-name').value = document.getElementById('url-input').value.split('/').pop() || 'New Request';
    updateSaveCollectionSelect();
    openModal('modal-save');
  });
  document.getElementById('btn-confirm-save').addEventListener('click', saveRequest);
  document.getElementById('save-req-collection').addEventListener('change', e => {
    document.getElementById('new-collection-form').style.display = e.target.value === '_new' ? 'flex' : 'none';
  });

  // New collection button
  document.getElementById('btn-new-collection').addEventListener('click', openNewCollectionModal);
  document.getElementById('btn-confirm-collection').addEventListener('click', saveCollection);

  // Theme toggle
  (function initTheme() {
    const THEME_KEY = 'api-client-theme';
    const themeBtn = document.getElementById('btn-theme-toggle');
    const savedTheme = localStorage.getItem(THEME_KEY);
    
    function applyTheme(theme) {
      const isDark = theme !== 'light';
      if (theme === 'light') {
        document.body.classList.add('theme-light');
        document.documentElement.setAttribute('data-theme', 'light');
        themeBtn.textContent = '☀️';
        themeBtn.title = 'Switch to Dark theme';
      } else {
        document.body.classList.remove('theme-light');
        document.documentElement.setAttribute('data-theme', 'dark');
        themeBtn.textContent = '🌙';
        themeBtn.title = 'Switch to Light theme';
      }
    }
    
    // Apply saved theme on load
    applyTheme(savedTheme || 'dark');
    
    themeBtn?.addEventListener('click', () => {
      const isLight = document.body.classList.contains('theme-light');
      const newTheme = isLight ? 'dark' : 'light';
      localStorage.setItem(THEME_KEY, newTheme);
      applyTheme(newTheme);
      showToast(`Theme: ${newTheme === 'light' ? 'Light' : 'Dark'}`);
    });
  })();

  // ── Relay toggle ──
  (function initRelay() {
    const RELAY_ENABLED_KEY = 'api-client-relay-enabled';
    const RELAY_URL_KEY = 'api-client-relay-url';
    const relayCheckbox = document.getElementById('relay-enabled');
    const relayUrlInput = document.getElementById('relay-url');
    const relayUrlRow = document.getElementById('relay-url-row');
    
    // Load saved relay settings
    const savedEnabled = localStorage.getItem(RELAY_ENABLED_KEY) === 'true';
    const savedUrl = localStorage.getItem(RELAY_URL_KEY) || '';
    
    state.relayEnabled = savedEnabled;
    state.relayUrl = savedUrl;
    
    if (relayCheckbox) relayCheckbox.checked = savedEnabled;
    if (relayUrlInput) relayUrlInput.value = savedUrl;
    if (relayUrlRow) relayUrlRow.classList.toggle('visible', savedEnabled);
    
    relayCheckbox?.addEventListener('change', () => {
      state.relayEnabled = relayCheckbox.checked;
      localStorage.setItem(RELAY_ENABLED_KEY, state.relayEnabled);
      relayUrlRow?.classList.toggle('visible', state.relayEnabled);
      showToast(state.relayEnabled ? 'Relay enabled' : 'Relay disabled');
    });
    
    relayUrlInput?.addEventListener('input', () => {
      state.relayUrl = relayUrlInput.value.trim();
      localStorage.setItem(RELAY_URL_KEY, state.relayUrl);
    });
  })();

  // Collection modal tabs
  document.querySelectorAll('.col-mtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.col-mtab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.col-tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== btn.dataset.ctab));
      // Update pre-script badge
      const hasScript = !!document.getElementById('collection-prescript-input').value.trim();
      document.getElementById('col-prescript-badge').classList.toggle('hidden', !hasScript);
    });
  });
  // Update badge as user types in pre-script
  document.getElementById('collection-prescript-input').addEventListener('input', () => {
    const has = !!document.getElementById('collection-prescript-input').value.trim();
    document.getElementById('col-prescript-badge').classList.toggle('hidden', !has);
  });
  // Wire autocomplete to collection pre-script editor
  const colPreScriptInput = document.getElementById('collection-prescript-input');
  if (colPreScriptInput) setupEditorAutocomplete(colPreScriptInput);

  // Collection pre-script chips insert
  document.querySelectorAll('.col-ps-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      insertAtCursor(colPreScriptInput, chip.dataset.var);
    });
  });

  // ── cURL import/export ──
  document.getElementById('btn-import-curl').addEventListener('click', () => {
    const input = document.getElementById('curl-import-input');
    input.value = '';
    document.getElementById('curl-preview').classList.add('hidden');
    document.getElementById('curl-preview-error').classList.add('hidden');
    document.getElementById('curl-save-options').classList.add('hidden');
    document.getElementById('btn-confirm-import-curl').disabled = true;
    // Reset save options
    document.getElementById('curl-req-name').value = '';
    document.getElementById('curl-save-collection').value = '';
    document.getElementById('curl-new-col-name').value = '';
    document.getElementById('curl-new-collection-form').classList.add('hidden');
    // Populate collection dropdown
    updateCurlSaveCollectionSelect();
    openModal('modal-import-curl');
    setTimeout(() => input.focus(), 100);
  });

  // Populate collection dropdown for curl import
  function updateCurlSaveCollectionSelect() {
    const select = document.getElementById('curl-save-collection');
    select.innerHTML = '<option value="">Don\'t save (just load)</option><option value="_new">+ Create New Collection</option>' +
      state.collections.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  }

  // Collection dropdown change handler for curl import
  document.getElementById('curl-save-collection').addEventListener('change', (e) => {
    const form = document.getElementById('curl-new-collection-form');
    if (e.target.value === '_new') {
      form.classList.remove('hidden');
      document.getElementById('curl-new-col-name').focus();
    } else {
      form.classList.add('hidden');
    }
  });

  // Live preview: parse as user types/pastes
  document.getElementById('curl-import-input').addEventListener('input', () => {
    const raw = document.getElementById('curl-import-input').value.trim();
    const confirmBtn = document.getElementById('btn-confirm-import-curl');
    const previewEl  = document.getElementById('curl-preview');
    const errorEl    = document.getElementById('curl-preview-error');
    const saveOpts   = document.getElementById('curl-save-options');

    if (!raw) {
      previewEl.classList.add('hidden');
      errorEl.classList.add('hidden');
      saveOpts.classList.add('hidden');
      confirmBtn.disabled = true;
      return;
    }

    try {
      const p = parseCurl(raw);
      errorEl.classList.add('hidden');

      if (!p.url) {
        previewEl.classList.add('hidden');
        saveOpts.classList.add('hidden');
        errorEl.textContent = '⚠ Could not detect URL. Make sure the cURL starts with: curl [options] <URL>';
        errorEl.classList.remove('hidden');
        confirmBtn.disabled = true;
        return;
      }

      const methodCls = `method-${p.method}`;
      document.getElementById('prev-method').innerHTML   = `<span class="req-method-badge ${methodCls} bg-${p.method}">${p.method}</span>`;
      document.getElementById('prev-url').textContent    = p.url;
      document.getElementById('prev-headers').textContent = p.headers.length
        ? p.headers.map(h => `${h.key}: ${h.value.substring(0,40)}${h.value.length>40?'…':''}`).join(' | ')
        : '(none)';
      document.getElementById('prev-auth').textContent   = p.auth ? `${p.auth.type}` : '(none)';
      document.getElementById('prev-body').textContent   = p.body
        ? `${p.bodyType.toUpperCase()} — ${p.body.substring(0,60)}${p.body.length>60?'…':''}`
        : '(none)';

      previewEl.classList.remove('hidden');
      saveOpts.classList.remove('hidden');
      confirmBtn.disabled = false;
      
      // Auto-generate request name from URL path (always update when cURL changes)
      const nameInput = document.getElementById('curl-req-name');
      try {
        const urlObj = new URL(p.url.replace(/\{\{[^}]+\}\}/g, 'x'));
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        const suggestedName = pathParts.length > 0 
          ? pathParts.slice(-2).join(' / ')
          : urlObj.hostname;
        nameInput.value = suggestedName;
      } catch { nameInput.value = 'Imported Request'; }
    } catch (e) {
      previewEl.classList.add('hidden');
      saveOpts.classList.add('hidden');
      errorEl.textContent = `Parse error: ${e.message}`;
      errorEl.classList.remove('hidden');
      confirmBtn.disabled = true;
    }
  });

  document.getElementById('btn-export-curl').addEventListener('click', () => {
    document.getElementById('curl-export-output').textContent = generateCurl();
    openModal('modal-export-curl');
  });

  document.getElementById('btn-show-dynvars').addEventListener('click', showDynVarsModal);

  document.getElementById('btn-confirm-import-curl').addEventListener('click', async () => {
    const raw = document.getElementById('curl-import-input').value.trim();
    if (!raw) { showToast('Paste a cURL command first', 'error'); return; }

    try {
      const parsed = parseCurl(raw);

      if (!parsed.url) {
        showToast('Could not detect URL in cURL command', 'error');
        return;
      }

      // Populate form
      document.getElementById('url-input').value = parsed.url;
      document.getElementById('method-select').value = parsed.method;
      document.getElementById('method-select').className = `method-select method-${parsed.method}`;
      initKVRows('headers', parsed.headers);
      setBodyType(parsed.bodyType);
      if (window.setBodyEditorValue) {
        window.setBodyEditorValue(parsed.body);
      } else {
        document.getElementById('body-input').value = parsed.body;
      }
      // Update syntax highlighting and line numbers
      if (window.updateBodyHighlight) window.updateBodyHighlight();
      if (window.updateBodyLineNumbers) window.updateBodyLineNumbers();

      if (parsed.auth) {
        state.currentRequest.auth = parsed.auth;
        document.getElementById('auth-type').value = parsed.auth.type;
        renderAuthFields(parsed.auth.type, parsed.auth);
      }

      // Check if user wants to save to collection
      const saveColSelect = document.getElementById('curl-save-collection').value;
      const reqName = document.getElementById('curl-req-name').value.trim() || 'Imported Request';
      
      if (saveColSelect) {
        let collectionId = saveColSelect;
        
        // Create new collection if needed
        if (saveColSelect === '_new') {
          const newColName = document.getElementById('curl-new-col-name').value.trim();
          if (!newColName) {
            showToast('Please enter a collection name', 'error');
            return;
          }
          const newCol = await apiCall('/api/collections', {
            method: 'POST',
            body: { name: newColName, requests: [] }
          });
          collectionId = newCol.id;
          await loadCollections();
        }
        
        // Check for duplicate request (same name in same collection)
        const existingCol = state.collections.find(c => c.id === collectionId);
        if (existingCol) {
          const duplicateReq = existingCol.requests.find(r => r.name === reqName);
          if (duplicateReq) {
            if (!confirm(`A request named "${reqName}" already exists in this collection.\n\nDo you want to add another?`)) {
              return;
            }
          }
        }
        
        // Prepare request data
        const headersObj = {};
        parsed.headers.forEach(h => { headersObj[h.key] = h.value; });
        
        const reqPayload = {
          name: reqName,
          method: parsed.method,
          url: parsed.url,
          headers: headersObj,
          body: parsed.body,
          bodyType: parsed.bodyType,
          auth: parsed.auth || { type: 'none' },
        };
        
        // Save to collection
        await apiCall(`/api/collections/${collectionId}/requests`, {
          method: 'POST',
          body: reqPayload
        });
        
        await loadCollections();
        renderCollections();
        
        // Find and load the saved request
        const col = state.collections.find(c => c.id === collectionId);
        if (col && col.requests.length > 0) {
          const savedReq = col.requests[col.requests.length - 1];
          loadSavedRequest(collectionId, savedReq.id);
        }
        
        closeModal('modal-import-curl');
        showToast(`✓ Imported & saved: ${reqName}`);
        return;
      }

      // Switch to relevant tab so user sees the result
      if (parsed.body && parsed.bodyType !== 'none') {
        document.querySelectorAll('.req-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.req-content').forEach(c => c.classList.add('hidden'));
        const bodyTab = document.querySelector('.req-tab[data-tab="body"]');
        if (bodyTab) { bodyTab.classList.add('active'); document.getElementById('tab-body')?.classList.remove('hidden'); }
      } else if (parsed.headers.length > 0) {
        document.querySelectorAll('.req-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.req-content').forEach(c => c.classList.add('hidden'));
        const hdrTab = document.querySelector('.req-tab[data-tab="headers"]');
        if (hdrTab) { hdrTab.classList.add('active'); document.getElementById('tab-headers')?.classList.remove('hidden'); }
      }

      closeModal('modal-import-curl');

      // Flash the URL field so user notices it changed
      const urlEl = document.getElementById('url-input');
      urlEl.classList.add('field-flash');
      setTimeout(() => urlEl.classList.remove('field-flash'), 1200);

      // Informative toast
      const summary = [
        `${parsed.method} ${parsed.url.substring(0, 50)}${parsed.url.length > 50 ? '…' : ''}`,
        parsed.headers.length ? `${parsed.headers.length} header(s)` : null,
        parsed.body ? `body: ${parsed.bodyType}` : null,
      ].filter(Boolean).join(' · ');
      showToast(`✓ Imported: ${summary}`);

    } catch (e) {
      showToast(`Import failed: ${e.message}`, 'error');
    }
  });

  document.getElementById('btn-copy-curl').addEventListener('click', () => {
    const text = document.getElementById('curl-export-output').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('cURL copied'));
  });

  // ── Collection import ──
  document.getElementById('btn-import-collection').addEventListener('click', () => {
    document.getElementById('import-collection-file').click();
  });

  document.getElementById('import-collection-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await doImportCollectionData(data);
      
      if (result.type === 'environment') {
        await loadEnvironments(); renderEnvironments();
        showToast(`Imported ${result.count} environment(s)`);
      } else {
        await loadCollections(); renderCollections();
        showToast(`Imported ${result.count} collection(s)`);
      }
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    }
    e.target.value = ''; // reset file input
  });


  // ── Collection search ──
  const colSearchEl = document.getElementById('col-search');
  colSearchEl.addEventListener('input', e => {
    searchCollections(e.target.value);
  });
  // Clear button
  document.getElementById('btn-col-search-clear').addEventListener('click', () => {
    colSearchEl.value = '';
    document.getElementById('btn-col-search-clear').classList.add('hidden');
    renderCollections();
    colSearchEl.focus();
  });
  // Ctrl/Cmd+F focuses collection search when sidebar is on Collections tab
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      const colTab = document.querySelector('.tab-btn[data-tab="collections"]');
      if (colTab && colTab.classList.contains('active')) {
        e.preventDefault();
        colSearchEl.focus();
        colSearchEl.select();
      }
    }
    if (e.key === 'Escape' && document.activeElement === colSearchEl) {
      colSearchEl.value = '';
      document.getElementById('btn-col-search-clear').classList.add('hidden');
      renderCollections();
      colSearchEl.blur();
    }
  });

  // ── Sidebar tabs ──
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['collections','history','environments'].forEach(t => {
        document.getElementById(`tab-${t}`)?.classList.toggle('hidden', btn.dataset.tab !== t);
      });
    });
  });

  // ── Request tabs ──
  document.querySelectorAll('.req-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.req-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.req-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(`tab-${btn.dataset.tab}`)?.classList.remove('hidden');
    });
  });

  // ── Response tabs ──
  document.querySelectorAll('.res-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.res-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.response-body-container').forEach(c => c.classList.add('hidden'));
      document.getElementById(btn.dataset.tab)?.classList.remove('hidden');
    });
  });

  // ── Add KV rows ──
  document.querySelectorAll('.add-row-btn').forEach(btn => {
    btn.addEventListener('click', () => createKVRow(btn.dataset.target));
  });

  // ── Body type ──
  document.querySelectorAll('.body-type-btn').forEach(btn => {
    btn.addEventListener('click', () => setBodyType(btn.dataset.type));
  });

  // ── Body editor references (CodeMirror is initialized separately) ──
  const bodyInput = document.getElementById('body-input');
  const bodyWrap  = document.getElementById('body-editor-wrap');

  // ── Undo/Redo system for body editor ──
  const bodyHistory = {
    stack: [],
    index: -1,
    maxSize: 100,
    isUndoRedo: false,
    
    reset(initialValue) {
      this.stack = [initialValue || ''];
      this.index = 0;
      this.isUndoRedo = false;
    },
    
    push(value) {
      if (this.isUndoRedo) return;
      // Remove any redo states
      if (this.index < this.stack.length - 1) {
        this.stack = this.stack.slice(0, this.index + 1);
      }
      // Don't push if same as current
      if (this.stack[this.index] === value) return;
      // Add new state
      this.stack.push(value);
      if (this.stack.length > this.maxSize) {
        this.stack.shift();
      } else {
        this.index++;
      }
    },
    
    undo() {
      if (this.index > 0) {
        this.index--;
        return this.stack[this.index];
      }
      return null;
    },
    
    redo() {
      if (this.index < this.stack.length - 1) {
        this.index++;
        return this.stack[this.index];
      }
      return null;
    },
    
    canUndo() { return this.index > 0; },
    canRedo() { return this.index < this.stack.length - 1; }
  };
  
  // Initialize with empty state
  bodyHistory.push('');

  // Debounced history push (save state after typing stops)
  let historyTimeout = null;
  function saveToHistory() {
    clearTimeout(historyTimeout);
    historyTimeout = setTimeout(() => {
      bodyHistory.push(document.getElementById('body-input').value);
    }, 500); // Save after 500ms of no typing
  }

  // Handle Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y (redo)
  bodyInput.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    
    if (mod && e.key === 'z' && !e.shiftKey) {
      // Undo
      e.preventDefault();
      const prev = bodyHistory.undo();
      if (prev !== null) {
        bodyHistory.isUndoRedo = true;
        document.getElementById('body-input').value = prev;
        updateBodyMeta();
        updateBodyLineNumbers();
        if (typeof updateBodyHighlight === 'function') updateBodyHighlight();
        bodyHistory.isUndoRedo = false;
      }
    } else if (mod && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
      // Redo
      e.preventDefault();
      const next = bodyHistory.redo();
      if (next !== null) {
        bodyHistory.isUndoRedo = true;
        document.getElementById('body-input').value = next;
        updateBodyMeta();
        updateBodyLineNumbers();
        if (typeof updateBodyHighlight === 'function') updateBodyHighlight();
        bodyHistory.isUndoRedo = false;
      }
    }
  });

  // ===== Body Editor: Syntax Highlighting & Line Numbers =====
  
  // JSON syntax highlighting function
  function highlightJSON(text) {
    if (!text) return '';
    
    // Process line by line to handle comments properly
    const lines = text.split('\n');
    const highlightedLines = lines.map(line => {
      // Check if line is a comment line (starts with // after optional whitespace)
      const commentMatch = line.match(/^(\s*)(\/\/.*)$/);
      if (commentMatch) {
        const indent = commentMatch[1];
        const comment = commentMatch[2]
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return indent + '<span class="hl-comment">' + comment + '</span>';
      }
      
      // Check for inline comment (must not be inside a string)
      let inString = false;
      let stringChar = '';
      let escaped = false;
      let commentStart = -1;
      
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (!inString && (ch === '"' || ch === "'")) { inString = true; stringChar = ch; }
        else if (inString && ch === stringChar) { inString = false; }
        else if (!inString && ch === '/' && line[i + 1] === '/') {
          commentStart = i;
          break;
        }
      }
      
      let mainPart = line;
      let commentPart = '';
      
      if (commentStart >= 0) {
        mainPart = line.slice(0, commentStart);
        commentPart = '<span class="hl-comment">' + line.slice(commentStart)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;') + '</span>';
      }
      
      // Escape HTML entities for main part
      let html = mainPart
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      // Highlight variables {{...}}
      html = html.replace(/(\{\{[^}]+\}\})/g, '<span class="hl-variable">$1</span>');
      
      // Highlight JSON keys (before colon)
      html = html.replace(/"([^"\\]*(\\.[^"\\]*)*)"\s*:/g, '<span class="hl-key">"$1"</span>:');
      
      // Highlight string values (not keys)
      html = html.replace(/:\s*"([^"\\]*(\\.[^"\\]*)*)"/g, ': <span class="hl-string">"$1"</span>');
      html = html.replace(/(\[\s*)"([^"\\]*(\\.[^"\\]*)*)"/g, '$1<span class="hl-string">"$2"</span>');
      html = html.replace(/(,\s*)"([^"\\]*(\\.[^"\\]*)*)"/g, '$1<span class="hl-string">"$2"</span>');
      
      // Highlight numbers
      html = html.replace(/:\s*(-?\d+\.?\d*([eE][+-]?\d+)?)/g, ': <span class="hl-number">$1</span>');
      html = html.replace(/(\[\s*)(-?\d+\.?\d*)/g, '$1<span class="hl-number">$2</span>');
      html = html.replace(/(,\s*)(-?\d+\.?\d*)/g, '$1<span class="hl-number">$2</span>');
      
      // Highlight booleans and null
      html = html.replace(/:\s*(true|false)/g, ': <span class="hl-bool">$1</span>');
      html = html.replace(/:\s*(null)/g, ': <span class="hl-null">$1</span>');
      html = html.replace(/(\[\s*)(true|false|null)/g, '$1<span class="hl-bool">$2</span>');
      html = html.replace(/(,\s*)(true|false|null)/g, '$1<span class="hl-bool">$2</span>');
      
      return html + commentPart;
    });
    
    return highlightedLines.join('\n');
  }
  
  // Update syntax highlighting in the highlight layer
  function updateBodyHighlight() {
    const textarea = document.getElementById('body-input');
    const highlightLayer = document.getElementById('body-highlight-layer');
    if (!textarea || !highlightLayer) return;
    
    const text = textarea.value;
    const highlighted = highlightJSON(text);
    highlightLayer.innerHTML = highlighted || '&nbsp;';
    
    // Sync textarea size to match highlight layer
    setTimeout(() => {
      const hlHeight = highlightLayer.offsetHeight;
      const hlWidth = highlightLayer.offsetWidth;
      if (hlHeight > 200) {
        textarea.style.height = hlHeight + 'px';
      }
      if (hlWidth > textarea.offsetWidth) {
        textarea.style.width = hlWidth + 'px';
      }
    }, 0);
  }
  
  // Update line numbers for body editor
  function updateBodyLineNumbers() {
    const lineNumbers = document.getElementById('body-line-numbers');
    const text = document.getElementById('body-input')?.value || '';
    if (!lineNumbers) return;
    
    const lines = text.split('\n');
    let html = '<div class="body-line-numbers-inner">';
    for (let i = 0; i < lines.length; i++) {
      html += `<div>${i + 1}</div>`;
    }
    html += '</div>';
    lineNumbers.innerHTML = html || '<div class="body-line-numbers-inner"><div>1</div></div>';
  }
  
  // Sync scroll between editor and line numbers
  function syncBodyScroll() {
    const scrollContainer = document.getElementById('body-editor-scroll');
    const lineNumbers = document.getElementById('body-line-numbers');
    if (lineNumbers && scrollContainer) {
      const inner = lineNumbers.querySelector('.body-line-numbers-inner');
      if (inner) {
        inner.style.transform = `translateY(-${scrollContainer.scrollTop}px)`;
      }
    }
  }
  
  // Handle input for body textarea
  if (bodyInput) {
    bodyInput.addEventListener('input', () => {
      updateBodyHighlight();
      updateBodyLineNumbers();
      if (typeof updateBodyMeta === 'function') updateBodyMeta();
      saveToHistory();
    });
    
    // Sync scroll between textarea/highlight layer and line numbers
    const scrollContainer = document.getElementById('body-editor-scroll');
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', syncBodyScroll);
    }
  }
  
  // Initialize on load
  setTimeout(() => {
    updateBodyHighlight();
    updateBodyLineNumbers();
  }, 100);
  
  // Export functions globally
  window.updateBodyHighlight = updateBodyHighlight;
  window.updateBodyLineNumbers = updateBodyLineNumbers;
  window.bodyHistory = bodyHistory;

  // ===== Script Editor: Syntax Highlighting for Pre-Script & Post-Script =====
  
  // JavaScript syntax highlighting function
  function highlightJS(text) {
    if (!text) return '';
    
    const jsKeywords = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|typeof|instanceof|in|of|class|extends|import|export|default|async|await|yield)\b/g;
    const pmObject = /\b(pm)\b/g;
    
    const lines = text.split('\n');
    const highlightedLines = lines.map(line => {
      // Check for comment line
      const commentMatch = line.match(/^(\s*)(\/\/.*)$/);
      if (commentMatch) {
        const indent = commentMatch[1];
        const comment = commentMatch[2]
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return indent + '<span class="hl-js-comment">' + comment + '</span>';
      }
      
      // Check for inline comment
      let inString = false;
      let stringChar = '';
      let escaped = false;
      let commentStart = -1;
      
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (!inString && (ch === '"' || ch === "'" || ch === '`')) { inString = true; stringChar = ch; }
        else if (inString && ch === stringChar) { inString = false; }
        else if (!inString && ch === '/' && line[i + 1] === '/') {
          commentStart = i;
          break;
        }
      }
      
      let mainPart = line;
      let commentPart = '';
      
      if (commentStart >= 0) {
        mainPart = line.slice(0, commentStart);
        commentPart = '<span class="hl-js-comment">' + line.slice(commentStart)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;') + '</span>';
      }
      
      // Escape HTML
      let html = mainPart
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      // Highlight strings (double quotes, single quotes, template literals)
      html = html.replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, '<span class="hl-js-string">"$1"</span>');
      html = html.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '<span class="hl-js-string">\'$1\'</span>');
      
      // Highlight pm object specially
      html = html.replace(pmObject, '<span class="hl-js-pm">$1</span>');
      
      // Highlight keywords
      html = html.replace(jsKeywords, '<span class="hl-js-keyword">$1</span>');
      
      // Highlight numbers
      html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-js-number">$1</span>');
      
      // Highlight method calls .methodName(
      html = html.replace(/\.([a-zA-Z_]\w*)\s*\(/g, '.<span class="hl-js-method">$1</span>(');
      
      // Highlight function declarations
      html = html.replace(/\b(function)\s+([a-zA-Z_]\w*)/g, '<span class="hl-js-keyword">$1</span> <span class="hl-js-function">$2</span>');
      
      return html + commentPart;
    });
    
    return highlightedLines.join('\n');
  }
  
  // Setup script editor (prescript or postscript)
  function setupScriptEditor(prefix) {
    const textarea = document.getElementById(`${prefix}-input`);
    const highlightLayer = document.getElementById(`${prefix}-highlight-layer`);
    const lineNumbers = document.getElementById(`${prefix}-line-numbers`);
    const scrollContainer = document.getElementById(`${prefix}-editor-scroll`);
    
    if (!textarea || !highlightLayer) return;
    
    function updateHighlight() {
      const text = textarea.value;
      const highlighted = highlightJS(text);
      highlightLayer.innerHTML = highlighted || '&nbsp;';
      
      // Sync sizes
      setTimeout(() => {
        const hlHeight = highlightLayer.offsetHeight;
        if (hlHeight > 100) {
          textarea.style.height = hlHeight + 'px';
        }
      }, 0);
    }
    
    function updateLineNumbers() {
      if (!lineNumbers) return;
      const text = textarea.value || '';
      const lines = text.split('\n');
      let html = '<div class="script-line-numbers-inner">';
      for (let i = 0; i < lines.length; i++) {
        html += `<div>${i + 1}</div>`;
      }
      html += '</div>';
      lineNumbers.innerHTML = html || '<div class="script-line-numbers-inner"><div>1</div></div>';
    }
    
    function syncScroll() {
      if (lineNumbers && scrollContainer) {
        const inner = lineNumbers.querySelector('.script-line-numbers-inner');
        if (inner) {
          inner.style.transform = `translateY(-${scrollContainer.scrollTop}px)`;
        }
      }
    }
    
    textarea.addEventListener('input', () => {
      updateHighlight();
      updateLineNumbers();
    });
    
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', syncScroll);
    }
    
    // Initialize
    updateHighlight();
    updateLineNumbers();
    
    // Export update functions
    window[`update${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Highlight`] = updateHighlight;
    window[`update${prefix.charAt(0).toUpperCase() + prefix.slice(1)}LineNumbers`] = updateLineNumbers;
  }
  
  // Initialize script editors
  setupScriptEditor('prescript');
  setupScriptEditor('postscript');
  setupScriptEditor('collection-prescript');
  
  // Helper to update all script highlights
  window.updateScriptHighlights = function() {
    if (window.updatePrescriptHighlight) window.updatePrescriptHighlight();
    if (window.updatePrescriptLineNumbers) window.updatePrescriptLineNumbers();
    if (window.updatePostscriptHighlight) window.updatePostscriptHighlight();
    if (window.updatePostscriptLineNumbers) window.updatePostscriptLineNumbers();
  };
  
  // Helper to update collection pre-script highlights
  window.updateCollectionPrescriptHighlights = function() {
    if (window['updateCollection-prescriptHighlight']) window['updateCollection-prescriptHighlight']();
    if (window['updateCollection-prescriptLineNumbers']) window['updateCollection-prescriptLineNumbers']();
  };

  document.getElementById('btn-beautify-body').addEventListener('click', () => {
    try {
      // Save current state for undo
      const current = window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || '');
      bodyHistory.push(current);
      // Beautify JSON while preserving comment lines
      const beautified = beautifyWithComments(current);
      if (window.setBodyEditorValue) {
        window.setBodyEditorValue(beautified);
      } else {
        document.getElementById('body-input').value = beautified;
      }
      bodyHistory.push(beautified);
      if (typeof updateBodyMeta === 'function') updateBodyMeta();
      showToast('JSON beautified');
    } catch { showToast('Not valid JSON — cannot beautify', 'error'); }
  });

  document.getElementById('btn-copy-body').addEventListener('click', () => {
    const val = window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || '');
    if (!val) { showToast('Body is empty', 'error'); return; }
    navigator.clipboard.writeText(val).then(() => showToast('Body copied to clipboard'));
  });

  document.getElementById('btn-clear-body').addEventListener('click', () => {
    // Save current state for undo
    const current = window.getBodyEditorValue ? window.getBodyEditorValue() : (document.getElementById('body-input')?.value || '');
    bodyHistory.push(current);
    if (window.setBodyEditorValue) {
      window.setBodyEditorValue('');
    } else {
      document.getElementById('body-input').value = '';
    }
    bodyHistory.push('');
    if (typeof updateBodyMeta === 'function') updateBodyMeta();
    if (typeof updateBodyLineNumbers === 'function') updateBodyLineNumbers();
  });

  // Keyboard shortcuts inside body textarea
  bodyInput.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && e.key === 'F') {   // Cmd/Ctrl+Shift+F = Beautify
      e.preventDefault();
      document.getElementById('btn-beautify-body').click();
    } else if (mod && e.key === '/') {            // Cmd/Ctrl+/ = Toggle comment
      e.preventDefault();
      // Save current state before toggle for undo (force save, bypass debounce)
      clearTimeout(historyTimeout);
      bodyHistory.push(bodyInput.value);
      toggleComment(bodyInput);
      // Save new state immediately after toggle
      bodyHistory.push(bodyInput.value);
      updateBodyMeta();
      if (typeof updateBodyHighlight === 'function') updateBodyHighlight();
      if (typeof updateBodyLineNumbers === 'function') updateBodyLineNumbers();
    } else if (e.key === 'Tab') {                 // Tab = indent (2 spaces)
      e.preventDefault();
      const s = bodyInput.selectionStart;
      const v = bodyInput.value;
      bodyInput.value = v.slice(0, s) + '  ' + v.slice(bodyInput.selectionEnd);
      bodyInput.selectionStart = bodyInput.selectionEnd = s + 2;
    }
  });

  function toggleComment(textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    
    // Find line boundaries
    let lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    
    // Get selected lines
    const selectedText = value.slice(lineStart, lineEnd);
    const lines = selectedText.split('\n');
    
    // Check if all lines are commented
    const allCommented = lines.every(line => line.trimStart().startsWith('//'));
    
    // Toggle comments
    const newLines = lines.map(line => {
      if (allCommented) {
        // Remove comment
        return line.replace(/^(\s*)\/\/\s?/, '$1');
      } else {
        // Add comment
        const indent = line.match(/^(\s*)/)[1];
        const rest = line.slice(indent.length);
        return indent + '// ' + rest;
      }
    });
    
    const newText = newLines.join('\n');
    textarea.value = value.slice(0, lineStart) + newText + value.slice(lineEnd);
    
    // Restore selection
    textarea.selectionStart = lineStart;
    textarea.selectionEnd = lineStart + newText.length;
  }

  // ── Auth ──
  document.getElementById('auth-type').addEventListener('change', e => {
    state.currentRequest.auth = { type: e.target.value };
    renderAuthFields(e.target.value);
  });

  // ── Response tree/raw toggle ──
  document.getElementById('btn-pretty').addEventListener('click', () => {
    state.responseView = 'pretty';
    document.getElementById('btn-pretty').classList.add('active');
    document.getElementById('btn-raw').classList.remove('active');
    if (state.lastResponse) renderResponse(state.lastResponse);
  });
  document.getElementById('btn-raw').addEventListener('click', () => {
    state.responseView = 'raw';
    document.getElementById('btn-raw').classList.add('active');
    document.getElementById('btn-pretty').classList.remove('active');
    if (state.lastResponse) renderResponse(state.lastResponse);
  });

  // ── Expand / Collapse All ──
  document.getElementById('btn-expand-all')?.addEventListener('click', () => setAllTreeNodes(true));
  document.getElementById('btn-collapse-all')?.addEventListener('click', () => setAllTreeNodes(false));

  // ── Search in response ──
  document.getElementById('res-search-input')?.addEventListener('input', (e) => {
    searchInTree(e.target.value);
  });

  // ── JSON Path Filter ──
  setupJsonPathFilter();

  // ── Copy/Download response ──
  document.getElementById('btn-copy-response').addEventListener('click', () => {
    if (state.lastResponse) navigator.clipboard.writeText(state.lastResponse.body).then(() => showToast('Copied'));
  });
  document.getElementById('btn-download-response').addEventListener('click', () => {
    if (!state.lastResponse) return;
    const ct = state.lastResponse.headers['content-type'] || 'text/plain';
    let blob, filename;
    if (state.lastResponse.isBase64) {
      const bin = atob(state.lastResponse.body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: ct }); filename = 'response.bin';
    } else {
      blob = new Blob([state.lastResponse.body], { type: ct });
      filename = ct.includes('json') ? 'response.json' : ct.includes('xml') ? 'response.xml' : 'response.txt';
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    URL.revokeObjectURL(a.href);
  });

  // ── Clear history ──
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (!confirm('Clear all history?')) return;
    await apiCall('/api/history', { method: 'DELETE' });
    await loadHistory(); renderHistory();
    showToast('History cleared');
  });

  // ── Environments ──
  document.getElementById('btn-new-env').addEventListener('click', () => {
    state.editingEnvId = null;
    document.getElementById('modal-env-title').textContent = 'New Environment';
    document.getElementById('env-name-input').value = '';
    initKVRows('env-vars', []);
    resetEnvModalView('table');
    openModal('modal-env');
  });
  document.getElementById('btn-confirm-env').addEventListener('click', saveEnvironment);

  // ── Env Table ↔ JSON view toggle ──
  document.getElementById('btn-env-table').addEventListener('click', () => {
    if (!document.getElementById('env-json-view').classList.contains('hidden')) {
      envJsonToTable();
    }
    resetEnvModalView('table');
  });

  document.getElementById('btn-env-json').addEventListener('click', () => {
    envTableToJson();
    resetEnvModalView('json');
  });

  // Format JSON button in JSON view
  document.getElementById('btn-env-json-format').addEventListener('click', () => {
    try {
      const el  = document.getElementById('env-json-input');
      el.value  = JSON.stringify(JSON.parse(el.value), null, 2);
      document.getElementById('env-json-status').innerHTML = '<span class="json-ok">✓ formatted</span>';
    } catch (e) {
      document.getElementById('env-json-status').innerHTML = `<span class="json-err">✗ ${e.message}</span>`;
    }
  });

  // Live JSON validation as user types
  document.getElementById('env-json-input').addEventListener('input', () => {
    const text = document.getElementById('env-json-input').value.trim();
    const st   = document.getElementById('env-json-status');
    if (!text) { st.textContent = ''; return; }
    try {
      const data  = JSON.parse(text);
      const count = Array.isArray(data) ? data.length
                  : data.values ? data.values.length
                  : Object.keys(data).length;
      st.innerHTML = `<span class="json-ok">✓ ${count} variables</span>`;
    } catch {
      st.innerHTML = '<span class="json-err">✗ invalid JSON</span>';
    }
  });

  document.getElementById('active-env-select').addEventListener('change', e => {
    state.activeEnvId = e.target.value || null;
    renderEnvironments();
    refreshAllVariableOverlays(); // Refresh highlights when env changes
    showToast(state.activeEnvId ? 'Environment activated' : 'No active environment');
  });

  // ── Modal close ──
  document.querySelectorAll('.modal-close, [data-modal]').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.modal) closeModal(btn.dataset.modal); });
  });
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal.id); });
  });

  // ── Dynamic var chips — insert at cursor ──
  document.querySelectorAll('.var-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const text = chip.dataset.var;
      // Find nearest panel and determine which textarea to use
      const panel = chip.closest('.req-content');
      const panelId = panel?.id;
      
      let textarea = null;
      if (panelId === 'tab-body') {
        textarea = document.getElementById('body-input');
      } else if (panelId === 'tab-prescript') {
        textarea = document.getElementById('prescript-input');
      } else if (panelId === 'tab-postscript') {
        textarea = document.getElementById('postscript-input');
      } else {
        textarea = panel?.querySelector('textarea');
      }
      
      if (textarea) {
        insertAtCursor(textarea, text);
      } else {
        navigator.clipboard.writeText(text).then(() => showToast(`Copied: ${text}`));
      }
    });
  });

  // ── Dynamic vars modal ──
  document.getElementById('btn-show-dynvars').addEventListener('click', showDynVarsModal);

  // keyboard shortcut: ?
  document.addEventListener('keydown', e => {
    if (e.key === '?' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
      showDynVarsModal();
    }
  });

  // ── Collection modal fullscreen toggle ──
  document.getElementById('btn-col-modal-fs').addEventListener('click', () => {
    const box   = document.querySelector('#modal-collection .modal-box');
    const isFS  = box.classList.toggle('modal-fullscreen');
    const btn   = document.getElementById('btn-col-modal-fs');
    btn.textContent = isFS ? '⤡' : '⤢';
    btn.title       = isFS ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)';
  });

  // F key → toggle fullscreen when collection modal is open
  document.addEventListener('keydown', e => {
    if (document.getElementById('modal-collection').classList.contains('hidden')) return;
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'F') document.getElementById('btn-col-modal-fs').click();
  });

  // ── Autocomplete: script editors ──
  ['prescript-input', 'postscript-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) setupEditorAutocomplete(el);
  });

  // ── Delegated autocomplete: ALL value inputs (url, body, params, headers,
  //    form data, auth fields, env var values) — works for dynamic elements too
  const VALUE_SELECTOR = '#url-input, #body-input, .kv-input, .auth-field-input';

  document.addEventListener('input', e => {
    const el = e.target;
    if (!el.matches(VALUE_SELECTOR)) return;
    acState.wordEnd = el.selectionStart; // keep end updated
    acHandleValueInput(el);
  }, true);

  document.addEventListener('keydown', e => {
    const el = e.target;
    if (!acState.visible) return;
    if (!el.matches(VALUE_SELECTOR)) return;
    if (e.key === 'ArrowDown')       { e.preventDefault(); acMove(1); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); acMove(-1); }
    else if (e.key === 'Tab')        { e.preventDefault(); acAccept(); }
    else if (e.key === 'Enter')      { e.preventDefault(); acAccept(); }
    else if (e.key === 'Escape')     { e.preventDefault(); acHide(); }
  }, true);

  document.addEventListener('blur', e => {
    if (acState.visible && acState.textarea === e.target) {
      setTimeout(acHide, 160);
    }
  }, true);
}

function showDynVarsModal() {
  const now = new Date();
  document.getElementById('ex-uuid').textContent  = generateUUID();
  document.getElementById('ex-ts').textContent    = Math.floor(now.getTime() / 1000);
  document.getElementById('ex-ms').textContent    = now.getTime();
  document.getElementById('ex-iso').textContent   = now.toISOString();
  document.getElementById('ex-rand').textContent  = Math.floor(Math.random() * 1000);
  document.getElementById('ex-fmt').textContent   = formatTimestamp(now, 'YYYY-MM-DD HH:mm:ss');
  const el = document.getElementById('ex-custom-fmt');
  if (el) el.textContent = formatTimestamp(now, 'YYYY-MM-DDTHHmmss');
  openModal('modal-dynvars');
}

// ===== Autocomplete System =====

const AC_COMPLETIONS_SCRIPT = [
  // pm.utils — listed first so "uuid"/"timestamp" match these immediately
  { label: 'pm.utils.uuid()',              insert: 'pm.utils.uuid()',                                              detail: 'Generate random UUID v4',           kind: 'fn',   icon: '🔑' },
  { label: 'pm.utils.timestamp()',         insert: 'pm.utils.timestamp()',                                         detail: 'Unix epoch seconds',                kind: 'fn',   icon: '⏱' },
  { label: 'pm.utils.epochMs()',           insert: 'pm.utils.epochMs()',                                           detail: 'Unix epoch milliseconds',           kind: 'fn',   icon: '⏱' },
  { label: 'pm.utils.isoTimestamp()',      insert: 'pm.utils.isoTimestamp()',                                      detail: 'ISO 8601 timestamp string',         kind: 'fn',   icon: '⏱' },
  { label: 'pm.utils.formatTimestamp()',   insert: 'pm.utils.formatTimestamp("YYYY-MM-DD HH:mm:ss")',              detail: 'Custom format timestamp',           kind: 'fn',   icon: '⏱' },
  // pm.environment
  { label: 'pm.environment.get()',         insert: 'pm.environment.get("key")',                                    detail: 'Read environment variable',         kind: 'fn',   icon: '⚙' },
  { label: 'pm.environment.set()',         insert: 'pm.environment.set("key", "value")',                           detail: 'Write environment variable',        kind: 'fn',   icon: '⚙' },
  // pm.variables
  { label: 'pm.variables.get()',           insert: 'pm.variables.get("key")',                                      detail: 'Read request-scoped variable',      kind: 'fn',   icon: '📦' },
  { label: 'pm.variables.set()',           insert: 'pm.variables.set("key", "value")',                             detail: 'Write request-scoped variable',     kind: 'fn',   icon: '📦' },
  // pm.request (pre-script only)
  { label: 'pm.request.url',              insert: 'pm.request.url',                                               detail: 'Current request URL',               kind: 'prop', icon: '🌐' },
  { label: 'pm.request.method',           insert: 'pm.request.method',                                            detail: 'HTTP method',                       kind: 'prop', icon: '🌐' },
  { label: 'pm.request.body',             insert: 'pm.request.body',                                              detail: 'Request body string',               kind: 'prop', icon: '🌐' },
  { label: 'pm.request.headers.add()',    insert: 'pm.request.headers.add({ key: "X-Custom", value: "val" })',    detail: 'Add header before sending',         kind: 'fn',   icon: '📋' },
  // pm.response (post-script only)
  { label: 'pm.response.code',            insert: 'pm.response.code',                                             detail: 'HTTP status code (number)',          kind: 'prop', icon: '📨' },
  { label: 'pm.response.status',          insert: 'pm.response.status',                                           detail: 'HTTP status code',                  kind: 'prop', icon: '📨' },
  { label: 'pm.response.responseTime',    insert: 'pm.response.responseTime',                                     detail: 'Response time in ms',               kind: 'prop', icon: '📨' },
  { label: 'pm.response.json()',          insert: 'pm.response.json()',                                           detail: 'Parse response body as JSON',        kind: 'fn',   icon: '📨' },
  { label: 'pm.response.text()',          insert: 'pm.response.text()',                                           detail: 'Response body as plain text',        kind: 'fn',   icon: '📨' },
  { label: 'pm.response.headers.get()',   insert: 'pm.response.headers.get("Content-Type")',                      detail: 'Get response header value',         kind: 'fn',   icon: '📨' },
  // pm.test & pm.expect
  { label: 'pm.test()',                   insert: 'pm.test("Status is 200", function() {\n  pm.expect(pm.response.code).to.have.status(200);\n});', detail: 'Create test assertion', kind: 'fn', icon: '✅' },
  { label: 'pm.expect()',                 insert: 'pm.expect(pm.response.code)',                                  detail: 'Start assertion chain',             kind: 'fn',   icon: '✅' },
  { label: 'pm.expect().to.equal()',      insert: 'pm.expect(value).to.equal(expected)',                          detail: 'Assert strict equality',            kind: 'fn',   icon: '✅' },
  { label: 'pm.expect().to.include()',    insert: 'pm.expect(str).to.include("text")',                            detail: 'Assert string/array includes',      kind: 'fn',   icon: '✅' },
  { label: 'pm.expect().to.have.status()', insert: 'pm.expect(pm.response.code).to.have.status(200)',            detail: 'Assert HTTP status code',           kind: 'fn',   icon: '✅' },
  { label: 'pm.expect().to.be.a()',       insert: 'pm.expect(value).to.be.a("string")',                          detail: 'Assert value type',                 kind: 'fn',   icon: '✅' },
  // console
  { label: 'console.log()',               insert: 'console.log()',                                                detail: 'Log message to Console tab',        kind: 'fn',   icon: '💬' },
  { label: 'console.error()',             insert: 'console.error()',                                              detail: 'Log error to Console tab',          kind: 'fn',   icon: '💬' },
  { label: 'console.warn()',              insert: 'console.warn()',                                               detail: 'Log warning to Console tab',        kind: 'fn',   icon: '💬' },
  // JSON
  { label: 'JSON.parse()',                insert: 'JSON.parse(pm.response.text())',                               detail: 'Parse JSON string',                 kind: 'fn',   icon: '{}' },
  { label: 'JSON.stringify()',            insert: 'JSON.stringify(value, null, 2)',                               detail: 'Serialize to JSON string',          kind: 'fn',   icon: '{}' },
];

const AC_COMPLETIONS_DYNVAR = [
  { label: '{{$uuid}}',                   insert: '{{$uuid}}',                                                    detail: 'Random UUID v4',                    kind: 'var',  icon: '✨' },
  { label: '{{$timestamp}}',              insert: '{{$timestamp}}',                                               detail: 'Unix epoch (seconds)',              kind: 'var',  icon: '✨' },
  { label: '{{$epochMs}}',               insert: '{{$epochMs}}',                                                  detail: 'Unix epoch (milliseconds)',         kind: 'var',  icon: '✨' },
  { label: '{{$isoTimestamp}}',           insert: '{{$isoTimestamp}}',                                            detail: 'ISO 8601 timestamp',                kind: 'var',  icon: '✨' },
  { label: '{{$randomInt}}',              insert: '{{$randomInt}}',                                               detail: 'Random integer 0–999',              kind: 'var',  icon: '✨' },
  { label: '{{$timestampFormat:}}',       insert: '{{$timestampFormat:YYYY-MM-DD HH:mm:ss}}',                     detail: 'Custom format timestamp',           kind: 'var',  icon: '✨' },
];

// ── Header name suggestions ──────────────────────────────────────────────────
const AC_COMPLETIONS_HEADER_KEYS = [
  { label: 'Content-Type',             insert: 'Content-Type',             detail: 'Media type of the request body',       kind: 'hdr', icon: '📋' },
  { label: 'Authorization',            insert: 'Authorization',            detail: 'Auth credentials (Bearer/Basic)',       kind: 'hdr', icon: '🔐' },
  { label: 'Accept',                   insert: 'Accept',                   detail: 'Expected response content type',       kind: 'hdr', icon: '📋' },
  { label: 'Accept-Language',          insert: 'Accept-Language',          detail: 'Preferred language for response',      kind: 'hdr', icon: '📋' },
  { label: 'Accept-Encoding',          insert: 'Accept-Encoding',          detail: 'Acceptable content encodings',         kind: 'hdr', icon: '📋' },
  { label: 'Cache-Control',            insert: 'Cache-Control',            detail: 'Caching directives',                   kind: 'hdr', icon: '📋' },
  { label: 'X-Request-ID',             insert: 'X-Request-ID',             detail: 'Unique request identifier (uuid)',     kind: 'hdr', icon: '📋' },
  { label: 'X-Correlation-ID',         insert: 'X-Correlation-ID',         detail: 'Distributed tracing correlation ID',   kind: 'hdr', icon: '📋' },
  { label: 'X-API-Key',                insert: 'X-API-Key',                detail: 'API key authentication',               kind: 'hdr', icon: '🔐' },
  { label: 'X-Client-ID',              insert: 'X-Client-ID',              detail: 'Client identifier',                    kind: 'hdr', icon: '📋' },
  { label: 'X-Channel-ID',             insert: 'X-Channel-ID',             detail: 'Channel identifier',                   kind: 'hdr', icon: '📋' },
  { label: 'User-Agent',               insert: 'User-Agent',               detail: 'Client application identifier',        kind: 'hdr', icon: '📋' },
  { label: 'Referer',                  insert: 'Referer',                  detail: 'Origin URL of the request',            kind: 'hdr', icon: '📋' },
  { label: 'Origin',                   insert: 'Origin',                   detail: 'Origin domain for CORS',               kind: 'hdr', icon: '📋' },
  { label: 'Cookie',                   insert: 'Cookie',                   detail: 'Send cookies to server',               kind: 'hdr', icon: '📋' },
  { label: 'If-None-Match',            insert: 'If-None-Match',            detail: 'Conditional request (ETag)',            kind: 'hdr', icon: '📋' },
];

// ── Header value context suggestions ────────────────────────────────────────
const AC_HEADER_VALUE_HINTS = {
  'content-type': [
    { label: 'application/json',                  insert: 'application/json',                  detail: 'JSON body',             kind: 'val', icon: '{}' },
    { label: 'application/x-www-form-urlencoded', insert: 'application/x-www-form-urlencoded', detail: 'Form URL encoded',      kind: 'val', icon: '📝' },
    { label: 'multipart/form-data',               insert: 'multipart/form-data',               detail: 'File upload',           kind: 'val', icon: '📝' },
    { label: 'application/xml',                   insert: 'application/xml',                   detail: 'XML body',              kind: 'val', icon: '📝' },
    { label: 'text/plain',                        insert: 'text/plain',                        detail: 'Plain text',            kind: 'val', icon: '📝' },
    { label: 'text/html',                         insert: 'text/html',                         detail: 'HTML',                  kind: 'val', icon: '📝' },
  ],
  'accept': [
    { label: 'application/json',  insert: 'application/json',  detail: 'Expect JSON response',   kind: 'val', icon: '{}' },
    { label: '*/*',               insert: '*/*',               detail: 'Accept any type',         kind: 'val', icon: '📝' },
    { label: 'text/html',         insert: 'text/html',         detail: 'Expect HTML response',    kind: 'val', icon: '📝' },
    { label: 'application/xml',   insert: 'application/xml',   detail: 'Expect XML response',     kind: 'val', icon: '📝' },
  ],
  'authorization': [
    { label: 'Bearer {{$token}}', insert: 'Bearer {{$token}}', detail: 'Bearer token (use env var)',  kind: 'val', icon: '🔐' },
    { label: 'Bearer ',           insert: 'Bearer ',           detail: 'Bearer token',               kind: 'val', icon: '🔐' },
    { label: 'Basic ',            insert: 'Basic ',            detail: 'Basic auth base64',           kind: 'val', icon: '🔐' },
  ],
  'cache-control': [
    { label: 'no-cache',       insert: 'no-cache',        detail: 'Always revalidate',       kind: 'val', icon: '⚙' },
    { label: 'no-store',       insert: 'no-store',        detail: 'Never cache',             kind: 'val', icon: '⚙' },
    { label: 'max-age=3600',   insert: 'max-age=3600',    detail: 'Cache for 1 hour',        kind: 'val', icon: '⚙' },
    { label: 'public',         insert: 'public',          detail: 'Shareable cache',         kind: 'val', icon: '⚙' },
    { label: 'private',        insert: 'private',         detail: 'Private cache only',      kind: 'val', icon: '⚙' },
  ],
  'accept-language': [
    { label: 'en-US,en;q=0.9', insert: 'en-US,en;q=0.9', detail: 'English (US)',  kind: 'val', icon: '🌐' },
    { label: 'id-ID',          insert: 'id-ID',           detail: 'Indonesian',    kind: 'val', icon: '🌐' },
  ],
};

// Shared autocomplete state
const acState = { visible: false, selectedIdx: 0, items: [], textarea: null, wordStart: 0, wordEnd: 0 };

function acFuzzyMatch(query, label) {
  if (!query) return 0;
  // Normalize: strip non-alphanumeric
  const q = query.toLowerCase().replace(/[^a-z0-9$]/g, '');
  const l = label.toLowerCase().replace(/[^a-z0-9$]/g, '');
  if (!q.length) return 0;
  // Exact start
  if (l.startsWith(q)) return 3;
  // Substring
  if (l.includes(q)) return 2;
  // Fuzzy: all chars appear in order
  let qi = 0;
  for (let i = 0; i < l.length && qi < q.length; i++) {
    if (l[i] === q[qi]) qi++;
  }
  return qi === q.length ? 1 : 0;
}

function acGetWord(el) {
  const pos = el.selectionStart;
  const before = el.value.substring(0, pos);
  // Match identifier-like chars: letters, digits, dots, dollar, curly braces
  const m = before.match(/[\w.${{}]+$/);
  if (!m) return { word: '', start: pos, end: pos };
  return { word: m[0], start: pos - m[0].length, end: pos };
}

function acGetSuggestions(el, word) {
  const isScript = el.classList.contains('script-editor');
  const base = isScript ? AC_COMPLETIONS_SCRIPT : AC_COMPLETIONS_DYNVAR;

  // Add live env vars
  const envExtras = [];
  if (state.activeEnvId) {
    const env = state.environments.find(e => e.id === state.activeEnvId);
    (env?.variables || []).forEach(v => {
      if (isScript) {
        envExtras.push({ label: `env: ${v.key}`, insert: `pm.environment.get("${v.key}")`, detail: `= ${String(v.value).substring(0, 40)}`, kind: 'env', icon: '🌍' });
      } else {
        envExtras.push({ label: `{{${v.key}}}`, insert: `{{${v.key}}}`, detail: `= ${String(v.value).substring(0, 40)}`, kind: 'env', icon: '🌍' });
      }
    });
  }

  const all = [...base, ...envExtras];
  if (!word || word.length < 1) return [];

  return all
    .map(item => ({ ...item, _score: acFuzzyMatch(word, item.label) }))
    .filter(i => i._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 9);
}

// ── Context-aware suggestions for KV inputs ───────────────────────────────────
function acGetEnvVarItems() {
  const extras = [];
  if (state.activeEnvId) {
    const env = state.environments.find(e => e.id === state.activeEnvId);
    (env?.variables || []).forEach(v => {
      extras.push({ label: `{{${v.key}}}`, insert: `{{${v.key}}}`, detail: `= ${String(v.value).substring(0, 40)}`, kind: 'env', icon: '🌍' });
    });
  }
  return extras;
}

function acGetHeaderKeySuggestions(word) {
  const envExtras = acGetEnvVarItems();
  return [...AC_COMPLETIONS_HEADER_KEYS, ...envExtras]
    .map(item => ({ ...item, _score: acFuzzyMatch(word, item.label) }))
    .filter(i => i._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 9);
}

function acGetValueSuggestions(word, siblingKey) {
  const keyLower = (siblingKey || '').toLowerCase().trim();
  const contextHints = AC_HEADER_VALUE_HINTS[keyLower] || [];
  const pool = [...contextHints, ...AC_COMPLETIONS_DYNVAR, ...acGetEnvVarItems()];
  if (!word || word.length < 1) return contextHints.slice(0, 9);
  return pool
    .map(item => ({ ...item, _score: acFuzzyMatch(word, item.label) }))
    .filter(i => i._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 9);
}

// Central delegated input handler for all non-script fields
function acHandleValueInput(el) {
  const pos    = el.selectionStart;
  const before = el.value.substring(0, pos);
  const row    = el.closest('.kv-row');
  const inHeaders = !!el.closest('#tab-headers');

  // ── Header KEY field ────────────────────────────────────────────────────
  if (row && inHeaders) {
    const inputs = row.querySelectorAll('.kv-input');
    if (el === inputs[0]) {
      // Key column: trigger on any word characters
      const m = before.match(/[\w-]+$/);
      const word = m ? m[0] : '';
      if (!word) { acHide(); return; }
      const items = acGetHeaderKeySuggestions(word);
      acShow(el, items, { word, start: pos - word.length, end: pos });
      return;
    }
    if (el === inputs[1]) {
      // Value column: show context hints based on sibling key
      const sibKey = inputs[0]?.value || '';
      const sibLower = sibKey.toLowerCase();
      const contextHints = AC_HEADER_VALUE_HINTS[sibLower] || [];
      // Show immediately if key has known hints and value is short
      if (contextHints.length && before.trim().length <= 3 && !before.includes('{{')) {
        acShow(el, contextHints.slice(0, 9), { word: before, start: pos - before.length, end: pos });
        return;
      }
      // Otherwise fall through to {{ trigger below
      const m = before.match(/\{\{[\w$]*$/);
      if (m) {
        const items = acGetValueSuggestions(m[0], sibKey);
        if (items.length) { acShow(el, items, { word: m[0], start: pos - m[0].length, end: pos }); return; }
      }
      acHide();
      return;
    }
  }

  // ── All other value inputs: trigger on {{ ──────────────────────────────
  const m = before.match(/\{\{[\w$]*$/);
  if (!m) { if (acState.visible && acState.textarea === el) acHide(); return; }
  const word  = m[0];
  const start = pos - word.length;
  let sibKey = '';
  if (row) {
    const inputs = row.querySelectorAll('.kv-input');
    if (el === inputs[1]) sibKey = inputs[0]?.value || '';
  }
  const items = acGetValueSuggestions(word, sibKey);
  acShow(el, items, { word, start, end: pos });
}

function acPosition(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const lineH = parseFloat(style.lineHeight) || 20;
  const padT  = parseFloat(style.paddingTop) || 10;
  const padL  = parseFloat(style.paddingLeft) || 12;

  const before = el.value.substring(0, el.selectionStart);
  const lineNum = (before.match(/\n/g) || []).length;
  const scrollTop = el.scrollTop || 0;

  let top  = rect.top  + padT + lineNum * lineH - scrollTop + lineH + 4;
  const left = rect.left + padL;

  // Flip upward if too low
  const dropH = Math.min(acState.items.length, 9) * 50 + 8;
  if (top + dropH > window.innerHeight - 16) {
    top = rect.top + padT + lineNum * lineH - scrollTop - dropH - 4;
  }

  return { top: Math.max(8, top), left };
}

function acRender() {
  const dd = document.getElementById('ac-dropdown');
  if (!dd) return;

  dd.innerHTML = acState.items.map((item, idx) => {
    const sel = idx === acState.selectedIdx;
    const kindCls = { fn: 'ac-fn', prop: 'ac-prop', var: 'ac-var', env: 'ac-env' }[item.kind] || 'ac-fn';
    return `<div class="ac-item${sel ? ' ac-sel' : ''}" data-i="${idx}">
      <span class="ac-ico">${item.icon}</span>
      <div class="ac-body">
        <span class="ac-lbl">${escHtml(item.label)}</span>
        <span class="ac-desc">${escHtml(item.detail)}</span>
      </div>
      <span class="ac-tag ${kindCls}">${item.kind}</span>
    </div>`;
  }).join('');

  dd.querySelectorAll('.ac-item').forEach(div => {
    div.addEventListener('mousedown', e => {
      e.preventDefault();
      acState.selectedIdx = parseInt(div.dataset.i);
      acAccept();
    });
  });
}

function acShow(el, items, wordInfo) {
  if (!items.length) { acHide(); return; }
  acState.visible     = true;
  acState.items       = items;
  acState.selectedIdx = 0;
  acState.textarea    = el;
  acState.wordStart   = wordInfo.start;
  acState.wordEnd     = wordInfo.end;

  const dd = document.getElementById('ac-dropdown');
  if (!dd) return;
  const { top, left } = acPosition(el);
  dd.style.top     = `${top}px`;
  dd.style.left    = `${left}px`;
  dd.style.display = 'block';
  acRender();
}

function acHide() {
  const dd = document.getElementById('ac-dropdown');
  if (dd) dd.style.display = 'none';
  acState.visible = false;
  acState.items   = [];
}

function acMove(dir) {
  if (!acState.visible) return;
  acState.selectedIdx = (acState.selectedIdx + dir + acState.items.length) % acState.items.length;
  acRender();
  document.getElementById('ac-dropdown')?.querySelector('.ac-sel')?.scrollIntoView({ block: 'nearest' });
}

function acAccept() {
  if (!acState.visible || !acState.textarea) return;
  const item = acState.items[acState.selectedIdx];
  if (!item) return;

  const el = acState.textarea;
  const before = el.value.substring(0, acState.wordStart);
  const after  = el.value.substring(acState.wordEnd);
  el.value = before + item.insert + after;
  const cur = acState.wordStart + item.insert.length;
  el.selectionStart = el.selectionEnd = cur;
  el.focus();
  acHide();
}

function setupEditorAutocomplete(el) {
  el.addEventListener('input', () => {
    const wi = acGetWord(el);
    acState.wordEnd = wi.end;
    acShow(el, acGetSuggestions(el, wi.word), wi);
  });

  el.addEventListener('keydown', e => {
    if (!acState.visible) return;
    if (e.key === 'ArrowDown')        { e.preventDefault(); acMove(1); }
    else if (e.key === 'ArrowUp')     { e.preventDefault(); acMove(-1); }
    else if (e.key === 'Tab')         { e.preventDefault(); acAccept(); }
    else if (e.key === 'Enter' && acState.visible) { e.preventDefault(); acAccept(); }
    else if (e.key === 'Escape')      { e.preventDefault(); acHide(); }
  });

  el.addEventListener('blur', () => setTimeout(acHide, 160));
  el.addEventListener('scroll', acHide);
}

function setupDynVarAutocomplete(el) {
  el.addEventListener('input', () => {
    const pos  = el.selectionStart;
    const text = el.value.substring(0, pos);
    // Only trigger when typing a {{... pattern
    const m = text.match(/\{\{[\w$]*$/);
    if (!m) { acHide(); return; }
    const word  = m[0];
    const start = pos - word.length;
    const items = acGetSuggestions(el, word);
    acShow(el, items, { word, start, end: pos });
  });

  el.addEventListener('keydown', e => {
    if (!acState.visible) return;
    if (e.key === 'ArrowDown')   { e.preventDefault(); acMove(1); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); acMove(-1); }
    else if (e.key === 'Tab')    { e.preventDefault(); acAccept(); }
    else if (e.key === 'Enter' && acState.visible) { e.preventDefault(); acAccept(); }
    else if (e.key === 'Escape') { e.preventDefault(); acHide(); }
  });

  el.addEventListener('blur', () => setTimeout(acHide, 160));
}


// ===== Resizable Sidebar =====
(function() {
  const SIDEBAR_W_KEY = 'api_client_sidebar_w';
  const MIN_W  = 160;
  const MAX_W  = 520;
  const DEF_W  = 260;

  const sidebar = document.getElementById('sidebar');
  const handle  = document.getElementById('sidebar-resize-handle');

  // Restore saved width
  const saved = parseInt(localStorage.getItem(SIDEBAR_W_KEY));
  const initW = (saved >= MIN_W && saved <= MAX_W) ? saved : DEF_W;
  sidebar.style.width    = initW + 'px';
  sidebar.style.minWidth = initW + 'px';

  let dragging = false;
  let startX   = 0;
  let startW   = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.classList.add('sidebar-dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW  = Math.min(MAX_W, Math.max(MIN_W, startW + delta));
    sidebar.style.width    = newW + 'px';
    sidebar.style.minWidth = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('sidebar-dragging');
    localStorage.setItem(SIDEBAR_W_KEY, sidebar.offsetWidth);
  });

  // Double-click → reset to default width
  handle.addEventListener('dblclick', () => {
    sidebar.style.width    = DEF_W + 'px';
    sidebar.style.minWidth = DEF_W + 'px';
    localStorage.setItem(SIDEBAR_W_KEY, DEF_W);
  });
})();

// ===== Split Panel Resizer (Horizontal/Vertical) =====
(function() {
  const SPLIT_W_KEY = 'api-client-split-w';
  const SPLIT_H_KEY = 'api-client-split-h';
  const LAYOUT_KEY  = 'api-client-layout';
  const MIN_W  = 300;
  const MAX_W_RATIO = 0.80; // max 80% of split panel width
  const DEF_W_RATIO = 0.5;
  const MIN_H  = 150;
  const MAX_H  = 500;
  const DEF_H  = 280;

  const splitPanel      = document.getElementById('split-panel');
  const requestSection  = splitPanel?.querySelector('.request-section');
  const handle          = document.getElementById('split-resize-handle');
  const layoutBtn       = document.getElementById('btn-layout-toggle');
  const layoutIcon      = document.getElementById('layout-icon');
  const layoutLabel     = document.getElementById('layout-label');

  if (!handle || !requestSection || !splitPanel) return;

  // Check if vertical mode
  function isVertical() {
    return splitPanel.classList.contains('layout-vertical');
  }

  // Apply layout from localStorage
  const savedLayout = localStorage.getItem(LAYOUT_KEY);
  if (savedLayout === 'vertical') {
    splitPanel.classList.add('layout-vertical');
    if (layoutIcon) layoutIcon.textContent = '⬍';
    if (layoutLabel) layoutLabel.textContent = 'Vertical';
    // Restore height
    const savedH = parseInt(localStorage.getItem(SPLIT_H_KEY));
    if (savedH && savedH >= MIN_H && savedH <= MAX_H) {
      requestSection.style.height = savedH + 'px';
    }
  } else {
    // Restore width for horizontal
    const savedW = parseInt(localStorage.getItem(SPLIT_W_KEY));
    const panelW = splitPanel.offsetWidth;
    if (savedW && savedW >= MIN_W && savedW <= panelW * MAX_W_RATIO) {
      requestSection.style.width = savedW + 'px';
      requestSection.style.flex = 'none';
    }
  }

  // Layout toggle
  layoutBtn?.addEventListener('click', () => {
    const goingVertical = !isVertical();
    
    if (goingVertical) {
      splitPanel.classList.add('layout-vertical');
      localStorage.setItem(LAYOUT_KEY, 'vertical');
      layoutIcon.textContent = '⬍';
      layoutLabel.textContent = 'Vertical';
      // Reset width, apply height
      requestSection.style.width = '';
      requestSection.style.flex = '';
      const savedH = parseInt(localStorage.getItem(SPLIT_H_KEY));
      requestSection.style.height = (savedH && savedH >= MIN_H && savedH <= MAX_H ? savedH : DEF_H) + 'px';
    } else {
      splitPanel.classList.remove('layout-vertical');
      localStorage.setItem(LAYOUT_KEY, 'horizontal');
      layoutIcon.textContent = '⬌';
      layoutLabel.textContent = 'Horizontal';
      // Reset height, apply width
      requestSection.style.height = '';
      const savedW = parseInt(localStorage.getItem(SPLIT_W_KEY));
      const panelW = splitPanel.offsetWidth;
      const defW = panelW * DEF_W_RATIO;
      requestSection.style.width = (savedW && savedW >= MIN_W ? savedW : defW) + 'px';
      requestSection.style.flex = 'none';
    }
    showToast(goingVertical ? 'Layout: Vertical (top/bottom)' : 'Layout: Horizontal (left/right)');
  });

  let dragging = false;
  let startX   = 0;
  let startY   = 0;
  let startW   = 0;
  let startH   = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('split-dragging');
    
    if (isVertical()) {
      startY = e.clientY;
      startH = requestSection.offsetHeight;
      document.body.classList.add('vertical-drag');
    } else {
      startX = e.clientX;
      startW = requestSection.offsetWidth;
    }
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    
    if (isVertical()) {
      const delta = e.clientY - startY;
      const newH = Math.min(MAX_H, Math.max(MIN_H, startH + delta));
      requestSection.style.height = newH + 'px';
    } else {
      const delta = e.clientX - startX;
      const maxW = splitPanel.offsetWidth * MAX_W_RATIO;
      const newW = Math.min(maxW, Math.max(MIN_W, startW + delta));
      requestSection.style.width = newW + 'px';
      requestSection.style.flex = 'none';
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('split-dragging');
    document.body.classList.remove('vertical-drag');
    
    if (isVertical()) {
      localStorage.setItem(SPLIT_H_KEY, requestSection.offsetHeight);
    } else {
      localStorage.setItem(SPLIT_W_KEY, requestSection.offsetWidth);
    }
  });

  // Double-click → reset to default
  handle.addEventListener('dblclick', () => {
    if (isVertical()) {
      requestSection.style.height = DEF_H + 'px';
      localStorage.setItem(SPLIT_H_KEY, DEF_H);
    } else {
      const defW = splitPanel.offsetWidth * DEF_W_RATIO;
      requestSection.style.width = defW + 'px';
      requestSection.style.flex = 'none';
      localStorage.setItem(SPLIT_W_KEY, defW);
    }
  });
})();

// ===== Helper Functions for Body/Script Values =====
window.getBodyEditorValue = function() {
  return document.getElementById('body-input')?.value || '';
};

window.setBodyEditorValue = function(value) {
  const bodyInput = document.getElementById('body-input');
  if (bodyInput) bodyInput.value = value || '';
  state.currentRequest.body = value || '';
  // Update syntax highlighting
  if (typeof updateBodyHighlight === 'function') {
    setTimeout(updateBodyHighlight, 0);
  }
};

window.getScriptEditorValue = function(type) {
  return document.getElementById(`${type}-input`)?.value || '';
};

window.setScriptEditorValue = function(type, value) {
  const input = document.getElementById(`${type}-input`);
  if (input) input.value = value || '';
  if (type === 'prescript') {
    state.currentRequest.preScript = value || '';
    // Update highlighting
    if (window.updatePrescriptHighlight) window.updatePrescriptHighlight();
    if (window.updatePrescriptLineNumbers) window.updatePrescriptLineNumbers();
  } else {
    state.currentRequest.postScript = value || '';
    // Update highlighting
    if (window.updatePostscriptHighlight) window.updatePostscriptHighlight();
    if (window.updatePostscriptLineNumbers) window.updatePostscriptLineNumbers();
  }
};

// Update body meta (line count, JSON validity)
function updateBodyMeta() {
  const value = document.getElementById('body-input')?.value || '';
  const lineCount = document.getElementById('body-line-count');
  const jsonStatus = document.getElementById('body-json-status');
  
  if (lineCount) {
    const lines = value ? value.split('\n').length : 0;
    lineCount.textContent = `${lines} line${lines !== 1 ? 's' : ''}`;
  }
  
  if (jsonStatus && state.currentRequest.bodyType === 'json') {
    if (!value.trim()) {
      jsonStatus.textContent = '';
      jsonStatus.className = 'body-json-status';
    } else {
      try {
        JSON.parse(stripComments(value));
        jsonStatus.textContent = '✓ Valid JSON';
        jsonStatus.className = 'body-json-status valid';
      } catch (e) {
        jsonStatus.textContent = '✗ Invalid JSON';
        jsonStatus.className = 'body-json-status invalid';
      }
    }
  }
}

// ===== Context Menu for Encode/Decode =====
// This IIFE runs after DOM is ready but before init()
(function setupContextMenu() {
  const contextMenu = document.getElementById('context-menu');
  if (!contextMenu) return;
  
  let activeInput = null;
  let selectionStart = 0;
  let selectionEnd = 0;
  
  function showContextMenu(x, y) {
    contextMenu.style.display = 'block';
    
    const menuRect = contextMenu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    
    if (x + menuRect.width > viewportW) {
      x = viewportW - menuRect.width - 10;
    }
    if (y + menuRect.height > viewportH) {
      y = viewportH - menuRect.height - 10;
    }
    
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
  }
  
  function hideContextMenu() {
    contextMenu.style.display = 'none';
    activeInput = null;
  }
  
  // Only intercept contextmenu when there's selected text in a text input
  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    
    // Check if target is a text input or textarea
    const isTextInput = target.tagName === 'TEXTAREA' || 
      (target.tagName === 'INPUT' && (target.type === 'text' || !target.type));
    
    if (!isTextInput) return; // Let default context menu show
    
    // Check if there's selected text
    if (target.selectionStart === target.selectionEnd) return; // No selection, let default show
    
    // There's selected text - show custom menu
    e.preventDefault();
    activeInput = target;
    selectionStart = target.selectionStart;
    selectionEnd = target.selectionEnd;
    showContextMenu(e.clientX, e.clientY);
  });
  
  // Hide menu on any click outside
  document.addEventListener('mousedown', (e) => {
    if (contextMenu.style.display === 'block' && !contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });
  
  // Hide on Escape - only if menu is visible
  document.addEventListener('keydown', (e) => {
    if (contextMenu.style.display === 'block' && e.key === 'Escape') {
      hideContextMenu();
      e.preventDefault();
    }
  });
  
  // Handle menu item clicks - use event delegation on contextMenu
  contextMenu.onmousedown = function(e) {
    e.stopPropagation();
  };
  
  contextMenu.onclick = function(e) {
    const item = e.target.closest('.context-menu-item');
    if (!item || !activeInput) return;
    
    e.stopPropagation();
    
    const action = item.dataset.action;
    const selectedText = activeInput.value.substring(selectionStart, selectionEnd);
    let result = selectedText;
    
    // Store refs before hiding
    const inputRef = activeInput;
    const startRef = selectionStart;
    const endRef = selectionEnd;
    
    try {
      switch (action) {
        case 'encode-base64':
          result = btoa(unescape(encodeURIComponent(selectedText)));
          break;
        case 'decode-base64':
          result = decodeURIComponent(escape(atob(selectedText)));
          break;
        case 'encode-url':
          result = encodeURIComponent(selectedText);
          break;
        case 'decode-url':
          result = decodeURIComponent(selectedText);
          break;
        case 'encode-html':
          result = selectedText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
          break;
        case 'decode-html':
          const textarea = document.createElement('textarea');
          textarea.innerHTML = selectedText;
          result = textarea.value;
          break;
        case 'encode-json':
          result = JSON.stringify(selectedText);
          break;
        case 'decode-json':
          result = JSON.parse(selectedText);
          if (typeof result !== 'string') {
            result = JSON.stringify(result, null, 2);
          }
          break;
        case 'format-json':
          result = JSON.stringify(JSON.parse(selectedText), null, 2);
          break;
        case 'minify-json':
          result = JSON.stringify(JSON.parse(selectedText));
          break;
        case 'hash-md5':
          if (typeof CryptoJS !== 'undefined') {
            result = CryptoJS.MD5(selectedText).toString();
          } else {
            throw new Error('CryptoJS not loaded');
          }
          break;
        case 'hash-sha1':
          if (typeof CryptoJS !== 'undefined') {
            result = CryptoJS.SHA1(selectedText).toString();
          } else {
            throw new Error('CryptoJS not loaded');
          }
          break;
        case 'hash-sha256':
          if (typeof CryptoJS !== 'undefined') {
            result = CryptoJS.SHA256(selectedText).toString();
          } else {
            throw new Error('CryptoJS not loaded');
          }
          break;
        case 'hash-sha512':
          if (typeof CryptoJS !== 'undefined') {
            result = CryptoJS.SHA512(selectedText).toString();
          } else {
            throw new Error('CryptoJS not loaded');
          }
          break;
      }
      
      // Hide menu immediately
      hideContextMenu();
      activeInput = null;
      
      // Replace text directly (simpler approach, works better with browser undo)
      const beforeText = inputRef.value.substring(0, startRef);
      const afterText = inputRef.value.substring(endRef);
      inputRef.value = beforeText + result + afterText;
      
      // Focus and set cursor position
      inputRef.focus();
      inputRef.setSelectionRange(startRef, startRef + result.length);
      
      // Trigger input event
      inputRef.dispatchEvent(new Event('input', { bubbles: true }));
      
      toast('Text transformed successfully', 'success');
    } catch (err) {
      hideContextMenu();
      activeInput = null;
      toast('Transform failed: ' + err.message, 'error');
    }
  };
})();

// ===== Start =====
init();
